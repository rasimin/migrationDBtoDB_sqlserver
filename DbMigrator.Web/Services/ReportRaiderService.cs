using System;
using System.Collections.Generic;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using Dapper;
using Microsoft.Data.SqlClient;
using DbMigrator.Web.Models;

namespace DbMigrator.Web.Services
{
    public class ReportRaiderService
    {
        public async Task<int> TestConnectionAsync(string connectionString)
        {
            using var conn = CreateConnection(connectionString);
            await conn.OpenAsync();
            return await conn.ExecuteScalarAsync<int>("SELECT COUNT(1) FROM dbo.Catalog");
        }

        public async Task<ReportRaiderCatalogItem> GetRootAsync(string connectionString)
        {
            using var conn = CreateConnection(connectionString);
            await conn.OpenAsync();

            var root = await conn.QueryFirstOrDefaultAsync<ReportRaiderCatalogItem>(@"
                SELECT TOP 1 ItemID, Path, Name, ParentID, Type, DATALENGTH(Content) AS DataLength
                FROM dbo.Catalog
                WHERE Type = 1 AND ParentID IS NULL
                ORDER BY Path");

            if (root != null) return root;

            root = await conn.QueryFirstOrDefaultAsync<ReportRaiderCatalogItem>(@"
                SELECT TOP 1 ItemID, Path, Name, ParentID, Type, DATALENGTH(Content) AS DataLength
                FROM dbo.Catalog
                WHERE Type = 1
                ORDER BY LEN(Path), Path");

            return root ?? throw new InvalidOperationException("Root folder SSRS tidak ditemukan di dbo.Catalog.");
        }

        public async Task<IEnumerable<ReportRaiderCatalogItem>> GetChildrenAsync(string connectionString, Guid parentId)
        {
            using var conn = CreateConnection(connectionString);
            await conn.OpenAsync();

            return await conn.QueryAsync<ReportRaiderCatalogItem>(@"
                SELECT ItemID, Path, Name, ParentID, Type, DATALENGTH(Content) AS DataLength
                FROM dbo.Catalog
                WHERE ParentID = @ParentId
                ORDER BY CASE WHEN Type = 1 THEN 0 ELSE 1 END, Name", new { ParentId = parentId });
        }

        public async Task<ReportRaiderDownloadFile> DownloadAsync(string connectionString, Guid itemId)
        {
            using var conn = CreateConnection(connectionString);
            await conn.OpenAsync();

            var item = await conn.QueryFirstOrDefaultAsync<ReportRaiderCatalogItem>(@"
                SELECT ItemID, Path, Name, ParentID, Type, DATALENGTH(Content) AS DataLength
                FROM dbo.Catalog
                WHERE ItemID = @ItemId", new { ItemId = itemId });

            if (item == null) throw new InvalidOperationException("Item SSRS tidak ditemukan.");
            if (item.Type == 1) throw new InvalidOperationException("Folder tidak bisa diunduh sebagai file tunggal.");

            var content = await conn.QueryFirstOrDefaultAsync<byte[]>(
                "SELECT Content FROM dbo.Catalog WHERE ItemID = @ItemId", new { ItemId = itemId });

            if (content == null || content.Length == 0)
            {
                throw new InvalidOperationException("Item tidak memiliki content.");
            }

            return new ReportRaiderDownloadFile
            {
                FileName = SafeFileName(item.Name, item.Extension),
                ContentType = "application/xml",
                Content = content
            };
        }

        public async Task<ReportRaiderDownloadFile> DownloadZipAsync(string connectionString, List<Guid> itemIds)
        {
            if (itemIds == null || itemIds.Count == 0)
            {
                throw new ArgumentException("Tidak ada item yang dipilih.");
            }

            using var conn = CreateConnection(connectionString);
            await conn.OpenAsync();

            using var ms = new MemoryStream();
            using (var archive = new ZipArchive(ms, ZipArchiveMode.Create, leaveOpen: true))
            {
                foreach (var itemId in itemIds.Distinct())
                {
                    await AddItemToZipAsync(conn, itemId, "", archive);
                }
            }

            return new ReportRaiderDownloadFile
            {
                FileName = $"ReportRaider_Export_{DateTime.Now:yyyyMMdd_HHmmss}.zip",
                ContentType = "application/zip",
                Content = ms.ToArray()
            };
        }

        private static SqlConnection CreateConnection(string connectionString)
        {
            if (string.IsNullOrWhiteSpace(connectionString))
            {
                throw new ArgumentException("Connection string ReportServer tidak boleh kosong.");
            }

            var builder = new SqlConnectionStringBuilder(connectionString)
            {
                TrustServerCertificate = true
            };

            if (builder.ConnectTimeout <= 0)
            {
                builder.ConnectTimeout = 15;
            }

            return new SqlConnection(builder.ConnectionString);
        }

        private static async Task AddItemToZipAsync(SqlConnection conn, Guid itemId, string currentPath, ZipArchive archive)
        {
            var item = await conn.QueryFirstOrDefaultAsync<ReportRaiderCatalogItem>(@"
                SELECT ItemID, Path, Name, ParentID, Type, DATALENGTH(Content) AS DataLength
                FROM dbo.Catalog
                WHERE ItemID = @ItemId", new { ItemId = itemId });

            if (item == null) return;

            if (item.Type == 1)
            {
                var folderPath = CombineZipPath(currentPath, SafeZipSegment(string.IsNullOrWhiteSpace(item.Name) ? "Root" : item.Name));
                var children = await conn.QueryAsync<Guid>(
                    "SELECT ItemID FROM dbo.Catalog WHERE ParentID = @ParentId ORDER BY Name", new { ParentId = item.ItemID });

                foreach (var childId in children)
                {
                    await AddItemToZipAsync(conn, childId, folderPath, archive);
                }
                return;
            }

            var content = await conn.QueryFirstOrDefaultAsync<byte[]>(
                "SELECT Content FROM dbo.Catalog WHERE ItemID = @ItemId", new { ItemId = item.ItemID });

            if (content == null || content.Length == 0) return;

            var entryName = CombineZipPath(currentPath, SafeFileName(item.Name, item.Extension));
            var entry = archive.CreateEntry(entryName, CompressionLevel.Fastest);
            using var stream = entry.Open();
            await stream.WriteAsync(content, 0, content.Length);
        }

        private static string CombineZipPath(string left, string right)
        {
            return string.IsNullOrWhiteSpace(left) ? right : $"{left}/{right}";
        }

        private static string SafeZipSegment(string value)
        {
            var clean = Regex.Replace(value ?? "item", @"[\\/:*?""<>|]+", "_").Trim();
            return string.IsNullOrWhiteSpace(clean) ? "item" : clean;
        }

        private static string SafeFileName(string name, string extension)
        {
            var clean = SafeZipSegment(name);
            if (!clean.EndsWith(extension, StringComparison.OrdinalIgnoreCase))
            {
                clean += extension;
            }
            return clean;
        }
    }
}
