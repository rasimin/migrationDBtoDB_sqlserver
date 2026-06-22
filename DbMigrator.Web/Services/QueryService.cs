using System;
using System.Collections.Generic;
using System.Data;
using Microsoft.Data.SqlClient;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Extensions.Configuration;
using Dapper;
using DbMigrator.Core;
using DbMigrator.Web.Models;

namespace DbMigrator.Web.Services
{
    public class QueryService
    {
        private readonly IConfiguration _config;

        public QueryService(IConfiguration config)
        {
            _config = config;
        }

        private string ConfigConnectionString => _config.GetConnectionString("ConfigDb");

        public async Task<IEnumerable<SavedQuery>> GetSavedQueriesAsync(string searchTerm, DateTime? startDate, DateTime? endDate)
        {
            using var conn = new SqlConnection(ConfigConnectionString);
            return await conn.QueryAsync<SavedQuery>(@"
                SELECT Id, QueryName, QueryText, CreatedAt, UpdatedAt 
                FROM dbo.SavedQueries
                WHERE 1=1
                  AND (@SearchTerm IS NULL OR @SearchTerm = '' OR QueryName LIKE @SearchPattern OR QueryText LIKE @SearchPattern)
                  AND (@StartDate IS NULL OR CreatedAt >= @StartDate)
                  AND (@EndDate IS NULL OR CreatedAt < DATEADD(day, 1, @EndDate))
                ORDER BY UpdatedAt DESC",
                new { 
                    SearchTerm = searchTerm, 
                    SearchPattern = $"%{searchTerm}%", 
                    StartDate = startDate, 
                    EndDate = endDate 
                });
        }

        public async Task<SavedQuery> GetSavedQueryByIdAsync(int id)
        {
            using var conn = new SqlConnection(ConfigConnectionString);
            return await conn.QuerySingleOrDefaultAsync<SavedQuery>(
                "SELECT Id, QueryName, QueryText, CreatedAt, UpdatedAt FROM dbo.SavedQueries WHERE Id = @Id", new { Id = id });
        }

        public async Task<int> SaveSavedQueryAsync(SavedQuery request)
        {
            using var conn = new SqlConnection(ConfigConnectionString);
            if (request.Id > 0)
            {
                // Ambil data query saat ini sebelum diperbarui untuk disimpan ke tabel riwayat (versioning)
                var existing = await conn.QuerySingleOrDefaultAsync<SavedQuery>(
                    "SELECT QueryName, QueryText, UpdatedAt FROM dbo.SavedQueries WHERE Id = @Id", new { Id = request.Id });

                if (existing != null)
                {
                    // Hanya buat riwayat versi jika terdapat perbedaan nama atau isi kueri
                    if (existing.QueryName != request.QueryName || existing.QueryText != request.QueryText)
                    {
                        await conn.ExecuteAsync(@"
                            INSERT INTO dbo.SavedQueryHistory (QueryId, QueryName, QueryText, SavedAt)
                            VALUES (@QueryId, @QueryName, @QueryText, @SavedAt)",
                            new {
                                QueryId = request.Id,
                                QueryName = existing.QueryName,
                                QueryText = existing.QueryText,
                                SavedAt = existing.UpdatedAt
                            });
                    }
                }

                await conn.ExecuteAsync(@"
                    UPDATE dbo.SavedQueries
                    SET QueryName = @QueryName,
                        QueryText = @QueryText,
                        UpdatedAt = GETDATE()
                    WHERE Id = @Id",
                    request);
                return request.Id;
            }
            else
            {
                var id = await conn.QuerySingleAsync<int>(@"
                    INSERT INTO dbo.SavedQueries (QueryName, QueryText, CreatedAt, UpdatedAt)
                    VALUES (@QueryName, @QueryText, GETDATE(), GETDATE());
                    SELECT CAST(SCOPE_IDENTITY() as int);",
                    request);
                return id;
            }
        }

