using System;
using System.Collections.Generic;
using System.Data;
using Microsoft.Data.SqlClient;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Threading.Tasks;
using System.Xml.Linq;
using Microsoft.Extensions.Configuration;
using Dapper;
using DbMigrator.Web.Models;

namespace DbMigrator.Web.Services
{
    public class SsrsService
    {
        private readonly IConfiguration _config;

        public SsrsService(IConfiguration config)
        {
            _config = config;
        }

        private string ConfigConnectionString => _config.GetConnectionString("ConfigDb");

        public async Task<IEnumerable<SavedSsrsConnection>> GetSavedSsrsConnectionsAsync()
        {
            using var conn = new SqlConnection(ConfigConnectionString);
            return await conn.QueryAsync<SavedSsrsConnection>(
                "SELECT Id, ConnectionName, Url, Username, Password, Domain, CreatedAt FROM dbo.SavedSsrsConnections ORDER BY ConnectionName ASC");
        }

        public async Task<int> SaveSavedSsrsConnectionAsync(SavedSsrsConnection request)
        {
            using var conn = new SqlConnection(ConfigConnectionString);
            var existing = await conn.QueryFirstOrDefaultAsync<int?>(
                "SELECT Id FROM dbo.SavedSsrsConnections WHERE ConnectionName = @ConnectionName", new { request.ConnectionName });

            if (existing.HasValue)
            {
                await conn.ExecuteAsync(@"
                    UPDATE dbo.SavedSsrsConnections 
                    SET Url = @Url, 
                        Username = @Username, 
                        Password = @Password,
                        Domain = @Domain 
                    WHERE Id = @Id", 
                    new { 
                        Id = existing.Value,
                        request.Url, 
                        request.Username, 
                        request.Password, 
                        request.Domain
                    });
                return existing.Value;
            }
            else
            {
                return await conn.QuerySingleAsync<int>(@"
                    INSERT INTO dbo.SavedSsrsConnections (ConnectionName, Url, Username, Password, Domain, CreatedAt)
                    VALUES (@ConnectionName, @Url, @Username, @Password, @Domain, GETDATE());
                    SELECT CAST(SCOPE_IDENTITY() as int);", 
                    request);
            }
        }

        public async Task<bool> DeleteSavedSsrsConnectionAsync(int id)
        {
            using var conn = new SqlConnection(ConfigConnectionString);
            var deleted = await conn.ExecuteAsync("DELETE FROM dbo.SavedSsrsConnections WHERE Id = @id", new { id });
            return deleted > 0;
        }

