using System;
using System.Collections.Generic;
using System.Data;
using Microsoft.Data.SqlClient;
using System.Threading.Tasks;
using Microsoft.Extensions.Configuration;
using Dapper;
using DbMigrator.Core;

namespace DbMigrator.Web.Services
{
    public class WhiteboardService
    {
        private readonly IConfiguration _config;

        public WhiteboardService(IConfiguration config)
        {
            _config = config;
        }

        private string ConfigConnectionString => _config.GetConnectionString("ConfigDb");

        public async Task<IEnumerable<JobWhiteboard>> GetWhiteboardsAsync()
        {
            using var conn = new SqlConnection(ConfigConnectionString);
            return await conn.QueryAsync<JobWhiteboard>(
                "SELECT Id, AliasName, TagName, ThumbnailData, CreatedAt, UpdatedAt FROM dbo.JobWhiteboards ORDER BY UpdatedAt DESC");
        }

        public async Task<JobWhiteboard> GetWhiteboardByIdAsync(int id)
        {
            using var conn = new SqlConnection(ConfigConnectionString);
            return await conn.QuerySingleOrDefaultAsync<JobWhiteboard>(
                "SELECT * FROM dbo.JobWhiteboards WHERE Id = @Id", new { Id = id });
        }

        public async Task<int> CreateWhiteboardAsync(JobWhiteboard request)
        {
            if (request == null || string.IsNullOrWhiteSpace(request.AliasName))
            {
                throw new ArgumentException("Nama sketsa tidak boleh kosong.");
            }

            using var conn = new SqlConnection(ConfigConnectionString);
            
            // Validasi keunikan nama sketsa secara global
            var existing = await conn.QueryFirstOrDefaultAsync<int?>(
                "SELECT TOP 1 Id FROM dbo.JobWhiteboards WHERE AliasName = @AliasName",
                new { AliasName = request.AliasName });
                
            if (existing != null)
            {
                throw new InvalidOperationException("Nama sketsa tersebut sudah terdaftar!");
            }

            return await conn.QuerySingleAsync<int>(@"
                INSERT INTO dbo.JobWhiteboards (AliasName, TagName, CreatedAt, UpdatedAt)
                VALUES (@AliasName, @TagName, GETDATE(), GETDATE());
                SELECT CAST(SCOPE_IDENTITY() as int);", request);
        }

        public async Task<bool> SaveWhiteboardAsync(int id, JobWhiteboard request)
        {
            if (request == null)
            {
                throw new ArgumentNullException(nameof(request), "Payload kosong");
            }

            using var conn = new SqlConnection(ConfigConnectionString);
            var rows = await conn.ExecuteAsync(@"
                UPDATE dbo.JobWhiteboards
                SET WhiteboardData = @WhiteboardData, ThumbnailData = @ThumbnailData, UpdatedAt = GETDATE()
                WHERE Id = @Id", 
                new { Id = id, WhiteboardData = request.WhiteboardData, ThumbnailData = request.ThumbnailData });

            return rows > 0;
        }

        public async Task<bool> DeleteWhiteboardAsync(int id)
        {
            using var conn = new SqlConnection(ConfigConnectionString);
            var rows = await conn.ExecuteAsync("DELETE FROM dbo.JobWhiteboards WHERE Id = @Id", new { Id = id });
            return rows > 0;
        }
    }
}