        public async Task<IEnumerable<SavedQueryHistory>> GetQueryHistoryAsync(int id)
        {
            using var conn = new SqlConnection(ConfigConnectionString);
            return await conn.QueryAsync<SavedQueryHistory>(@"
                SELECT Id, QueryId, QueryName, QueryText, SavedAt 
                FROM dbo.SavedQueryHistory 
                WHERE QueryId = @QueryId 
                ORDER BY SavedAt DESC", new { QueryId = id });
        }

        public async Task<bool> DeleteSavedQueryAsync(int id)
        {
            using var conn = new SqlConnection(ConfigConnectionString);
            var deleted = await conn.ExecuteAsync("DELETE FROM dbo.SavedQueries WHERE Id = @Id", new { Id = id });
            return deleted > 0;
        }

        public async Task<IEnumerable<SavedConnection>> GetSavedConnectionsAsync()
        {
            using var conn = new SqlConnection(ConfigConnectionString);
            return await conn.QueryAsync<SavedConnection>(
                "SELECT Id, ConnectionName, ServerName, Authentication, Login, Password, CreatedAt FROM dbo.SavedConnections ORDER BY ConnectionName ASC");
        }

        public async Task<int> SaveSavedConnectionAsync(SavedConnection request)
        {
            using var conn = new SqlConnection(ConfigConnectionString);
            var existing = await conn.QueryFirstOrDefaultAsync<int?>(
                "SELECT Id FROM dbo.SavedConnections WHERE ConnectionName = @ConnectionName", new { request.ConnectionName });

            if (existing.HasValue)
            {
                await conn.ExecuteAsync(@"
                    UPDATE dbo.SavedConnections 
                    SET ServerName = @ServerName, 
                        Authentication = @Authentication, 
                        Login = @Login, 
                        Password = @Password 
                    WHERE Id = @Id", 
                    new { 
                        Id = existing.Value,
                        request.ServerName, 
                        request.Authentication, 
                        request.Login, 
                        request.Password 
                    });
                return existing.Value;
            }
            else
            {
                return await conn.QuerySingleAsync<int>(@"
                    INSERT INTO dbo.SavedConnections (ConnectionName, ServerName, Authentication, Login, Password, CreatedAt)
                    VALUES (@ConnectionName, @ServerName, @Authentication, @Login, @Password, GETDATE());
                    SELECT CAST(SCOPE_IDENTITY() as int);", 
                    request);
            }
        }

        public async Task<bool> DeleteSavedConnectionAsync(int id)
        {
            using var conn = new SqlConnection(ConfigConnectionString);
            var deleted = await conn.ExecuteAsync("DELETE FROM dbo.SavedConnections WHERE Id = @id", new { id });
            return deleted > 0;
        }

        public async Task<IEnumerable<string>> ConnectAsync(QueryConnectRequest request)
        {
            var builder = new SqlConnectionStringBuilder
            {
                DataSource = request.ServerName,
                InitialCatalog = "master",
                TrustServerCertificate = true,
                ConnectTimeout = 10
            };

            if (string.Equals(request.Authentication, "SQL", StringComparison.OrdinalIgnoreCase))
            {
                builder.IntegratedSecurity = false;
                builder.UserID = request.Login;
                builder.Password = request.Password;
            }
            else
            {
                builder.IntegratedSecurity = true;
            }

            using var conn = new SqlConnection(builder.ConnectionString);
            await conn.OpenAsync();

            return await conn.QueryAsync<string>(
                "SELECT name FROM sys.databases WHERE state = 0 ORDER BY name");
        }

        public async Task<(IEnumerable<dynamic> Objects, IEnumerable<dynamic> Columns)> GetSchemaAsync(QuerySchemaRequest request)
        {
            var builder = new SqlConnectionStringBuilder
            {
                DataSource = request.ServerName,
                InitialCatalog = request.Database,
                TrustServerCertificate = true,
                ConnectTimeout = 10
            };

            if (string.Equals(request.Authentication, "SQL", StringComparison.OrdinalIgnoreCase))
            {
                builder.IntegratedSecurity = false;
                builder.UserID = request.Login;
                builder.Password = request.Password;
            }
            else
            {
                builder.IntegratedSecurity = true;
            }

            using var conn = new SqlConnection(builder.ConnectionString);
            await conn.OpenAsync();

            var objects = await conn.QueryAsync(@"
                SELECT 
                    o.name AS Name,
                    CASE o.type_desc 
                        WHEN 'SQL_STORED_PROCEDURE' THEN 'PROCEDURE'
                        WHEN 'SQL_SCALAR_FUNCTION' THEN 'FUNCTION'
                        WHEN 'SQL_TABLE_VALUED_FUNCTION' THEN 'FUNCTION'
                        WHEN 'SQL_INLINE_TABLE_VALUED_FUNCTION' THEN 'FUNCTION'
                        WHEN 'VIEW' THEN 'VIEW'
                        WHEN 'USER_TABLE' THEN 'TABLE'
                        ELSE o.type_desc
                    END AS Type
                FROM sys.objects o
                WHERE o.type IN ('P','FN','IF','TF','V','U')
                  AND o.is_ms_shipped = 0
                ORDER BY o.name");

            var columns = await conn.QueryAsync(@"
                SELECT 
                    t.name AS TableName,
                    c.name AS ColumnName,
                    typ.name AS DataType
                FROM sys.columns c
                JOIN sys.objects t ON c.object_id = t.object_id
                JOIN sys.types typ ON c.user_type_id = typ.user_type_id
                WHERE t.type IN ('U','V') 
                  AND t.is_ms_shipped = 0
                ORDER BY t.name, c.column_id");

            return (objects, columns);
        }

        public async Task<ExecuteQueryResult> ExecuteQueryAsync(QueryExecuteRequest request, CancellationToken cancellationToken)
        {
            var builder = new SqlConnectionStringBuilder
            {
                DataSource = request.ServerName,
                InitialCatalog = request.Database,
                TrustServerCertificate = true,
                ConnectTimeout = 15
            };

            if (string.Equals(request.Authentication, "SQL", StringComparison.OrdinalIgnoreCase))
            {
                builder.IntegratedSecurity = false;
                builder.UserID = request.Login;
                builder.Password = request.Password;
            }
            else
            {
                builder.IntegratedSecurity = true;
            }

            int logId = 0;
            try
            {
                using var configConn = new SqlConnection(ConfigConnectionString);
                logId = await configConn.QuerySingleAsync<int>(@"
                    INSERT INTO dbo.QueryExecutionLogs (ServerName, DatabaseName, QueryText, Status, ExecutedAt)
                    VALUES (@ServerName, @DatabaseName, @QueryText, 'InProgress', GETDATE());
                    SELECT CAST(SCOPE_IDENTITY() as int);",
                    new {
                        ServerName = request.ServerName,
                        DatabaseName = request.Database,
                        QueryText = request.QueryText
                    });
            }
            catch (Exception ex)
            {
                Console.WriteLine($"Gagal menyimpan log awal: {ex.Message}");
            }

            var stopwatch = System.Diagnostics.Stopwatch.StartNew();
            try
            {
                using var conn = new SqlConnection(builder.ConnectionString);
                
                var printMessages = new List<string>();
                conn.FireInfoMessageEventOnUserErrors = true;
                conn.InfoMessage += (sender, e) => {
                    foreach (SqlError err in e.Errors)
                    {
                        printMessages.Add(err.Message);
                    }
                };
                
                await conn.OpenAsync(cancellationToken);

                using var command = new SqlCommand(request.QueryText, conn);
                using var reader = await command.ExecuteReaderAsync(cancellationToken);

                var tables = new List<QueryResultTable>();

                do
                {
                    var headers = new List<string>();
                    var rows = new List<List<object>>();
                    bool isTruncated = false;

                    if (reader.FieldCount == 0)
                    {
                        var affected = reader.RecordsAffected;
                        if (affected >= 0)
                        {
                            headers.Add("Info");
                            rows.Add(new List<object> { $"({affected} baris terpengaruh)" });
                        }
                    }
                    else
                    {
                        for (int i = 0; i < reader.FieldCount; i++)
                        {
                            headers.Add(reader.GetName(i));
                        }

                        int rowCount = 0;
                        const int MaxConsoleRows = 1000;
                        while (await reader.ReadAsync(cancellationToken))
                        {
                            if (rowCount >= MaxConsoleRows)
                            {
                                isTruncated = true;
                                break;
                            }
                            var row = new List<object>();
                            for (int i = 0; i < reader.FieldCount; i++)
                            {
                                var val = reader.GetValue(i);
                                row.Add(val == DBNull.Value ? null : val);
                            }
                            rows.Add(row);
                            rowCount++;
                        }
                    }

                    if (headers.Count > 0)
                    {
                        tables.Add(new QueryResultTable { Headers = headers, Rows = rows, IsTruncated = isTruncated });
                    }
                } while (await reader.NextResultAsync(cancellationToken));

                stopwatch.Stop();

                var firstTable = tables.FirstOrDefault();

                if (logId > 0)
                {
                    try
                    {
                        using var configConn = new SqlConnection(ConfigConnectionString);
                        string responseMessages = printMessages != null && printMessages.Count > 0 
                            ? string.Join(Environment.NewLine, printMessages) 
                            : null;

                        if (string.IsNullOrEmpty(responseMessages))
                        {
                            var affectedRowsMsgs = new List<string>();
                            foreach (var tbl in tables)
                            {
                                if (tbl.Headers.Count == 1 && tbl.Headers[0] == "Info" && tbl.Rows.Count > 0)
                                {
                                    affectedRowsMsgs.Add(tbl.Rows[0][0]?.ToString());
                                }
                            }
                            if (affectedRowsMsgs.Count > 0)
                            {
                                responseMessages = string.Join(Environment.NewLine, affectedRowsMsgs);
                            }
                        }

                        await configConn.ExecuteAsync(@"
                            UPDATE dbo.QueryExecutionLogs
                            SET Status = 'Success',
                                ExecutionTimeMs = @ExecutionTimeMs,
                                ResponseMessages = @ResponseMessages,
                                ErrorMessage = NULL
                            WHERE Id = @Id",
                            new {
                                Id = logId,
                                ExecutionTimeMs = stopwatch.ElapsedMilliseconds,
                                ResponseMessages = responseMessages
                            });
                    }
                    catch (Exception ex)
                    {
                        Console.WriteLine($"Gagal mengupdate log sukses: {ex.Message}");
                    }
                }

                return new ExecuteQueryResult
                {
                    Tables = tables,
                    Headers = firstTable?.Headers ?? new List<string>(),
                    Rows = firstTable?.Rows ?? new List<List<object>>(),
                    ExecutionTimeMs = stopwatch.ElapsedMilliseconds,
                    PrintMessages = printMessages
                };
            }
            catch (Exception ex)
            {
                stopwatch.Stop();
                if (logId > 0)
                {
                    try
                    {
                        using var configConn = new SqlConnection(ConfigConnectionString);
                        await configConn.ExecuteAsync(@"
                            UPDATE dbo.QueryExecutionLogs
                            SET Status = 'Failed',
                                ExecutionTimeMs = @ExecutionTimeMs,
                                ErrorMessage = @ErrorMessage
                            WHERE Id = @Id",
                            new {
                                Id = logId,
                                ExecutionTimeMs = stopwatch.ElapsedMilliseconds,
                                ErrorMessage = ex.Message
                            });
                    }
                    catch (Exception logEx)
                    {
                        Console.WriteLine($"Gagal mengupdate log error: {logEx.Message}");
                    }
                }
                throw;
            }
        }

        public async Task<IEnumerable<QueryExecutionLog>> GetExecutionLogsAsync(string databaseName = null, string searchTerm = null)
        {
            using var conn = new SqlConnection(ConfigConnectionString);
            return await conn.QueryAsync<QueryExecutionLog>(@"
                SELECT TOP 100 Id, ServerName, DatabaseName, QueryText, Status, ExecutionTimeMs, ErrorMessage, ResponseMessages, ExecutedAt
                FROM dbo.QueryExecutionLogs
                WHERE (@DatabaseName IS NULL OR @DatabaseName = '' OR DatabaseName LIKE @DatabasePattern)
                  AND (@SearchTerm IS NULL OR @SearchTerm = '' OR QueryText LIKE @SearchPattern OR ServerName LIKE @SearchPattern)
                ORDER BY ExecutedAt DESC",
                new {
                    DatabaseName = databaseName,
                    DatabasePattern = $"%{databaseName}%",
                    SearchTerm = searchTerm,
                    SearchPattern = $"%{searchTerm}%"
                });
        }

        public async Task<IEnumerable<dynamic>> GetSchemaObjectsAsync(QuerySchemaObjectsRequest request)
        {
            var builder = new SqlConnectionStringBuilder
            {
                DataSource = request.ServerName,
                InitialCatalog = request.Database,
                TrustServerCertificate = true,
                ConnectTimeout = 15
            };

            if (string.Equals(request.Authentication, "SQL", StringComparison.OrdinalIgnoreCase))
            {
                builder.IntegratedSecurity = false;
                builder.UserID = request.Login;
                builder.Password = request.Password;
            }
            else
            {
                builder.IntegratedSecurity = true;
            }

            using var conn = new SqlConnection(builder.ConnectionString);
            await conn.OpenAsync();

            string typeFilter = "";
            if (request.ObjectType == "TABLE") typeFilter = "AND o.type = 'U'";
            else if (request.ObjectType == "VIEW") typeFilter = "AND o.type = 'V'";
            else if (request.ObjectType == "PROCEDURE") typeFilter = "AND o.type = 'P'";
            else if (request.ObjectType == "FUNCTION") typeFilter = "AND o.type IN ('FN', 'TF', 'IF')";
            else typeFilter = "AND o.type IN ('U', 'V', 'P', 'FN', 'TF', 'IF')";

            string searchFilter = "";
            if (!string.IsNullOrWhiteSpace(request.SearchTerm))
            {
                if (request.SearchInContent)
                {
                    searchFilter = @"AND (
                        o.name LIKE @SearchPattern 
                        OR s.name LIKE @SearchPattern 
                        OR sm.definition LIKE @SearchPattern 
                        OR EXISTS (SELECT 1 FROM sys.columns c WHERE c.object_id = o.object_id AND c.name LIKE @SearchPattern)
                    )";
                }
                else
                {
                    searchFilter = "AND (o.name LIKE @SearchPattern OR s.name LIKE @SearchPattern)";
                }
            }

            string sql = $@"
                SELECT 
                    s.name + '.' + o.name AS Name,
                    CASE o.type
                        WHEN 'U' THEN 'TABLE'
                        WHEN 'V' THEN 'VIEW'
                        WHEN 'P' THEN 'PROCEDURE'
                        WHEN 'FN' THEN 'FUNCTION'
                        WHEN 'TF' THEN 'FUNCTION'
                        WHEN 'IF' THEN 'FUNCTION'
                        ELSE o.type_desc
                    END AS Type,
                    o.create_date AS CreatedDate,
                    o.modify_date AS ModifiedDate
                FROM sys.objects o
                JOIN sys.schemas s ON o.schema_id = s.schema_id
                LEFT JOIN sys.sql_modules sm ON o.object_id = sm.object_id
                WHERE o.is_ms_shipped = 0
                  {typeFilter}
                  {searchFilter}
                ORDER BY Type, Name";

            return await conn.QueryAsync(sql, new { SearchPattern = $"%{request.SearchTerm}%" });
        }

        public async Task<string> GetSchemaDefinitionAsync(QuerySchemaDefinitionRequest request)
        {
            var builder = new SqlConnectionStringBuilder
            {
                DataSource = request.ServerName,
                InitialCatalog = request.Database,
                TrustServerCertificate = true,
                ConnectTimeout = 15
            };

            if (string.Equals(request.Authentication, "SQL", StringComparison.OrdinalIgnoreCase))
            {
                builder.IntegratedSecurity = false;
                builder.UserID = request.Login;
                builder.Password = request.Password;
            }
            else
            {
                builder.IntegratedSecurity = true;
            }

            using var conn = new SqlConnection(builder.ConnectionString);
            await conn.OpenAsync();

            if (request.ObjectType == "TABLE")
            {
                var parts = request.ObjectName.Split('.');
                string schema = parts.Length > 1 ? parts[0] : "dbo";
                string name = parts.Length > 1 ? parts[1] : parts[0];

                schema = schema.Replace("[", "").Replace("]", "");
                name = name.Replace("[", "").Replace("]", "");

                string fullName = $"{schema}.{name}";

                var columns = (await conn.QueryAsync<SchemaColumnDto>(@"
                    SELECT c.name AS Name, ty.name AS DataType, c.max_length AS MaxLength,
                           c.precision AS Precision, c.scale AS Scale, c.is_nullable AS IsNullable,
                           c.is_identity AS IsIdentity, dc.definition AS DefaultDefinition, c.column_id AS Ordinal
                    FROM sys.columns c
                    JOIN sys.types ty ON c.user_type_id = ty.user_type_id
                    LEFT JOIN sys.default_constraints dc ON c.default_object_id = dc.object_id
                    WHERE c.object_id = OBJECT_ID(@FullName)
                    ORDER BY c.column_id",
                    new { FullName = fullName })).ToList();

                var pkColumns = (await conn.QueryAsync<string>(@"
                    SELECT c.name
                    FROM sys.indexes i
                    JOIN sys.index_columns ic ON i.object_id = ic.object_id AND i.index_id = ic.index_id
                    JOIN sys.columns c ON ic.object_id = c.object_id AND ic.column_id = c.column_id
                    WHERE i.object_id = OBJECT_ID(@FullName) AND i.is_primary_key = 1
                    ORDER BY ic.key_ordinal",
                    new { FullName = fullName })).ToList();

                if (columns.Count > 0)
                {
                    return SchemaHelper.GenerateComparableTableDdl(schema, name, columns, pkColumns);
                }
                else
                {
                    return "-- Tabel tidak ditemukan atau tidak memiliki kolom --";
                }
            }
            else
            {
                string fullName = request.ObjectName;
                var definition = await conn.QuerySingleOrDefaultAsync<string>(@"
                    SELECT OBJECT_DEFINITION(OBJECT_ID(@FullName))",
                    new { FullName = fullName });

                return definition ?? "-- Definisi objek tidak tersedia atau terenkripsi --";
            }
        }

        public async Task<(string Script, int RowCount)> GenerateInsertsAsync(QueryGenerateInsertsRequest request)
        {
            var builder = new SqlConnectionStringBuilder
            {
                DataSource = request.ServerName,
                InitialCatalog = request.Database,
                TrustServerCertificate = true,
                ConnectTimeout = 15
            };

            if (string.Equals(request.Authentication, "SQL", StringComparison.OrdinalIgnoreCase))
            {
                builder.IntegratedSecurity = false;
                builder.UserID = request.Login;
                builder.Password = request.Password;
            }
            else
            {
                builder.IntegratedSecurity = true;
            }

            using var conn = new SqlConnection(builder.ConnectionString);
            await conn.OpenAsync();

            string whereSql = "";
            if (!string.IsNullOrWhiteSpace(request.WhereClause))
            {
                whereSql = $" WHERE {request.WhereClause}";
            }

            string escapedTable = request.TableName;
            if (!escapedTable.StartsWith("[") && !escapedTable.EndsWith("]"))
            {
                var parts = escapedTable.Split('.');
                escapedTable = string.Join(".", parts.Select(p => p.StartsWith("[") ? p : $"[{p}]"));
            }

            string topClause = string.IsNullOrWhiteSpace(request.WhereClause) ? "TOP 1000 " : "";
            string sql = $"SELECT {topClause}* FROM {escapedTable}{whereSql}";
            
            using var cmd = new SqlCommand(sql, conn);
            using var reader = await cmd.ExecuteReaderAsync();

            bool hasIdentity = false;
            var readOnlyColumns = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            var columnTypes = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);

            string GetSqlDeclarationType(string dataTypeName, int columnSize, int precision, int scale)
            {
                dataTypeName = dataTypeName.ToLower();
                if (dataTypeName == "varchar" || dataTypeName == "char")
                {
                    string size = columnSize <= 0 || columnSize > 8000 ? "max" : columnSize.ToString();
                    return $"{dataTypeName}({size})";
                }
                if (dataTypeName == "nvarchar" || dataTypeName == "nchar")
                {
                    string size = columnSize <= 0 || columnSize > 4000 ? "max" : columnSize.ToString();
                    return $"{dataTypeName}({size})";
                }
                if (dataTypeName == "decimal" || dataTypeName == "numeric")
                {
                    return $"{dataTypeName}({precision},{scale})";
                }
                if (dataTypeName == "varbinary" || dataTypeName == "binary")
                {
                    string size = columnSize <= 0 || columnSize > 8000 ? "max" : columnSize.ToString();
                    return $"{dataTypeName}({size})";
                }
                return dataTypeName;
            }

            string GetSqlVariableName(string columnName)
            {
                var clean = System.Text.RegularExpressions.Regex.Replace(columnName, @"[^a-zA-Z0-9_]", "_");
                return "@" + clean;
            }

            var schemaTable = reader.GetSchemaTable();
            if (schemaTable != null)
            {
                foreach (DataRow row in schemaTable.Rows)
                {
                    var columnName = row["ColumnName"]?.ToString();
                    if (string.IsNullOrEmpty(columnName)) continue;

                    var isId = row["IsIdentity"] != DBNull.Value && (bool)row["IsIdentity"];
                    if (isId)
                    {
                        hasIdentity = true;
                    }

                    var isReadOnly = false;
                    if (schemaTable.Columns.Contains("IsReadOnly") && row["IsReadOnly"] != DBNull.Value)
                    {
                        isReadOnly = (bool)row["IsReadOnly"];
                    }

                    if (isReadOnly && !isId)
                    {
                        readOnlyColumns.Add(columnName);
                    }
                    else
                    {
                        var dataTypeName = schemaTable.Columns.Contains("DataTypeName") ? row["DataTypeName"]?.ToString() : "nvarchar";
                        var columnSize = schemaTable.Columns.Contains("ColumnSize") && row["ColumnSize"] != DBNull.Value ? Convert.ToInt32(row["ColumnSize"]) : -1;
                        var precision = schemaTable.Columns.Contains("NumericPrecision") && row["NumericPrecision"] != DBNull.Value ? Convert.ToInt32(row["NumericPrecision"]) : -1;
                        var scale = schemaTable.Columns.Contains("NumericScale") && row["NumericScale"] != DBNull.Value ? Convert.ToInt32(row["NumericScale"]) : -1;
                        
                        var sqlType = GetSqlDeclarationType(dataTypeName ?? "nvarchar", columnSize, precision, scale);
                        columnTypes[columnName] = sqlType;
                    }
                }
            }

            var columns = new List<string>();
            var columnOrdinals = new List<int>();
            for (int i = 0; i < reader.FieldCount; i++)
            {
                var colName = reader.GetName(i);
                if (readOnlyColumns.Contains(colName))
                {
                    continue;
                }
                columns.Add(colName);
                columnOrdinals.Add(i);
            }

            if (columns.Count == 0)
            {
                return ("-- Tidak ada kolom yang dapat disisipkan --", 0);
            }

            string columnsPart = string.Join(", ", columns.Select(c => $"[{c}]"));
            int rowCount = 0;
            var sb = new System.Text.StringBuilder();

            if (request.UseVariables)
            {
                foreach (var col in columns)
                {
                    var varName = GetSqlVariableName(col);
                    var sqlType = columnTypes.TryGetValue(col, out var t) ? t : "nvarchar(max)";
                    sb.AppendLine($"DECLARE {varName} {sqlType};");
                }
                sb.AppendLine();

                while (await reader.ReadAsync())
                {
                    rowCount++;
                    for (int i = 0; i < columns.Count; i++)
                    {
                        var col = columns[i];
                        var ordinal = columnOrdinals[i];
                        var varName = GetSqlVariableName(col);
                        var valueStr = FormatValueForSql(reader.GetValue(ordinal));
                        sb.AppendLine($"SET {varName} = {valueStr};");
                    }

                    var varNamesPart = string.Join(", ", columns.Select(c => GetSqlVariableName(c)));
                    sb.AppendLine($"INSERT INTO {escapedTable} ({columnsPart}) VALUES ({varNamesPart});");
                    sb.AppendLine();
                }
            }
            else
            {
                while (await reader.ReadAsync())
                {
                    rowCount++;
                    var values = new List<string>();
                    foreach (var ordinal in columnOrdinals)
                    {
                        values.Add(FormatValueForSql(reader.GetValue(ordinal)));
                    }
                    sb.AppendLine($"INSERT INTO {escapedTable} ({columnsPart}) VALUES ({string.Join(", ", values)});");
                }
            }

            if (rowCount == 0)
            {
                return ("-- Tidak ada data yang cocok dengan kriteria WHERE --", 0);
            }

            var finalSb = new System.Text.StringBuilder();
            if (hasIdentity)
            {
                finalSb.AppendLine($"SET IDENTITY_INSERT {escapedTable} ON;");
                finalSb.AppendLine();
            }

            finalSb.Append(sb.ToString());

            if (hasIdentity)
            {
                finalSb.AppendLine();
                finalSb.AppendLine($"SET IDENTITY_INSERT {escapedTable} OFF;");
            }

            return (finalSb.ToString(), rowCount);
        }

        public static string FormatValueForSql(object val)
        {
            if (val == null || val == DBNull.Value)
                return "NULL";

            if (val is string s)
                return "'" + s.Replace("'", "''") + "'";

            if (val is DateTime dt)
                return "'" + dt.ToString("yyyy-MM-dd HH:mm:ss.fff") + "'";

            if (val is Guid g)
                return "'" + g.ToString() + "'";

            if (val is bool b)
                return b ? "1" : "0";

            if (val is byte[] bytes)
                return "0x" + BitConverter.ToString(bytes).Replace("-", "");

            return Convert.ToString(val, System.Globalization.CultureInfo.InvariantCulture);
        }
    }

    public class ExecuteQueryResult
    {
        public List<QueryResultTable> Tables { get; set; }
        public List<string> Headers { get; set; }
        public List<List<object>> Rows { get; set; }
        public long ExecutionTimeMs { get; set; }
        public List<string> PrintMessages { get; set; }
    }
}