        public async Task<bool> ConnectAsync(SsrsBrowseRequestDto req)
        {
            var xml = await SendSsrsSoapRequestAsync(req.Url, req.Username, req.Password, req.Domain, "ListChildren", $@"
                <ListChildren xmlns=""http://schemas.microsoft.com/sqlserver/reporting/2010/03/01/ReportServer"">
                  <ItemPath>/</ItemPath>
                  <Recursive>false</Recursive>
                </ListChildren>
            ");
            return true;
        }

        public async Task<List<CatalogItemDto>> BrowseAsync(SsrsBrowseRequestDto req)
        {
            var xml = await SendSsrsSoapRequestAsync(req.Url, req.Username, req.Password, req.Domain, "ListChildren", $@"
                <ListChildren xmlns=""http://schemas.microsoft.com/sqlserver/reporting/2010/03/01/ReportServer"">
                  <ItemPath>{System.Security.SecurityElement.Escape(req.Path)}</ItemPath>
                  <Recursive>false</Recursive>
                </ListChildren>
            ");

            var doc = XDocument.Parse(xml);
            XNamespace ns = "http://schemas.microsoft.com/sqlserver/reporting/2010/03/01/ReportServer";
            return doc.Descendants(ns + "CatalogItem")
                .Select(el => new CatalogItemDto
                {
                    Name = el.Element(ns + "Name")?.Value ?? "",
                    Path = el.Element(ns + "Path")?.Value ?? "",
                    TypeName = el.Element(ns + "TypeName")?.Value ?? ""
                })
                .OrderBy(i => i.TypeName != "Folder") // Folders first
                .ThenBy(i => i.Name)
                .ToList();
        }

        public async Task<(byte[] Bytes, string Filename, string Extension)> DownloadAsync(SsrsDownloadRequestDto req)
        {
            var xml = await SendSsrsSoapRequestAsync(req.Url, req.Username, req.Password, req.Domain, "GetItemDefinition", $@"
                <GetItemDefinition xmlns=""http://schemas.microsoft.com/sqlserver/reporting/2010/03/01/ReportServer"">
                  <ItemPath>{System.Security.SecurityElement.Escape(req.Path)}</ItemPath>
                </GetItemDefinition>
            ");

            var doc = XDocument.Parse(xml);
            XNamespace ns = "http://schemas.microsoft.com/sqlserver/reporting/2010/03/01/ReportServer";
            var base64Def = doc.Descendants(ns + "Definition").FirstOrDefault()?.Value ?? "";
            if (string.IsNullOrEmpty(base64Def))
            {
                throw new ArgumentException("Definisi laporan tidak ditemukan atau kosong.");
            }

            byte[] bytes = Convert.FromBase64String(base64Def);
            var filename = req.Path.Split('/').LastOrDefault() ?? "report";
            
            string extension = ".rdl";
            if (string.Equals(req.TypeName, "DataSet", StringComparison.OrdinalIgnoreCase)) extension = ".rsd";
            else if (string.Equals(req.TypeName, "DataSource", StringComparison.OrdinalIgnoreCase)) extension = ".rds";

            return (bytes, filename, extension);
        }

        public async Task<byte[]> DownloadFolderAsync(SsrsBrowseRequestDto req)
        {
            var xml = await SendSsrsSoapRequestAsync(req.Url, req.Username, req.Password, req.Domain, "ListChildren", $@"
                <ListChildren xmlns=""http://schemas.microsoft.com/sqlserver/reporting/2010/03/01/ReportServer"">
                  <ItemPath>{System.Security.SecurityElement.Escape(req.Path)}</ItemPath>
                  <Recursive>true</Recursive>
                </ListChildren>
            ");

            var doc = XDocument.Parse(xml);
            XNamespace ns = "http://schemas.microsoft.com/sqlserver/reporting/2010/03/01/ReportServer";
            var allItems = doc.Descendants(ns + "CatalogItem")
                .Select(el => new CatalogItemDto
                {
                    Name = el.Element(ns + "Name")?.Value ?? "",
                    Path = el.Element(ns + "Path")?.Value ?? "",
                    TypeName = el.Element(ns + "TypeName")?.Value ?? ""
                })
                .ToList();

            var downloadableTypes = new HashSet<string>(StringComparer.OrdinalIgnoreCase) { "Report", "DataSet", "DataSource" };
            var filesToDownload = allItems.Where(i => downloadableTypes.Contains(i.TypeName)).ToList();

            if (filesToDownload.Count == 0)
            {
                throw new ArgumentException("Tidak ada item laporan untuk diunduh di folder ini.");
            }

            using var memoryStream = new MemoryStream();
            using (var archive = new ZipArchive(memoryStream, ZipArchiveMode.Create, true))
            {
                foreach (var file in filesToDownload)
                {
                    try
                    {
                        var fileXml = await SendSsrsSoapRequestAsync(req.Url, req.Username, req.Password, req.Domain, "GetItemDefinition", $@"
                            <GetItemDefinition xmlns=""http://schemas.microsoft.com/sqlserver/reporting/2010/03/01/ReportServer"">
                              <ItemPath>{System.Security.SecurityElement.Escape(file.Path)}</ItemPath>
                            </GetItemDefinition>
                        ");

                        var fileDoc = XDocument.Parse(fileXml);
                        var base64Def = fileDoc.Descendants(ns + "Definition").FirstOrDefault()?.Value ?? "";
                        if (string.IsNullOrEmpty(base64Def)) continue;

                        byte[] fileBytes = Convert.FromBase64String(base64Def);

                        string relativePath = file.Path;
                        if (req.Path != "/")
                        {
                            if (relativePath.StartsWith(req.Path, StringComparison.OrdinalIgnoreCase))
                            {
                                relativePath = relativePath.Substring(req.Path.Length);
                            }
                        }
                        relativePath = relativePath.TrimStart('/');

                        string extension = ".rdl";
                        if (string.Equals(file.TypeName, "DataSet", StringComparison.OrdinalIgnoreCase)) extension = ".rsd";
                        else if (string.Equals(file.TypeName, "DataSource", StringComparison.OrdinalIgnoreCase)) extension = ".rds";

                        var zipEntry = archive.CreateEntry(relativePath + extension);
                        using var entryStream = zipEntry.Open();
                        await entryStream.WriteAsync(fileBytes, 0, fileBytes.Length);
                    }
                    catch
                    {
                        // Skip failures
                    }
                }
            }

            return memoryStream.ToArray();
        }

        public async Task CreateFolderAsync(SsrsCreateFolderRequestDto req)
        {
            var parentPath = req.ParentPath;
            var folderName = req.FolderName.Trim();
            
            if (parentPath != "/" && parentPath.EndsWith("/"))
            {
                parentPath = parentPath.TrimEnd('/');
            }

            await SendSsrsSoapRequestAsync(req.Url, req.Username, req.Password, req.Domain, "CreateFolder", $@"
                <CreateFolder xmlns=""http://schemas.microsoft.com/sqlserver/reporting/2010/03/01/ReportServer"">
                  <Folder>{System.Security.SecurityElement.Escape(folderName)}</Folder>
                  <Parent>{System.Security.SecurityElement.Escape(parentPath)}</Parent>
                  <Properties />
                </CreateFolder>
            ");
        }

        public async Task DeleteItemAsync(SsrsDeleteItemRequestDto req)
        {
            await SendSsrsSoapRequestAsync(req.Url, req.Username, req.Password, req.Domain, "DeleteItem", $@"
                <DeleteItem xmlns=""http://schemas.microsoft.com/sqlserver/reporting/2010/03/01/ReportServer"">
                  <ItemPath>{System.Security.SecurityElement.Escape(req.Path)}</ItemPath>
                </DeleteItem>
            ");
        }

        public async Task<dynamic> GetDataSourceAsync(SsrsDownloadRequestDto req)
        {
            var xml = await SendSsrsSoapRequestAsync(req.Url, req.Username, req.Password, req.Domain, "GetDataSourceContents", $@"
                <GetDataSourceContents xmlns=""http://schemas.microsoft.com/sqlserver/reporting/2010/03/01/ReportServer"">
                  <DataSource>{System.Security.SecurityElement.Escape(req.Path)}</DataSource>
                </GetDataSourceContents>
            ");

            var doc = XDocument.Parse(xml);
            XNamespace ns = "http://schemas.microsoft.com/sqlserver/reporting/2010/03/01/ReportServer";
            var def = doc.Descendants(ns + "Definition").FirstOrDefault();
            if (def == null)
            {
                throw new ArgumentException("Definisi Data Source tidak ditemukan.");
            }

            return new
            {
                Extension = def.Element(ns + "Extension")?.Value ?? "SQL",
                ConnectString = def.Element(ns + "ConnectString")?.Value ?? "",
                CredentialRetrieval = def.Element(ns + "CredentialRetrieval")?.Value ?? "Store",
                WindowsCredentials = string.Equals(def.Element(ns + "WindowsCredentials")?.Value, "true", StringComparison.OrdinalIgnoreCase),
                UserName = def.Element(ns + "UserName")?.Value ?? ""
            };
        }

        public async Task SetDataSourceAsync(SsrsSetDataSourceRequestDto req)
        {
            await SendSsrsSoapRequestAsync(req.Url, req.Username, req.Password, req.Domain, "SetDataSourceContents", $@"
                <SetDataSourceContents xmlns=""http://schemas.microsoft.com/sqlserver/reporting/2010/03/01/ReportServer"">
                  <DataSource>{System.Security.SecurityElement.Escape(req.Path)}</DataSource>
                  <Definition>
                    <Extension>{System.Security.SecurityElement.Escape(req.Definition.Extension)}</Extension>
                    <ConnectString>{System.Security.SecurityElement.Escape(req.Definition.ConnectString)}</ConnectString>
                    <CredentialRetrieval>{System.Security.SecurityElement.Escape(req.Definition.CredentialRetrieval)}</CredentialRetrieval>
                    <WindowsCredentials>{(req.Definition.WindowsCredentials ? "true" : "false")}</WindowsCredentials>
                    <UserName>{System.Security.SecurityElement.Escape(req.Definition.UserName ?? "")}</UserName>
                    <Password>{System.Security.SecurityElement.Escape(req.Definition.Password ?? "")}</Password>
                  </Definition>
                </SetDataSourceContents>
            ");
        }

        public async Task<bool> TestDataSourceConnectionAsync(SsrsTestDataSourceConnectionRequestDto req)
        {
            string connStr = req.ConnectString;
            if (string.IsNullOrWhiteSpace(connStr))
            {
                throw new ArgumentException("Connection string kosong.");
            }

            var builder = new SqlConnectionStringBuilder();
            
            try
            {
                var parts = connStr.Split(';');
                foreach (var part in parts)
                {
                    if (string.IsNullOrWhiteSpace(part)) continue;
                    var kv = part.Split('=');
                    if (kv.Length == 2)
                    {
                        var key = kv[0].Trim().ToLowerInvariant();
                        var val = kv[1].Trim();
                        if (key == "data source" || key == "server" || key == "addr" || key == "address")
                        {
                            builder.DataSource = val;
                        }
                        else if (key == "initial catalog" || key == "database" || key == "db")
                        {
                            builder.InitialCatalog = val;
                        }
                    }
                }
            }
            catch
            {
                builder.ConnectionString = connStr;
            }

            if (string.IsNullOrEmpty(builder.DataSource))
            {
                throw new ArgumentException("Server Name (Data Source) tidak terdeteksi dalam Connection String.");
            }

            builder.TrustServerCertificate = true;
            builder.ConnectTimeout = 10;

            if (string.Equals(req.CredentialRetrieval, "Store", StringComparison.OrdinalIgnoreCase))
            {
                if (req.WindowsCredentials)
                {
                    builder.IntegratedSecurity = true;
                }
                else
                {
                    builder.IntegratedSecurity = false;
                    builder.UserID = req.UserName;
                    builder.Password = req.Password;
                }
            }
            else if (string.Equals(req.CredentialRetrieval, "Integrated", StringComparison.OrdinalIgnoreCase))
            {
                builder.IntegratedSecurity = true;
            }
            else
            {
                throw new ArgumentException($"Mode Credentials '{req.CredentialRetrieval}' tidak didukung untuk tes langsung dari aplikasi.");
            }

            using var conn = new SqlConnection(builder.ConnectionString);
            await conn.OpenAsync();
            return true;
        }

        public async Task<UploadResultDto> UploadFileAsync(string url, string username, string password, string domain, string parentPath, string filename, Stream fileStream)
        {
            var ext = Path.GetExtension(filename).ToLowerInvariant();

            if (ext == ".zip")
            {
                var successCount = 0;
                var failedCount = 0;
                var messages = new List<string>();

                using var archive = new ZipArchive(fileStream, ZipArchiveMode.Read);
                
                // Urutkan entri zip berdasarkan dependensi SSRS: 
                // 1. DataSource (.rds), 2. DataSet (.rsd), 3. Report (.rdl), 4. Lainnya
                var sortedEntries = archive.Entries
                    .Where(entry => !entry.FullName.EndsWith("/") && !string.IsNullOrEmpty(entry.Name))
                    .OrderBy(entry => {
                        var entryExt = Path.GetExtension(entry.Name).ToLowerInvariant();
                        if (entryExt == ".rds") return 1;
                        if (entryExt == ".rsd") return 2;
                        if (entryExt == ".rdl") return 3;
                        return 4;
                    })
                    .ToList();
                
                XNamespace ns = "http://schemas.microsoft.com/sqlserver/reporting/2010/03/01/ReportServer";

                foreach (var entry in sortedEntries)
                {
                    try
                    {
                        var (itemName, itemType) = MapFileToSsrsItem(entry.Name);
                        
                        var entryRelativeDir = Path.GetDirectoryName(entry.FullName)?.Replace('\\', '/') ?? "";
                        var targetFolder = parentPath;
                        if (!string.IsNullOrEmpty(entryRelativeDir))
                        {
                            targetFolder = parentPath == "/" 
                                ? "/" + entryRelativeDir 
                                : parentPath.TrimEnd('/') + "/" + entryRelativeDir;
                        }
                        
                        await EnsureSsrsFolderRecursiveAsync(url, username, password, domain, targetFolder);
                        
                        using var entryStream = entry.Open();
                        using var ms = new MemoryStream();
                        await entryStream.CopyToAsync(ms);
                        var bytes = ms.ToArray();

                        if (itemType == "Report" || itemType == "DataSet")
                        {
                            bytes = ModifySsrsXmlReferences(bytes, targetFolder);
                        }

                        var base64Def = Convert.ToBase64String(bytes);
                        
                        await SendSsrsSoapRequestAsync(url, username, password, domain, "CreateCatalogItem", $@"
                            <CreateCatalogItem xmlns=""http://schemas.microsoft.com/sqlserver/reporting/2010/03/01/ReportServer"">
                              <ItemType>{itemType}</ItemType>
                              <Name>{System.Security.SecurityElement.Escape(itemName)}</Name>
                              <Parent>{System.Security.SecurityElement.Escape(targetFolder)}</Parent>
                              <Overwrite>true</Overwrite>
                              <Definition>{base64Def}</Definition>
                              <Properties />
                            </CreateCatalogItem>
                        ");
                        
                        successCount++;
                    }
                    catch (Exception entryEx)
                    {
                        failedCount++;
                        messages.Add($"Gagal mengunggah '{entry.FullName}': {entryEx.Message}");
                    }
                }
                
                return new UploadResultDto
                {
                    Success = true,
                    Message = $"Proses ZIP selesai: {successCount} berkas berhasil diunggah, {failedCount} berkas gagal.",
                    Errors = messages
                };
            }
            else
            {
                var (itemName, itemType) = MapFileToSsrsItem(filename);
                
                using var ms = new MemoryStream();
                await fileStream.CopyToAsync(ms);
                var bytes = ms.ToArray();

                var targetFolder = parentPath;
                if (targetFolder != "/" && targetFolder.EndsWith("/"))
                {
                    targetFolder = targetFolder.TrimEnd('/');
                }

                if (itemType == "Report" || itemType == "DataSet")
                {
                    bytes = ModifySsrsXmlReferences(bytes, targetFolder);
                }

                var base64Def = Convert.ToBase64String(bytes);

                await SendSsrsSoapRequestAsync(url, username, password, domain, "CreateCatalogItem", $@"
                    <CreateCatalogItem xmlns=""http://schemas.microsoft.com/sqlserver/reporting/2010/03/01/ReportServer"">
                      <ItemType>{itemType}</ItemType>
                      <Name>{System.Security.SecurityElement.Escape(itemName)}</Name>
                      <Parent>{System.Security.SecurityElement.Escape(targetFolder)}</Parent>
                      <Overwrite>true</Overwrite>
                      <Definition>{base64Def}</Definition>
                      <Properties />
                    </CreateCatalogItem>
                ");

                return new UploadResultDto
                {
                    Success = true,
                    Message = $"Berkas '{filename}' berhasil diunggah sebagai {itemType}."
                };
            }
        }

        #region Private SOAP Helpers

        private string NormalizeSsrsUrl(string url)
        {
            var normalized = url.Trim();
            if (!normalized.EndsWith("ReportService2010.asmx", StringComparison.OrdinalIgnoreCase))
            {
                if (!normalized.EndsWith("/", StringComparison.OrdinalIgnoreCase))
                {
                    normalized += "/";
                }
                normalized += "ReportService2010.asmx";
            }
            return normalized;
        }

        private async Task<string> SendSsrsSoapRequestAsync(string url, string username, string password, string domain, string soapAction, string soapBodyXml)
        {
            var normalizedUrl = NormalizeSsrsUrl(url);
            var handler = new HttpClientHandler();
            if (!string.IsNullOrEmpty(username))
            {
                handler.Credentials = string.IsNullOrEmpty(domain)
                    ? new NetworkCredential(username, password)
                    : new NetworkCredential(username, password, domain);
            }
            
            using var client = new HttpClient(handler);
            
            var soapEnvelope = $@"<soap:Envelope xmlns:xsi=""http://www.w3.org/2001/XMLSchema-instance"" xmlns:xsd=""http://www.w3.org/2001/XMLSchema"" xmlns:soap=""http://schemas.xmlsoap.org/soap/envelope/"">
  <soap:Body>
    {soapBodyXml}
  </soap:Body>
</soap:Envelope>";

            var content = new StringContent(soapEnvelope, System.Text.Encoding.UTF8, "text/xml");
            content.Headers.Add("SOAPAction", $"\"http://schemas.microsoft.com/sqlserver/reporting/2010/03/01/ReportServer/{soapAction}\"");
            
            var response = await client.PostAsync(normalizedUrl, content);
            if (!response.IsSuccessStatusCode)
            {
                var errContent = await response.Content.ReadAsStringAsync();
                throw new Exception($"SSRS Server returned status {response.StatusCode}: {errContent}");
            }
            
            return await response.Content.ReadAsStringAsync();
        }

        private (string Name, string Type) MapFileToSsrsItem(string filename)
        {
            var ext = Path.GetExtension(filename).ToLowerInvariant();
            var nameWithoutExt = Path.GetFileNameWithoutExtension(filename);
            
            if (ext == ".rdl") return (nameWithoutExt, "Report");
            if (ext == ".rsd") return (nameWithoutExt, "DataSet");
            if (ext == ".rds") return (nameWithoutExt, "DataSource");
            
            return (filename, "Resource");
        }

        private async Task EnsureSsrsFolderRecursiveAsync(string url, string username, string password, string domain, string targetFolderPath)
        {
            if (string.IsNullOrEmpty(targetFolderPath) || targetFolderPath == "/") return;
            
            var segments = targetFolderPath.Split('/', StringSplitOptions.RemoveEmptyEntries);
            var currentPath = "";
            
            for (int i = 0; i < segments.Length; i++)
            {
                var parent = i == 0 ? "/" : currentPath;
                var folderName = segments[i];
                
                try
                {
                    await SendSsrsSoapRequestAsync(url, username, password, domain, "CreateFolder", $@"
                        <CreateFolder xmlns=""http://schemas.microsoft.com/sqlserver/reporting/2010/03/01/ReportServer"">
                          <Folder>{System.Security.SecurityElement.Escape(folderName)}</Folder>
                          <Parent>{System.Security.SecurityElement.Escape(parent)}</Parent>
                          <Properties />
                        </CreateFolder>
                    ");
                }
                catch (Exception ex)
                {
                    if (!ex.Message.Contains("AlreadyExists") && !ex.Message.Contains("already exists"))
                    {
                        throw;
                    }
                }
                
                currentPath = parent == "/" ? "/" + folderName : parent + "/" + folderName;
            }
        }

        private byte[] ModifySsrsXmlReferences(byte[] xmlBytes, string targetFolder)
        {
            try
            {
                var content = System.Text.Encoding.UTF8.GetString(xmlBytes);
                
                var modulePath = targetFolder;
                if (modulePath.EndsWith("/RPT", StringComparison.OrdinalIgnoreCase))
                {
                    modulePath = modulePath.Substring(0, modulePath.Length - 4);
                }
                else if (modulePath.EndsWith("/DST", StringComparison.OrdinalIgnoreCase))
                {
                    modulePath = modulePath.Substring(0, modulePath.Length - 4);
                }
                else if (modulePath.EndsWith("/DS", StringComparison.OrdinalIgnoreCase))
                {
                    modulePath = modulePath.Substring(0, modulePath.Length - 3);
                }
                
                if (string.IsNullOrEmpty(modulePath))
                {
                    modulePath = "/";
                }

                bool modified = false;

                // 1. Ubah references untuk Shared Dataset (<SharedDataSetReference>...</SharedDataSetReference>)
                var newContent = System.Text.RegularExpressions.Regex.Replace(content, @"<SharedDataSetReference>([^<]+)</SharedDataSetReference>", m => {
                    string path = m.Groups[1].Value.Trim();
                    string newPath = UpdateReferencePath(path, modulePath, "DataSet");
                    if (path != newPath)
                    {
                        modified = true;
                    }
                    return $"<SharedDataSetReference>{newPath}</SharedDataSetReference>";
                });

                // 2. Ubah references untuk Shared Data Source (<DataSourceReference>...</DataSourceReference>)
                newContent = System.Text.RegularExpressions.Regex.Replace(newContent, @"<DataSourceReference>([^<]+)</DataSourceReference>", m => {
                    string path = m.Groups[1].Value.Trim();
                    string newPath = UpdateReferencePath(path, modulePath, "DataSource");
                    if (path != newPath)
                    {
                        modified = true;
                    }
                    return $"<DataSourceReference>{newPath}</DataSourceReference>";
                });

                if (modified)
                {
                    return System.Text.Encoding.UTF8.GetBytes(newContent);
                }
            }
            catch
            {
                // Jika gagal parsing, kembalikan bytes asli
            }
            return xmlBytes;
        }

        private string UpdateReferencePath(string originalPath, string newModulePath, string referenceType)
        {
            if (string.IsNullOrEmpty(originalPath))
                return originalPath;
                
            // Jika path adalah path absolut (dimulai dengan '/')
            if (originalPath.StartsWith("/"))
            {
                // Cari posisi folder DS, DST, atau RPT dalam path asli
                var dsIndex = originalPath.IndexOf("/DS/", StringComparison.OrdinalIgnoreCase);
                if (dsIndex >= 0)
                {
                    var suffix = originalPath.Substring(dsIndex); // misal "/DS/IMS_DB"
                    return newModulePath.TrimEnd('/') + suffix;
                }
                
                var dstIndex = originalPath.IndexOf("/DST/", StringComparison.OrdinalIgnoreCase);
                if (dstIndex >= 0)
                {
                    var suffix = originalPath.Substring(dstIndex); // misal "/DST/dsCompany"
                    return newModulePath.TrimEnd('/') + suffix;
                }
                
                var rptIndex = originalPath.IndexOf("/RPT/", StringComparison.OrdinalIgnoreCase);
                if (rptIndex >= 0)
                {
                    var suffix = originalPath.Substring(rptIndex); // misal "/RPT/ReportName"
                    return newModulePath.TrimEnd('/') + suffix;
                }
                
                return originalPath;
            }
            else
            {
                // Jika path adalah path relatif (misal: "SSO" atau "GetCompany") dari Visual Studio / SSDT
                if (referenceType == "DataSource")
                {
                    return newModulePath.TrimEnd('/') + "/DS/" + originalPath.TrimStart('/');
                }
                else if (referenceType == "DataSet")
                {
                    return newModulePath.TrimEnd('/') + "/DST/" + originalPath.TrimStart('/');
                }
                return originalPath;
            }
        }

        #endregion
    }

    public class UploadResultDto
    {
        public bool Success { get; set; }
        public string Message { get; set; } = "";
        public List<string> Errors { get; set; } = new();
    }
}
