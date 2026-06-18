using System;
using System.Collections.Generic;
using System.Collections.Concurrent;
using System.Data;
using Microsoft.Data.SqlClient;
using System.IO;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.AspNetCore.SignalR;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Hosting;
using Dapper;
using DbMigrator.Core;
using DbMigrator.Web.Models;

namespace DbMigrator.Web.Services
{
    public class MigrationService
    {
        private readonly IConfiguration _config;
        private readonly IHubContext<MigrationHub> _hubContext;
        private readonly IHostApplicationLifetime _appLifetime;

        public static readonly ConcurrentDictionary<int, CancellationTokenSource> ActiveJobTokens = new();

        public MigrationService(
            IConfiguration config, 
            IHubContext<MigrationHub> hubContext, 
            IHostApplicationLifetime appLifetime)
        {
            _config = config;
            _hubContext = hubContext;
            _appLifetime = appLifetime;
        }

        private string ConfigConnectionString => _config.GetConnectionString("ConfigDb");

        #region Job CRUD

        public async Task<IEnumerable<MigrationJob>> GetJobsAsync()
        {
            using var conn = new SqlConnection(ConfigConnectionString);
            return await conn.QueryAsync<MigrationJob>("SELECT * FROM dbo.MigrationJobs ORDER BY Id DESC");
        }

        public async Task<MigrationJob> GetJobByIdAsync(int id)
        {
            using var conn = new SqlConnection(ConfigConnectionString);
            return await conn.QuerySingleOrDefaultAsync<MigrationJob>("SELECT * FROM dbo.MigrationJobs WHERE Id = @Id", new { Id = id });
        }

        public async Task<int> SaveJobAsync(MigrationJob job)
        {
            using var conn = new SqlConnection(ConfigConnectionString);
            if (job.Id > 0)
            {
                await conn.ExecuteAsync(@"
                    UPDATE dbo.MigrationJobs 
                    SET JobName = @JobName, SourceConnectionString = @SourceConnectionString, TargetConnectionString = @TargetConnectionString, PostMigrationScript = @PostMigrationScript, BackupPath = @BackupPath
                    WHERE Id = @Id", job);
                return job.Id;
            }
            else
            {
                int newId = await conn.QuerySingleAsync<int>(@"
                    INSERT INTO dbo.MigrationJobs (JobName, SourceConnectionString, TargetConnectionString, PostMigrationScript, BackupPath)
                    VALUES (@JobName, @SourceConnectionString, @TargetConnectionString, @PostMigrationScript, @BackupPath);
                    SELECT CAST(SCOPE_IDENTITY() as int);", job);
                job.Id = newId;
                return newId;
            }
        }

        public async Task<bool> DeleteJobAsync(int id)
        {
            using var conn = new SqlConnection(ConfigConnectionString);
            var rows = await conn.ExecuteAsync("DELETE FROM dbo.MigrationJobs WHERE Id = @Id", new { Id = id });
            return rows > 0;
        }

        public async Task<bool> TestConnectionAsync(string connectionString)
        {
            if (string.IsNullOrEmpty(connectionString))
            {
                throw new ArgumentException("Connection string kosong");
            }
            using var conn = new SqlConnection(connectionString);
            await conn.OpenAsync();
            return true;
        }

        #endregion

        #region Table Mappings

        public async Task<IEnumerable<TableMapping>> GetTableMappingsAsync(int jobId)
        {
            using var conn = new SqlConnection(ConfigConnectionString);
            return await conn.QueryAsync<TableMapping>(
                "SELECT * FROM dbo.TableMappings WHERE JobId = @JobId ORDER BY ExecutionOrder ASC", new { JobId = jobId });
        }

        public async Task ReorderTableMappingsAsync(int jobId, List<ReorderItemDto> items)
        {
            using var conn = new SqlConnection(ConfigConnectionString);
            await conn.OpenAsync();
            using var transaction = conn.BeginTransaction();
            try
            {
                foreach (var item in items)
                {
                    await conn.ExecuteAsync(@"
                        UPDATE dbo.TableMappings
                        SET ExecutionOrder = @ExecutionOrder
                        WHERE Id = @Id AND JobId = @JobId",
                        new { item.Id, item.ExecutionOrder, JobId = jobId }, transaction);
                }
                transaction.Commit();
            }
            catch
            {
                transaction.Rollback();
                throw;
            }
        }

        public async Task<TableMapping> SaveTableMappingAsync(TableMapping mapping)
        {
            using var conn = new SqlConnection(ConfigConnectionString);
            var isNativeSql = string.Equals(mapping.MappingMode, "NATIVE_SQL", StringComparison.OrdinalIgnoreCase);
            
            if (!isNativeSql && mapping.Id == 0)
            {
                var existing = await conn.QueryFirstOrDefaultAsync<int?>(
                    "SELECT TOP 1 Id FROM dbo.TableMappings WHERE JobId = @JobId AND MappingMode = 'TABLE' AND (SourceTableName = @SourceTableName OR TargetTableName = @TargetTableName)",
                    mapping);
                if (existing != null)
                {
                    throw new InvalidOperationException("Pemetaan untuk tabel asal atau tujuan tersebut sudah terdaftar pada Job ini!");
                }
            }
            else if (!isNativeSql)
            {
                var existing = await conn.QueryFirstOrDefaultAsync<int?>(
                    "SELECT TOP 1 Id FROM dbo.TableMappings WHERE JobId = @JobId AND Id <> @Id AND MappingMode = 'TABLE' AND (SourceTableName = @SourceTableName OR TargetTableName = @TargetTableName)",
                    mapping);
                if (existing != null)
                {
                    throw new InvalidOperationException("Pemetaan untuk tabel asal atau tujuan tersebut sudah terdaftar pada Job ini!");
                }
            }

            if (mapping.Id > 0)
            {
                await conn.ExecuteAsync(@"
                    UPDATE dbo.TableMappings 
                    SET SourceTableName = @SourceTableName, TargetTableName = @TargetTableName, 
                        ExecutionOrder = @ExecutionOrder, TruncateTarget = @TruncateTarget, IsEnabled = @IsEnabled,
                        PostMigrationScript = @PostMigrationScript, MappingMode = @MappingMode, NativeSqlScript = @NativeSqlScript,
                        WhereClause = @WhereClause
                    WHERE Id = @Id", mapping);
                return mapping;
            }
            else
            {
                if (mapping.ExecutionOrder <= 0)
                {
                    var maxOrder = await conn.QueryFirstOrDefaultAsync<int?>(
                        "SELECT MAX(ExecutionOrder) FROM dbo.TableMappings WHERE JobId = @JobId", new { JobId = mapping.JobId });
                    mapping.ExecutionOrder = (maxOrder ?? 0) + 1;
                }

                int newId = await conn.QuerySingleAsync<int>(@"
                    INSERT INTO dbo.TableMappings (JobId, SourceTableName, TargetTableName, ExecutionOrder, TruncateTarget, IsEnabled, PostMigrationScript, MappingMode, NativeSqlScript, WhereClause)
                    VALUES (@JobId, @SourceTableName, @TargetTableName, @ExecutionOrder, @TruncateTarget, @IsEnabled, @PostMigrationScript, @MappingMode, @NativeSqlScript, @WhereClause);
                    SELECT CAST(SCOPE_IDENTITY() as int);", mapping);
                mapping.Id = newId;
                return mapping;
            }
        }

        public async Task DeleteTableMappingAsync(int id)
        {
            using var conn = new SqlConnection(ConfigConnectionString);
            await conn.ExecuteAsync("DELETE FROM dbo.TableMappings WHERE Id = @Id", new { Id = id });
        }

        #endregion

        #region Column Mappings

        public async Task<IEnumerable<ColumnMapping>> GetColumnMappingsAsync(int tableMappingId)
        {
            using var conn = new SqlConnection(ConfigConnectionString);
            return await conn.QueryAsync<ColumnMapping>(
                "SELECT * FROM dbo.ColumnMappings WHERE TableMappingId = @TableMappingId", new { TableMappingId = tableMappingId });
        }

        public async Task SaveColumnMappingsAsync(int tableMappingId, List<ColumnMapping> columns)
        {
            using var conn = new SqlConnection(ConfigConnectionString);
            await conn.OpenAsync();
            using var transaction = conn.BeginTransaction();
            try
            {
                await conn.ExecuteAsync("DELETE FROM dbo.ColumnMappings WHERE TableMappingId = @TableMappingId", new { TableMappingId = tableMappingId }, transaction);
                foreach (var col in columns)
                {
                    col.TableMappingId = tableMappingId;
                    await conn.ExecuteAsync(@"
                        INSERT INTO dbo.ColumnMappings (TableMappingId, SourceColumnName, TargetColumnName, MappingType, ConstantValue, LookupTable, LookupKeyColumn, LookupValueColumn, ExpressionSQL, IfNullAction, IfNullParam)
                        VALUES (@TableMappingId, @SourceColumnName, @TargetColumnName, @MappingType, @ConstantValue, @LookupTable, @LookupKeyColumn, @LookupValueColumn, @ExpressionSQL, @IfNullAction, @IfNullParam)",
                        col, transaction);
                }
                transaction.Commit();
            }
            catch
            {
                transaction.Rollback();
                throw;
            }
        }

        #endregion

        #region SQL Stored Procedure Generator

        public async Task<(string SpName, string SqlScript)> GenerateSpAsync(int id)
        {
            using var conn = new SqlConnection(ConfigConnectionString);
            var tableMap = await conn.QuerySingleOrDefaultAsync<TableMapping>(
                "SELECT * FROM dbo.TableMappings WHERE Id = @Id", new { Id = id });
            if (tableMap == null) throw new ArgumentException($"Table mapping {id} tidak ditemukan");

            var job = await conn.QuerySingleOrDefaultAsync<MigrationJob>(
                "SELECT * FROM dbo.MigrationJobs WHERE Id = @Id", new { Id = tableMap.JobId });
            if (job == null) throw new ArgumentException($"Job {tableMap.JobId} tidak ditemukan");

            var columns = (await conn.QueryAsync<ColumnMapping>(
                "SELECT * FROM dbo.ColumnMappings WHERE TableMappingId = @TableMappingId", 
                new { TableMappingId = id })).ToList();

            string sourceDb = GetDatabaseName(job.SourceConnectionString);
            string targetDb = GetDatabaseName(job.TargetConnectionString);

            string sourceTableFq = FormatQualifiedTableName(sourceDb, tableMap.SourceTableName);
            string targetTableFq = FormatQualifiedTableName(targetDb, tableMap.TargetTableName);

            var activeCols = columns.Where(c => !c.MappingType.Equals("Ignore", StringComparison.OrdinalIgnoreCase)).ToList();

            if (activeCols.Count == 0)
            {
                using var targetConn = new SqlConnection(job.TargetConnectionString);
                await targetConn.OpenAsync();
                
                var cleanTableName = tableMap.TargetTableName.Replace("[", "").Replace("]", "");
                string schemaName = "dbo";
                string rawTableName = cleanTableName;
                if (cleanTableName.Contains('.'))
                {
                    var parts = cleanTableName.Split('.');
                    schemaName = parts[0];
                    rawTableName = parts[1];
                }

                var targetSchemaCols = (await targetConn.QueryAsync<string>(@"
                    SELECT COLUMN_NAME 
                    FROM INFORMATION_SCHEMA.COLUMNS 
                    WHERE TABLE_NAME = @TableName AND TABLE_SCHEMA = @SchemaName
                    ORDER BY ORDINAL_POSITION", 
                    new { TableName = rawTableName, SchemaName = schemaName })).ToList();

                foreach (var colName in targetSchemaCols)
                {
                    activeCols.Add(new ColumnMapping
                    {
                        TargetColumnName = colName,
                        SourceColumnName = colName,
                        MappingType = "Direct"
                    });
                }
            }

            if (activeCols.Count == 0)
            {
                throw new InvalidOperationException("Tabel pemetaan tidak memiliki kolom aktif untuk dimigrasi dan gagal mendeteksi skema otomatis.");
            }

            var targetColsList = new List<string>();
            var selectProjections = new List<string>();

            foreach (var col in activeCols)
            {
                targetColsList.Add($"[{col.TargetColumnName}]");

                string projection = "NULL";
                if (col.MappingType.Equals("Direct", StringComparison.OrdinalIgnoreCase))
                {
                    projection = $"Source.[{col.SourceColumnName}]";
                }
                else if (col.MappingType.Equals("Constant", StringComparison.OrdinalIgnoreCase))
                {
                    string val = col.ConstantValue ?? "";
                    string sqlVal = val.Replace("'", "''");
                    if (decimal.TryParse(val, out _))
                    {
                        projection = sqlVal;
                    }
                    else
                    {
                        projection = $"'{sqlVal}'";
                    }
                }
                else if (col.MappingType.Equals("Expression", StringComparison.OrdinalIgnoreCase))
                {
                    projection = $"({col.ExpressionSQL})";
                }
                else if (col.MappingType.Equals("Lookup", StringComparison.OrdinalIgnoreCase))
                {
                    string lookupTableFq = FormatQualifiedTableName(targetDb, col.LookupTable);
                    projection = $"(SELECT [{col.LookupValueColumn}] FROM {lookupTableFq} WHERE [{col.LookupKeyColumn}] = Source.[{col.SourceColumnName}])";
                }

                if (!string.IsNullOrWhiteSpace(col.IfNullAction) && !col.IfNullAction.Equals("Null", StringComparison.OrdinalIgnoreCase))
                {
                    string action = col.IfNullAction.Trim();
                    string param = col.IfNullParam ?? "";
                    string fallback = "NULL";

                    if (action.Equals("GetDate", StringComparison.OrdinalIgnoreCase))
                    {
                        fallback = "GETDATE()";
                    }
                    else if (action.Equals("Constant", StringComparison.OrdinalIgnoreCase))
                    {
                        string sqlVal = param.Replace("'", "''");
                        if (decimal.TryParse(param, out _))
                        {
                            fallback = sqlVal;
                        }
                        else
                        {
                            fallback = $"'{sqlVal}'";
                        }
                    }
                    else if (action.Equals("RandomNumber", StringComparison.OrdinalIgnoreCase))
                    {
                        int len = int.TryParse(param, out var l) ? Math.Max(1, l) : 8;
                        fallback = $"LEFT(CAST(ABS(CHECKSUM(NEWID())) AS VARCHAR(50)), {len})";
                    }
                    else if (action.Equals("RandomLetters", StringComparison.OrdinalIgnoreCase) || action.Equals("RandomAlphanumeric", StringComparison.OrdinalIgnoreCase))
                    {
                        int len = int.TryParse(param, out var l) ? Math.Max(1, l) : 8;
                        fallback = $"LEFT(REPLACE(CAST(NEWID() AS VARCHAR(36)), '-', ''), {len})";
                    }
                    else if (action.Equals("Expression", StringComparison.OrdinalIgnoreCase) && !string.IsNullOrWhiteSpace(param))
                    {
                        fallback = $"({param})";
                    }

                    projection = $"ISNULL({projection}, {fallback})";
                }

                selectProjections.Add(projection);
            }

            string spName = $"sp_Migrate_{tableMap.TargetTableName.Replace("[", "").Replace("]", "").Replace(".", "_")}";
            
            var sb = new System.Text.StringBuilder();
            sb.AppendLine($"-- ===========================================================================");
            sb.AppendLine($"-- STORED PROCEDURE: {spName}");
            sb.AppendLine($"-- Digenerate secara otomatis oleh DbMigrator.NET");
            sb.AppendLine($"-- Deskripsi: Migrasi manual dari {tableMap.SourceTableName} ke {tableMap.TargetTableName}");
            sb.AppendLine($"-- ===========================================================================");
            sb.AppendLine($"CREATE OR ALTER PROCEDURE dbo.{spName}");
            sb.AppendLine("AS");
            sb.AppendLine("BEGIN");
            sb.AppendLine("    SET NOCOUNT ON;");
            sb.AppendLine("    BEGIN TRANSACTION;");
            sb.AppendLine("    BEGIN TRY");
            
            if (tableMap.TruncateTarget)
            {
                sb.AppendLine("        -- 1. Kosongkan tabel tujuan sebelum migrasi");
                sb.AppendLine($"        DELETE FROM {targetTableFq};");
                sb.AppendLine();
            }
            
            sb.AppendLine("        -- 2. Lakukan insert data secara massal menggunakan pemetaan kolom");
            sb.AppendLine($"        INSERT INTO {targetTableFq} (");
            sb.AppendLine($"            {string.Join(",\n            ", targetColsList)}");
            sb.AppendLine("        )");
            sb.AppendLine("        SELECT ");
            sb.AppendLine($"            {string.Join(",\n            ", selectProjections)}");
            sb.Append($"        FROM {sourceTableFq} AS Source");

            if (!string.IsNullOrWhiteSpace(tableMap.WhereClause))
            {
                var where = tableMap.WhereClause.Trim();
                if (!where.StartsWith("WHERE", StringComparison.OrdinalIgnoreCase))
                {
                    where = "WHERE " + where;
                }
                sb.Append($" {where}");
            }
            sb.AppendLine(";");
            sb.AppendLine();

            if (!string.IsNullOrWhiteSpace(tableMap.PostMigrationScript))
            {
                sb.AppendLine("        -- 3. Jalankan Post-Migration Script tingkat tabel");
                sb.AppendLine("        EXEC sp_executesql N'" + tableMap.PostMigrationScript.Replace("'", "''") + "';");
                sb.AppendLine();
            }
            
            sb.AppendLine("        COMMIT TRANSACTION;");
            sb.AppendLine($"        PRINT 'Migrasi untuk tabel {tableMap.TargetTableName} sukses!';");
            sb.AppendLine("    END TRY");
            sb.AppendLine("    BEGIN CATCH");
            sb.AppendLine("        IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;");
            sb.AppendLine("        DECLARE @ErrorMessage NVARCHAR(4000) = ERROR_MESSAGE();");
            sb.AppendLine("        DECLARE @ErrorSeverity INT = ERROR_SEVERITY();");
            sb.AppendLine("        DECLARE @ErrorState INT = ERROR_STATE();");
            sb.AppendLine("        RAISERROR(@ErrorMessage, @ErrorSeverity, @ErrorState);");
            sb.AppendLine("    END CATCH");
            sb.AppendLine("END");

            return (spName, sb.ToString());
        }

        #endregion

        #region DB Metadata

        public async Task<IEnumerable<string>> GetDbTablesAsync(int jobId, string dbType)
        {
            using var configConn = new SqlConnection(ConfigConnectionString);
            var job = await configConn.QuerySingleOrDefaultAsync<MigrationJob>("SELECT * FROM dbo.MigrationJobs WHERE Id = @Id", new { Id = jobId });
            if (job == null) throw new ArgumentException($"Job {jobId} tidak ditemukan");

            string connectionString = dbType.Equals("source", StringComparison.OrdinalIgnoreCase) 
                ? job.SourceConnectionString 
                : job.TargetConnectionString;

            if (string.IsNullOrEmpty(connectionString)) throw new ArgumentException("Connection string kosong");

            using var conn = new SqlConnection(connectionString);
            await conn.OpenAsync();
            return await conn.QueryAsync<string>(
                "SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME");
        }

        public async Task<IEnumerable<dynamic>> GetDbColumnsAsync(int jobId, string dbType, string tableName)
        {
            using var configConn = new SqlConnection(ConfigConnectionString);
            var job = await configConn.QuerySingleOrDefaultAsync<MigrationJob>("SELECT * FROM dbo.MigrationJobs WHERE Id = @Id", new { Id = jobId });
            if (job == null) throw new ArgumentException($"Job {jobId} tidak ditemukan");

            string connectionString = dbType.Equals("source", StringComparison.OrdinalIgnoreCase) 
                ? job.SourceConnectionString 
                : job.TargetConnectionString;

            if (string.IsNullOrEmpty(connectionString)) throw new ArgumentException("Connection string kosong");

            using var conn = new SqlConnection(connectionString);
            await conn.OpenAsync();
            var columns = await conn.QueryAsync(@"
                SELECT COLUMN_NAME, DATA_TYPE, CHARACTER_MAXIMUM_LENGTH, NUMERIC_PRECISION, NUMERIC_SCALE 
                FROM INFORMATION_SCHEMA.COLUMNS 
                WHERE TABLE_NAME = @TableName 
                ORDER BY ORDINAL_POSITION",
                new { TableName = tableName });
                
            return columns.Select(c => {
                string dataType = (string)c.DATA_TYPE;
                string formattedType = dataType;
                long? maxLen = c.CHARACTER_MAXIMUM_LENGTH != null ? Convert.ToInt64(c.CHARACTER_MAXIMUM_LENGTH) : (long?)null;
                int? numPrec = c.NUMERIC_PRECISION != null ? Convert.ToInt32(c.NUMERIC_PRECISION) : (int?)null;
                int? numScale = c.NUMERIC_SCALE != null ? Convert.ToInt32(c.NUMERIC_SCALE) : (int?)null;

                if (dataType == "varchar" || dataType == "nvarchar" || dataType == "char" || dataType == "nchar" || dataType == "varbinary")
                {
                    formattedType = maxLen == -1 ? $"{dataType}(max)" : $"{dataType}({maxLen})";
                }
                else if (dataType == "decimal" || dataType == "numeric")
                {
                    formattedType = $"{dataType}({numPrec},{numScale})";
                }
                return new { Name = (string)c.COLUMN_NAME, Type = formattedType, RawType = dataType };
            });
        }

        public async Task<dynamic> GetEntireSchemaAsync(int jobId, string dbType)
        {
            using var configConn = new SqlConnection(ConfigConnectionString);
            var job = await configConn.QuerySingleOrDefaultAsync<MigrationJob>("SELECT * FROM dbo.MigrationJobs WHERE Id = @Id", new { Id = jobId });
            if (job == null) throw new ArgumentException($"Job {jobId} tidak ditemukan");

            string connectionString = dbType.Equals("source", StringComparison.OrdinalIgnoreCase) 
                ? job.SourceConnectionString 
                : job.TargetConnectionString;

            if (string.IsNullOrEmpty(connectionString)) throw new ArgumentException("Connection string kosong");

            using var conn = new SqlConnection(connectionString);
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

            return new { Objects = objects, Columns = columns };
        }

        #endregion

        #region Schema Comparison & Sync

        public async Task<dynamic> CompareSchemaAsync(int jobId)
        {
            using var configConn = new SqlConnection(ConfigConnectionString);
            var job = await configConn.QuerySingleOrDefaultAsync<MigrationJob>("SELECT * FROM dbo.MigrationJobs WHERE Id = @Id", new { Id = jobId });
            if (job == null) throw new ArgumentException($"Job {jobId} tidak ditemukan");
            if (string.IsNullOrWhiteSpace(job.SourceConnectionString) || string.IsNullOrWhiteSpace(job.TargetConnectionString))
                throw new ArgumentException("Connection string Source atau Target kosong");

            using var sourceConn = new SqlConnection(job.SourceConnectionString);
            using var targetConn = new SqlConnection(job.TargetConnectionString);
            await sourceConn.OpenAsync();
            await targetConn.OpenAsync();

            var sourceObjects = await LoadComparableObjects(sourceConn);
            var targetObjects = await LoadComparableObjects(targetConn);
            var items = new List<SchemaComparisonItemDto>();

            foreach (var sourceObj in sourceObjects.Values.OrderBy(o => o.Type).ThenBy(o => o.Name))
            {
                targetObjects.TryGetValue(sourceObj.Key, out var targetObj);

                var item = new SchemaComparisonItemDto
                {
                    Name = sourceObj.Name,
                    Type = sourceObj.DisplayType,
                    SourceDdl = sourceObj.Ddl,
                    TargetDdl = targetObj?.Ddl ?? "-- Objek tidak ditemukan di Target DB --"
                };

                if (targetObj == null)
                {
                    item.Status = "Missing";
                    item.Info = "Objek tidak ditemukan sama sekali di Target DB.";
                }
                else if (sourceObj.Type == "TABLE")
                {
                    var differences = CompareTableColumns(sourceObj.Columns, targetObj.Columns);
                    if (differences.Count == 0)
                    {
                        item.Status = "Match";
                        item.Info = "Struktur skema identik 100%.";
                    }
                    else
                    {
                        item.Status = "Mismatch";
                        item.Info = string.Join("<br>", differences.Select(SchemaHelper.EscapeHtml));
                        item.ColumnSync = BuildColumnSyncPlan(sourceObj, targetObj);
                    }
                }
                else if (SchemaHelper.NormalizeDdl(sourceObj.Ddl) == SchemaHelper.NormalizeDdl(targetObj.Ddl))
                {
                    item.Status = "Match";
                    item.Info = "Struktur skema identik 100%.";
                }
                else
                {
                    item.Status = "Outdated";
                    item.Info = "Definisi DDL berbeda antara Source DB dan Target DB.";
                }

                items.Add(item);
            }

            var summary = new Dictionary<string, SchemaComparisonSummaryDto>();
            foreach (var type in new[] { "Table", "View", "Stored Procedure", "Function" })
            {
                summary[type] = new SchemaComparisonSummaryDto
                {
                    SourceCount = sourceObjects.Values.Count(o => o.DisplayType == type),
                    TargetCount = targetObjects.Values.Count(o => o.DisplayType == type),
                    MissingCount = items.Count(i => i.Type == type && i.Status == "Missing"),
                    MismatchCount = items.Count(i => i.Type == type && i.Status == "Mismatch"),
                    OutdatedCount = items.Count(i => i.Type == type && i.Status == "Outdated")
                };
            }

            return new { Summary = summary, Items = items };
        }

        #endregion

        #region Run & Cancel Data Migration

        public void RunMigrationJob(int id, int? mappingId, bool checkConstraints)
        {
            var cts = new CancellationTokenSource();
            ActiveJobTokens[id] = cts;
            
            var linkedCts = CancellationTokenSource.CreateLinkedTokenSource(cts.Token, _appLifetime.ApplicationStopping);
            var token = linkedCts.Token;

            _ = Task.Run(async () =>
            {
                try
                {
                    var engine = new MigrationEngine(ConfigConnectionString);
                    
                    await engine.RunJobAsync(id, (tableName, totalRows, rowsMigrated, status, error) =>
                    {
                        _hubContext.Clients.Group("JobGroup_" + id).SendAsync("ReceiveProgress", new
                        {
                            JobId = id,
                            TableName = tableName,
                            TotalRows = totalRows,
                            RowsMigrated = rowsMigrated,
                            Status = status,
                            ErrorMessage = error
                        }).GetAwaiter().GetResult();
                    }, token, mappingId, checkConstraints);
                }
                catch (Exception ex)
                {
                    var errorMsg = ex is OperationCanceledException ? "Proses dibatalkan oleh pengguna." : ex.Message;
                    _hubContext.Clients.Group("JobGroup_" + id).SendAsync("ReceiveError", new
                    {
                        JobId = id,
                        Message = errorMsg
                    }).GetAwaiter().GetResult();
                }
                finally
                {
                    ActiveJobTokens.TryRemove(id, out _);
                    linkedCts.Dispose();
                }
            }, _appLifetime.ApplicationStopping);
        }

        public bool CancelMigrationJob(int id)
        {
            if (ActiveJobTokens.TryRemove(id, out var cts))
            {
                cts.Cancel();
                return true;
            }
            return false;
        }

        #endregion

        #region Backup & Restore (AppIMS & DB Target)

        public async Task<GeneralAppSettings> GetAppimsSettingsAsync(string envContentRootPath)
        {
            var filePath = Path.Combine(envContentRootPath, "app-config.json");
            if (!File.Exists(filePath))
            {
                return new GeneralAppSettings();
            }
            var json = await File.ReadAllTextAsync(filePath);
            return System.Text.Json.JsonSerializer.Deserialize<GeneralAppSettings>(json) ?? new GeneralAppSettings();
        }

        public async Task SaveAppimsSettingsAsync(GeneralAppSettings settings, string envContentRootPath)
        {
            var filePath = Path.Combine(envContentRootPath, "app-config.json");
            var currentSettings = new GeneralAppSettings();
            if (File.Exists(filePath))
            {
                var existingJson = await File.ReadAllTextAsync(filePath);
                try
                {
                    currentSettings = System.Text.Json.JsonSerializer.Deserialize<GeneralAppSettings>(existingJson) ?? new GeneralAppSettings();
                }
                catch { }
            }

            currentSettings.AppimsBackupPath = settings.AppimsBackupPath;

            var json = System.Text.Json.JsonSerializer.Serialize(currentSettings, new System.Text.Json.JsonSerializerOptions { WriteIndented = true });
            await File.WriteAllTextAsync(filePath, json);
        }

        public async Task<string> BackupAppimsDbAsync(string envContentRootPath)
        {
            var settings = await GetAppimsSettingsAsync(envContentRootPath);
            if (string.IsNullOrEmpty(settings.AppimsBackupPath))
            {
                throw new InvalidOperationException("Path backup kosong. Harap atur path folder backup AppIMS terlebih dahulu!");
            }

            var dbName = GetDatabaseName(ConfigConnectionString);
            var path = settings.AppimsBackupPath.Trim().TrimEnd('\\').TrimEnd('/');
            var dateStr = DateTime.Now.ToString("yyyyMMdd_HHmmss");
            var filename = $"{dbName}_{dateStr}.bak";
            var fullBackupFilePath = $"{path}\\{filename}";

            using var conn = new SqlConnection(ConfigConnectionString);
            await conn.OpenAsync();

            var backupSql = "BACKUP DATABASE [" + dbName + "] TO DISK = @BackupPath WITH COMPRESSION, INIT, STATS = 10;";
            await conn.ExecuteAsync(backupSql, new { BackupPath = fullBackupFilePath }, commandTimeout: 300);

            return filename;
        }

        public async Task<IEnumerable<string>> GetAppimsBackupFilesAsync(string envContentRootPath)
        {
            var settings = await GetAppimsSettingsAsync(envContentRootPath);
            if (string.IsNullOrEmpty(settings.AppimsBackupPath))
            {
                throw new InvalidOperationException("Path backup kosong. Harap atur path folder backup AppIMS terlebih dahulu!");
            }

            var path = settings.AppimsBackupPath.Trim().TrimEnd('\\').TrimEnd('/');
            using var conn = new SqlConnection(ConfigConnectionString);
            await conn.OpenAsync();

            var sql = @"
                DECLARE @Path NVARCHAR(500) = @BackupPath;
                IF OBJECT_ID('tempdb..#Files') IS NOT NULL DROP TABLE #Files;
                CREATE TABLE #Files (
                    subdirectory NVARCHAR(512),
                    depth INT,
                    [file] BIT
                );
                INSERT INTO #Files (subdirectory, depth, [file])
                EXEC master.sys.xp_dirtree @Path, 1, 1;
                SELECT subdirectory AS Filename FROM #Files WHERE [file] = 1 AND subdirectory LIKE '%.bak' ORDER BY subdirectory DESC;
                DROP TABLE #Files;";

            return await conn.QueryAsync<string>(sql, new { BackupPath = path });
        }

        public async Task RestoreAppimsDbAsync(RestoreRequest request, string envContentRootPath)
        {
            var settings = await GetAppimsSettingsAsync(envContentRootPath);
            if (string.IsNullOrEmpty(settings.AppimsBackupPath))
            {
                throw new InvalidOperationException("Path backup kosong. Harap atur path folder backup AppIMS terlebih dahulu!");
            }

            var dbName = GetDatabaseName(ConfigConnectionString);
            var path = settings.AppimsBackupPath.Trim().TrimEnd('\\').TrimEnd('/');
            var fullBackupFilePath = $"{path}\\{request.BackupFilename}";

            var restoreDbName = string.IsNullOrEmpty(request.RestoreDbName) ? dbName : request.RestoreDbName.Trim();
            var isNewDb = !string.Equals(restoreDbName, dbName, StringComparison.OrdinalIgnoreCase);

            var masterConnStr = GetMasterConnectionString(ConfigConnectionString);
            using var masterConn = new SqlConnection(masterConnStr);
            await masterConn.OpenAsync();

            if (!isNewDb)
            {
                await masterConn.ExecuteAsync($"IF EXISTS (SELECT * FROM sys.databases WHERE name = @DbName) ALTER DATABASE [{restoreDbName}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE;", new { DbName = restoreDbName });
                try
                {
                    await masterConn.ExecuteAsync($"RESTORE DATABASE [{restoreDbName}] FROM DISK = @BackupPath WITH REPLACE;", new { BackupPath = fullBackupFilePath }, commandTimeout: 300);
                }
                finally
                {
                    await masterConn.ExecuteAsync($"IF EXISTS (SELECT * FROM sys.databases WHERE name = @DbName) ALTER DATABASE [{restoreDbName}] SET MULTI_USER;", new { DbName = restoreDbName });
                }
            }
            else
            {
                var files = (await masterConn.QueryAsync("RESTORE FILELISTONLY FROM DISK = @BackupPath;", new { BackupPath = fullBackupFilePath })).ToList();
                var moveClauses = new List<string>();
                var paramDict = new Dictionary<string, object> { { "BackupPath", fullBackupFilePath } };

                int fileIdx = 0;
                foreach (var file in files)
                {
                    string logicalName = (string)file.LogicalName;
                    string physicalName = (string)file.PhysicalName;
                    string type = (string)file.Type;

                    var lastBackslash = physicalName.LastIndexOf('\\');
                    var dir = lastBackslash >= 0 ? physicalName.Substring(0, lastBackslash) : "C:\\backup";
                    
                    var ext = type.Equals("L", StringComparison.OrdinalIgnoreCase) ? "_log.ldf" : ".mdf";
                    var suffix = fileIdx > 0 && !type.Equals("L", StringComparison.OrdinalIgnoreCase) ? $"_{fileIdx}" : "";
                    var newPhysicalName = $"{dir}\\{restoreDbName}{suffix}{ext}";

                    moveClauses.Add($"MOVE @LogicalName_{fileIdx} TO @PhysicalName_{fileIdx}");
                    paramDict.Add($"LogicalName_{fileIdx}", logicalName);
                    paramDict.Add($"PhysicalName_{fileIdx}", newPhysicalName);
                    fileIdx++;
                }

                var restoreSql = $"RESTORE DATABASE [{restoreDbName}] FROM DISK = @BackupPath WITH REPLACE, {string.Join(",\n", moveClauses)};";
                await masterConn.ExecuteAsync(restoreSql, paramDict, commandTimeout: 300);
            }
        }

        public async Task<string> BackupJobDbAsync(int jobId)
        {
            using var configConn = new SqlConnection(ConfigConnectionString);
            var job = await configConn.QuerySingleOrDefaultAsync<MigrationJob>("SELECT * FROM dbo.MigrationJobs WHERE Id = @Id", new { Id = jobId });
            if (job == null) throw new ArgumentException("Job tidak ditemukan");

            if (string.IsNullOrEmpty(job.BackupPath)) throw new InvalidOperationException("Path backup kosong di konfigurasi Job!");
            if (string.IsNullOrEmpty(job.TargetConnectionString)) throw new InvalidOperationException("Target Connection String kosong!");

            var targetDb = GetDatabaseName(job.TargetConnectionString);
            var path = job.BackupPath.Trim().TrimEnd('\\').TrimEnd('/');
            var dateStr = DateTime.Now.ToString("yyyyMMdd_HHmmss");
            var filename = $"{targetDb}_{dateStr}.bak";
            var fullBackupFilePath = $"{path}\\{filename}";

            using var targetConn = new SqlConnection(job.TargetConnectionString);
            await targetConn.OpenAsync();

            var backupSql = "BACKUP DATABASE [" + targetDb + "] TO DISK = @BackupPath WITH COMPRESSION, INIT, STATS = 10;";
            await targetConn.ExecuteAsync(backupSql, new { BackupPath = fullBackupFilePath }, commandTimeout: 300);

            return filename;
        }

        public async Task<IEnumerable<string>> GetJobBackupFilesAsync(int jobId)
        {
            using var configConn = new SqlConnection(ConfigConnectionString);
            var job = await configConn.QuerySingleOrDefaultAsync<MigrationJob>("SELECT * FROM dbo.MigrationJobs WHERE Id = @Id", new { Id = jobId });
            if (job == null) throw new ArgumentException("Job tidak ditemukan");

            if (string.IsNullOrEmpty(job.BackupPath)) throw new InvalidOperationException("Path backup kosong di konfigurasi Job!");
            if (string.IsNullOrEmpty(job.TargetConnectionString)) throw new InvalidOperationException("Target Connection String kosong!");

            var path = job.BackupPath.Trim().TrimEnd('\\').TrimEnd('/');

            using var targetConn = new SqlConnection(job.TargetConnectionString);
            await targetConn.OpenAsync();

            var sql = @"
                DECLARE @Path NVARCHAR(500) = @BackupPath;
                IF OBJECT_ID('tempdb..#Files') IS NOT NULL DROP TABLE #Files;
                CREATE TABLE #Files (
                    subdirectory NVARCHAR(512),
                    depth INT,
                    [file] BIT
                );
                INSERT INTO #Files (subdirectory, depth, [file])
                EXEC master.sys.xp_dirtree @Path, 1, 1;
                SELECT subdirectory AS Filename FROM #Files WHERE [file] = 1 AND subdirectory LIKE '%.bak' ORDER BY subdirectory DESC;
                DROP TABLE #Files;";

            return await targetConn.QueryAsync<string>(sql, new { BackupPath = path });
        }

        public async Task RestoreJobDbAsync(int jobId, RestoreRequest request)
        {
            using var configConn = new SqlConnection(ConfigConnectionString);
            var job = await configConn.QuerySingleOrDefaultAsync<MigrationJob>("SELECT * FROM dbo.MigrationJobs WHERE Id = @Id", new { Id = jobId });
            if (job == null) throw new ArgumentException("Job tidak ditemukan");

            if (string.IsNullOrEmpty(job.BackupPath)) throw new InvalidOperationException("Path backup kosong di konfigurasi Job!");
            if (string.IsNullOrEmpty(job.TargetConnectionString)) throw new InvalidOperationException("Target Connection String kosong!");

            var targetDb = GetDatabaseName(job.TargetConnectionString);
            var path = job.BackupPath.Trim().TrimEnd('\\').TrimEnd('/');
            var fullBackupFilePath = $"{path}\\{request.BackupFilename}";

            var restoreDbName = string.IsNullOrEmpty(request.RestoreDbName) ? targetDb : request.RestoreDbName.Trim();
            var isNewDb = !string.Equals(restoreDbName, targetDb, StringComparison.OrdinalIgnoreCase);

            var masterConnStr = GetMasterConnectionString(job.TargetConnectionString);
            using var masterConn = new SqlConnection(masterConnStr);
            await masterConn.OpenAsync();

            if (!isNewDb)
            {
                await masterConn.ExecuteAsync($"IF EXISTS (SELECT * FROM sys.databases WHERE name = @DbName) ALTER DATABASE [{restoreDbName}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE;", new { DbName = restoreDbName });
                try
                {
                    await masterConn.ExecuteAsync($"RESTORE DATABASE [{restoreDbName}] FROM DISK = @BackupPath WITH REPLACE;", new { BackupPath = fullBackupFilePath }, commandTimeout: 300);
                }
                finally
                {
                    await masterConn.ExecuteAsync($"IF EXISTS (SELECT * FROM sys.databases WHERE name = @DbName) ALTER DATABASE [{restoreDbName}] SET MULTI_USER;", new { DbName = restoreDbName });
                }
            }
            else
            {
                var files = (await masterConn.QueryAsync("RESTORE FILELISTONLY FROM DISK = @BackupPath;", new { BackupPath = fullBackupFilePath })).ToList();
                var moveClauses = new List<string>();
                var paramDict = new Dictionary<string, object> { { "BackupPath", fullBackupFilePath } };

                int fileIdx = 0;
                foreach (var file in files)
                {
                    string logicalName = (string)file.LogicalName;
                    string physicalName = (string)file.PhysicalName;
                    string type = (string)file.Type;

                    var lastBackslash = physicalName.LastIndexOf('\\');
                    var dir = lastBackslash >= 0 ? physicalName.Substring(0, lastBackslash) : "C:\\backup";
                    
                    var ext = type.Equals("L", StringComparison.OrdinalIgnoreCase) ? "_log.ldf" : ".mdf";
                    var suffix = fileIdx > 0 && !type.Equals("L", StringComparison.OrdinalIgnoreCase) ? $"_{fileIdx}" : "";
                    var newPhysicalName = $"{dir}\\{restoreDbName}{suffix}{ext}";

                    moveClauses.Add($"MOVE @LogicalName_{fileIdx} TO @PhysicalName_{fileIdx}");
                    paramDict.Add($"LogicalName_{fileIdx}", logicalName);
                    paramDict.Add($"PhysicalName_{fileIdx}", newPhysicalName);
                    fileIdx++;
                }

                var restoreSql = $"RESTORE DATABASE [{restoreDbName}] FROM DISK = @BackupPath WITH REPLACE, {string.Join(",\n", moveClauses)};";
                await masterConn.ExecuteAsync(restoreSql, paramDict, commandTimeout: 300);
            }
        }

        #endregion

        #region Import & Export Job Settings

        public async Task<ExportJobDto> ExportJobAsync(int id)
        {
            using var conn = new SqlConnection(ConfigConnectionString);
            var job = await conn.QuerySingleOrDefaultAsync<MigrationJob>("SELECT * FROM dbo.MigrationJobs WHERE Id = @Id", new { Id = id });
            if (job == null) throw new ArgumentException("Job tidak ditemukan");

            var tables = (await conn.QueryAsync<TableMapping>("SELECT * FROM dbo.TableMappings WHERE JobId = @JobId", new { JobId = id })).ToList();
            
            var export = new ExportJobDto
            {
                JobName = job.JobName,
                SourceConnectionString = job.SourceConnectionString,
                TargetConnectionString = job.TargetConnectionString,
                PostMigrationScript = job.PostMigrationScript,
                TableMappings = new List<ExportTableMappingDto>()
            };

            foreach (var t in tables)
            {
                var columns = await conn.QueryAsync<ColumnMapping>("SELECT * FROM dbo.ColumnMappings WHERE TableMappingId = @TableMappingId", new { TableMappingId = t.Id });
                
                var tDto = new ExportTableMappingDto
                {
                    SourceTableName = t.SourceTableName,
                    TargetTableName = t.TargetTableName,
                    ExecutionOrder = t.ExecutionOrder,
                    TruncateTarget = t.TruncateTarget,
                    IsEnabled = t.IsEnabled,
                    PostMigrationScript = t.PostMigrationScript,
                    MappingMode = t.MappingMode,
                    NativeSqlScript = t.NativeSqlScript,
                    WhereClause = t.WhereClause,
                    Columns = columns.Select(c => new ExportColumnMappingDto
                    {
                        SourceColumnName = c.SourceColumnName,
                        TargetColumnName = c.TargetColumnName,
                        MappingType = c.MappingType,
                        ConstantValue = c.ConstantValue,
                        LookupTable = c.LookupTable,
                        LookupKeyColumn = c.LookupKeyColumn,
                        LookupValueColumn = c.LookupValueColumn,
                        ExpressionSQL = c.ExpressionSQL,
                        IfNullAction = c.IfNullAction,
                        IfNullParam = c.IfNullParam
                    }).ToList()
                };
                export.TableMappings.Add(tDto);
            }

            return export;
        }

        public async Task<MigrationJob> ImportJobAsync(ExportJobDto import)
        {
            if (import == null || string.IsNullOrEmpty(import.JobName))
            {
                throw new ArgumentException("Data import tidak valid");
            }

            using var conn = new SqlConnection(ConfigConnectionString);
            await conn.OpenAsync();
            using var transaction = conn.BeginTransaction();

            try
            {
                string jobName = import.JobName;
                var existingJob = await conn.QueryFirstOrDefaultAsync<int?>(
                    "SELECT TOP 1 Id FROM dbo.MigrationJobs WHERE JobName = @JobName", 
                    new { JobName = jobName }, transaction);
                
                if (existingJob != null)
                {
                    jobName += " - Imported";
                }

                int newJobId = await conn.QuerySingleAsync<int>(@"
                    INSERT INTO dbo.MigrationJobs (JobName, SourceConnectionString, TargetConnectionString, PostMigrationScript)
                    VALUES (@JobName, @SourceConnectionString, @TargetConnectionString, @PostMigrationScript);
                    SELECT CAST(SCOPE_IDENTITY() as int);",
                    new { JobName = jobName, SourceConnectionString = import.SourceConnectionString, TargetConnectionString = import.TargetConnectionString, PostMigrationScript = import.PostMigrationScript },
                    transaction);

                foreach (var t in import.TableMappings)
                {
                    int newTableMappingId = await conn.QuerySingleAsync<int>(@"
                        INSERT INTO dbo.TableMappings (JobId, SourceTableName, TargetTableName, ExecutionOrder, TruncateTarget, IsEnabled, PostMigrationScript, MappingMode, NativeSqlScript, WhereClause)
                        VALUES (@JobId, @SourceTableName, @TargetTableName, @ExecutionOrder, @TruncateTarget, @IsEnabled, @PostMigrationScript, @MappingMode, @NativeSqlScript, @WhereClause);
                        SELECT CAST(SCOPE_IDENTITY() as int);",
                        new { JobId = newJobId, SourceTableName = t.SourceTableName, TargetTableName = t.TargetTableName, ExecutionOrder = t.ExecutionOrder, TruncateTarget = t.TruncateTarget, IsEnabled = t.IsEnabled, PostMigrationScript = t.PostMigrationScript, MappingMode = string.IsNullOrWhiteSpace(t.MappingMode) ? "TABLE" : t.MappingMode, NativeSqlScript = t.NativeSqlScript, WhereClause = t.WhereClause },
                        transaction);

                    foreach (var c in t.Columns)
                    {
                        await conn.ExecuteAsync(@"
                            INSERT INTO dbo.ColumnMappings (TableMappingId, SourceColumnName, TargetColumnName, MappingType, ConstantValue, LookupTable, LookupKeyColumn, LookupValueColumn, ExpressionSQL, IfNullAction, IfNullParam)
                            VALUES (@TableMappingId, @SourceColumnName, @TargetColumnName, @MappingType, @ConstantValue, @LookupTable, @LookupKeyColumn, @LookupValueColumn, @ExpressionSQL, @IfNullAction, @IfNullParam)",
                            new 
                            { 
                                TableMappingId = newTableMappingId, 
                                SourceColumnName = c.SourceColumnName, 
                                TargetColumnName = c.TargetColumnName, 
                                MappingType = c.MappingType, 
                                ConstantValue = c.ConstantValue, 
                                LookupTable = c.LookupTable, 
                                LookupKeyColumn = c.LookupKeyColumn, 
                                LookupValueColumn = c.LookupValueColumn, 
                                ExpressionSQL = c.ExpressionSQL,
                                IfNullAction = c.IfNullAction,
                                IfNullParam = c.IfNullParam
                            },
                            transaction);
                    }
                }

                transaction.Commit();
                
                return new MigrationJob
                {
                    Id = newJobId,
                    JobName = jobName,
                    SourceConnectionString = import.SourceConnectionString,
                    TargetConnectionString = import.TargetConnectionString,
                    PostMigrationScript = import.PostMigrationScript
                };
            }
            catch
            {
                transaction.Rollback();
                throw;
            }
        }

        #endregion

        #region Migration Logs

        public async Task<IEnumerable<MigrationLog>> GetMigrationLogsAsync(int jobId)
        {
            using var conn = new SqlConnection(ConfigConnectionString);
            return await conn.QueryAsync<MigrationLog>(
                "SELECT TOP 100 * FROM dbo.MigrationLogs WHERE JobId = @JobId ORDER BY StartTime DESC", new { JobId = jobId });
        }

        #endregion

        #region DB Objects Scanning & Items

        public async Task<IEnumerable<dynamic>> ScanDbObjectsAsync(int jobId)
        {
            using var configConn = new SqlConnection(ConfigConnectionString);
            var job = await configConn.QuerySingleOrDefaultAsync<MigrationJob>(
                "SELECT * FROM dbo.MigrationJobs WHERE Id = @Id", new { Id = jobId });
            if (job == null) throw new ArgumentException("Job tidak ditemukan.");

            using var srcConn = new SqlConnection(job.SourceConnectionString);
            await srcConn.OpenAsync();
            return await srcConn.QueryAsync(@"
                SELECT 
                    SCHEMA_NAME(o.schema_id) + '.' + o.name AS ObjectName,
                    CASE o.type_desc 
                        WHEN 'SQL_STORED_PROCEDURE' THEN 'PROCEDURE'
                        WHEN 'SQL_SCALAR_FUNCTION' THEN 'FUNCTION'
                        WHEN 'SQL_TABLE_VALUED_FUNCTION' THEN 'FUNCTION'
                        WHEN 'SQL_INLINE_TABLE_VALUED_FUNCTION' THEN 'FUNCTION'
                        WHEN 'VIEW' THEN 'VIEW'
                        WHEN 'USER_TABLE' THEN 'TABLE'
                        ELSE o.type_desc
                    END AS ObjectType
                FROM sys.objects o
                WHERE o.type IN ('P','FN','IF','TF','V','U')
                  AND o.is_ms_shipped = 0
                ORDER BY 
                    CASE o.type WHEN 'U' THEN 1 WHEN 'V' THEN 2 WHEN 'P' THEN 3 ELSE 4 END,
                    o.name");
        }

        public async Task<IEnumerable<ObjectMigrationItem>> GetObjItemsAsync(int jobId)
        {
            using var conn = new SqlConnection(ConfigConnectionString);
            return await conn.QueryAsync<ObjectMigrationItem>(
                "SELECT * FROM dbo.ObjectMigrationItems WHERE JobId = @JobId ORDER BY ExecutionOrder ASC", new { JobId = jobId });
        }

        public async Task ReorderObjItemsAsync(int jobId, List<ReorderItemDto> items)
        {
            using var conn = new SqlConnection(ConfigConnectionString);
            await conn.OpenAsync();
            using var transaction = conn.BeginTransaction();
            try
            {
                foreach (var item in items)
                {
                    await conn.ExecuteAsync(@"
                        UPDATE dbo.ObjectMigrationItems
                        SET ExecutionOrder = @ExecutionOrder
                        WHERE Id = @Id AND JobId = @JobId",
                        new { item.Id, item.ExecutionOrder, JobId = jobId }, transaction);
                }
                transaction.Commit();
            }
            catch
            {
                transaction.Rollback();
                throw;
            }
        }

        public async Task<ObjectMigrationItem> SaveObjItemAsync(ObjectMigrationItem item)
        {
            using var conn = new SqlConnection(ConfigConnectionString);
            if (item.Id > 0)
            {
                await conn.ExecuteAsync(@"
                    UPDATE dbo.ObjectMigrationItems 
                    SET ObjectName = @ObjectName, ObjectType = @ObjectType, NativeSqlScript = @NativeSqlScript,
                        ExecutionOrder = @ExecutionOrder, IsEnabled = @IsEnabled, AllowDropColumns = @AllowDropColumns
                    WHERE Id = @Id", item);
                return item;
            }
            else
            {
                if (item.ExecutionOrder <= 0)
                {
                    var maxOrder = await conn.QueryFirstOrDefaultAsync<int?>(
                        "SELECT MAX(ExecutionOrder) FROM dbo.ObjectMigrationItems WHERE JobId = @JobId", new { JobId = item.JobId });
                    item.ExecutionOrder = (maxOrder ?? 0) + 1;
                }

                int newId = await conn.QuerySingleAsync<int>(@"
                    INSERT INTO dbo.ObjectMigrationItems (JobId, ObjectName, ObjectType, NativeSqlScript, ExecutionOrder, IsEnabled, AllowDropColumns)
                    VALUES (@JobId, @ObjectName, @ObjectType, @NativeSqlScript, @ExecutionOrder, @IsEnabled, @AllowDropColumns);
                    SELECT CAST(SCOPE_IDENTITY() as int);", item);
                item.Id = newId;
                return item;
            }
        }

        public async Task BulkAddObjItemsAsync(int jobId, List<ObjectMigrationItem> items)
        {
            using var conn = new SqlConnection(ConfigConnectionString);
            await conn.OpenAsync();
            int order = 1;
            foreach (var item in items)
            {
                item.JobId = jobId;
                item.ExecutionOrder = order++;
                item.IsEnabled = true;
                item.AllowDropColumns = false;
                await conn.ExecuteAsync(@"
                    IF NOT EXISTS (SELECT 1 FROM dbo.ObjectMigrationItems WHERE JobId = @JobId AND ObjectName = @ObjectName AND ObjectType = @ObjectType)
                    INSERT INTO dbo.ObjectMigrationItems (JobId, ObjectName, ObjectType, NativeSqlScript, ExecutionOrder, IsEnabled, AllowDropColumns)
                    VALUES (@JobId, @ObjectName, @ObjectType, @NativeSqlScript, @ExecutionOrder, @IsEnabled, @AllowDropColumns);", item);
            }
        }

        public async Task DeleteObjItemAsync(int id)
        {
            using var conn = new SqlConnection(ConfigConnectionString);
            await conn.ExecuteAsync("DELETE FROM dbo.ObjectMigrationItems WHERE Id = @Id", new { Id = id });
        }

        #endregion

        #region DB Objects Definition & Backups

        public async Task<IEnumerable<ObjectMigrationBackup>> GetObjBackupsAsync(int itemId)
        {
            using var conn = new SqlConnection(ConfigConnectionString);
            return await conn.QueryAsync<ObjectMigrationBackup>(
                "SELECT * FROM dbo.ObjectMigrationBackups WHERE ItemId = @ItemId ORDER BY Version DESC", new { ItemId = itemId });
        }

        public async Task<dynamic> GetObjBackupDownloadDataAsync(int backupId)
        {
            using var conn = new SqlConnection(ConfigConnectionString);
            var backup = await conn.QuerySingleOrDefaultAsync<dynamic>(
                @"SELECT b.BackupScript, b.Version, b.BackedUpAt, i.ObjectName 
                  FROM dbo.ObjectMigrationBackups b
                  JOIN dbo.ObjectMigrationItems i ON b.ItemId = i.Id
                  WHERE b.Id = @Id", new { Id = backupId });
            return backup;
        }

        public async Task<dynamic> GetObjItemDefinitionAsync(int jobId, int itemId)
        {
            using var configConn = new SqlConnection(ConfigConnectionString);
            var job = await configConn.QuerySingleOrDefaultAsync<MigrationJob>("SELECT * FROM dbo.MigrationJobs WHERE Id = @Id", new { Id = jobId });
            if (job == null) throw new ArgumentException("Job tidak ditemukan");

            var item = await configConn.QuerySingleOrDefaultAsync<ObjectMigrationItem>(
                "SELECT * FROM dbo.ObjectMigrationItems WHERE Id = @Id AND JobId = @JobId", new { Id = itemId, JobId = jobId });
            if (item == null) throw new ArgumentException("Objek tidak ditemukan");

            using var sourceConn = new SqlConnection(job.SourceConnectionString);
            using var targetConn = new SqlConnection(job.TargetConnectionString);
            await sourceConn.OpenAsync();
            await targetConn.OpenAsync();

            string sourceDdl = await LoadSingleObjectDdlHelper(sourceConn, item.ObjectName, item.ObjectType);
            string targetDdl = "";
            try
            {
                targetDdl = await LoadSingleObjectDdlHelper(targetConn, item.ObjectName, item.ObjectType);
            }
            catch
            {
                targetDdl = "-- Objek tidak ditemukan di Target DB --";
            }

            return new
            {
                ObjectName = item.ObjectName,
                ObjectType = item.ObjectType,
                SourceDdl = sourceDdl,
                TargetDdl = targetDdl
            };
        }

        public async Task<IEnumerable<ObjectMigrationLog>> GetObjLogsAsync(int jobId)
        {
            using var conn = new SqlConnection(ConfigConnectionString);
            return await conn.QueryAsync<ObjectMigrationLog>(
                "SELECT TOP 200 * FROM dbo.ObjectMigrationLogs WHERE JobId = @JobId ORDER BY ExecutedAt DESC", new { JobId = jobId });
        }

        #endregion

        #region Run Object Migration

        public async Task<List<object>> RunObjMigrationAsync(int jobId, int? itemId)
        {
            using var configConn = new SqlConnection(ConfigConnectionString);
            await configConn.OpenAsync();

            var job = await configConn.QuerySingleOrDefaultAsync<MigrationJob>(
                "SELECT * FROM dbo.MigrationJobs WHERE Id = @Id", new { Id = jobId });
            if (job == null) throw new ArgumentException("Job tidak ditemukan.");

            List<ObjectMigrationItem> items;
            if (itemId.HasValue)
            {
                items = (await configConn.QueryAsync<ObjectMigrationItem>(
                    "SELECT * FROM dbo.ObjectMigrationItems WHERE Id = @Id AND JobId = @JobId AND IsEnabled = 1",
                    new { Id = itemId.Value, JobId = jobId })).ToList();
            }
            else
            {
                items = (await configConn.QueryAsync<ObjectMigrationItem>(
                    "SELECT * FROM dbo.ObjectMigrationItems WHERE JobId = @JobId AND IsEnabled = 1 ORDER BY ExecutionOrder ASC",
                    new { JobId = jobId })).ToList();
            }

            var results = new List<object>();

            foreach (var item in items)
            {
                if (!itemId.HasValue && string.Equals(item.LastStatus, "Completed", StringComparison.OrdinalIgnoreCase))
                {
                    results.Add(new { ObjectName = item.ObjectName, Status = "Completed", Message = "Skipped (Already migrated)" });
                    continue;
                }

                try
                {
                    await configConn.ExecuteAsync(@"
                        UPDATE dbo.ObjectMigrationItems
                        SET LastStatus = 'InProgress', LastErrorMessage = NULL
                        WHERE Id = @Id", new { Id = item.Id });

                    if (item.ObjectType == "NATIVE_SQL")
                    {
                        using var targetConn = new SqlConnection(job.TargetConnectionString);
                        await targetConn.OpenAsync();

                        int nextVersion = (await configConn.QuerySingleOrDefaultAsync<int?>(
                            "SELECT MAX(Version) FROM dbo.ObjectMigrationBackups WHERE ItemId = @ItemId", new { ItemId = item.Id })) ?? 0;
                        nextVersion++;
                        await configConn.ExecuteAsync(@"
                            INSERT INTO dbo.ObjectMigrationBackups (ItemId, Version, BackupScript)
                            VALUES (@ItemId, @Version, @BackupScript)",
                            new { ItemId = item.Id, Version = nextVersion, BackupScript = $"-- Native SQL executed:\n{item.NativeSqlScript}" });

                        var nativeSql = ResolveNativeSqlScript(job, item.NativeSqlScript);
                        await targetConn.ExecuteAsync(nativeSql);

                        await configConn.ExecuteAsync(@"
                            INSERT INTO dbo.ObjectMigrationLogs (JobId, ObjectName, Action, Status)
                            VALUES (@JobId, @ObjectName, 'NATIVE_SQL', 'Completed')",
                            new { JobId = jobId, ObjectName = item.ObjectName });

                        results.Add(new { ObjectName = item.ObjectName, Status = "Completed", Message = "Native SQL executed successfully." });
                    }
                    else if (item.ObjectType == "TABLE")
                    {
                        await MigrateTableObject(configConn, job, item, jobId);
                        results.Add(new { ObjectName = item.ObjectName, Status = "Completed", Message = "Table synced." });
                    }
                    else
                    {
                        await MigrateCodeObject(configConn, job, item, jobId);
                        results.Add(new { ObjectName = item.ObjectName, Status = "Completed", Message = $"{item.ObjectType} migrated." });
                    }

                    await configConn.ExecuteAsync(@"
                        UPDATE dbo.ObjectMigrationItems
                        SET LastStatus = 'Completed', LastErrorMessage = NULL, LastRunAt = GETDATE()
                        WHERE Id = @Id", new { Id = item.Id });
                }
                catch (Exception ex)
                {
                    await configConn.ExecuteAsync(@"
                        INSERT INTO dbo.ObjectMigrationLogs (JobId, ObjectName, Action, Status, ErrorMessage)
                        VALUES (@JobId, @ObjectName, @Action, 'Failed', @ErrorMessage)",
                        new { JobId = jobId, ObjectName = item.ObjectName, Action = item.ObjectType, ErrorMessage = ex.Message });

                    await configConn.ExecuteAsync(@"
                        UPDATE dbo.ObjectMigrationItems
                        SET LastStatus = 'Failed', LastErrorMessage = @Error, LastRunAt = GETDATE()
                        WHERE Id = @Id", new { Error = ex.Message, Id = item.Id });

                    results.Add(new { ObjectName = item.ObjectName, Status = "Failed", Message = ex.Message });
                }
            }

            return results;
        }

        #endregion

        #region Clean Target Tables

        public async Task<IEnumerable<CleanTargetTable>> GetCleanTablesAsync(int jobId)
        {
            using var conn = new SqlConnection(ConfigConnectionString);
            return await conn.QueryAsync<CleanTargetTable>(
                "SELECT * FROM dbo.CleanTargetTables WHERE JobId = @JobId ORDER BY ExecutionOrder ASC", new { JobId = jobId });
        }

        public async Task<dynamic> AddCleanTablesAsync(int jobId, CleanTableRequest request)
        {
            if (request == null || string.IsNullOrWhiteSpace(request.TableNames))
            {
                throw new ArgumentException("Nama tabel tidak boleh kosong.");
            }

            using var conn = new SqlConnection(ConfigConnectionString);
            await conn.OpenAsync();

            var tableNames = request.TableNames
                .Split(new[] { ',', '\n', '\r' }, StringSplitOptions.RemoveEmptyEntries)
                .Select(t => t.Trim())
                .Where(t => !string.IsNullOrEmpty(t))
                .ToList();

            if (tableNames.Count == 0)
            {
                throw new ArgumentException("Nama tabel tidak valid.");
            }

            var addedTables = new List<string>();
            var skippedTables = new List<string>();

            using var transaction = conn.BeginTransaction();
            try
            {
                int maxOrder = await conn.QueryFirstOrDefaultAsync<int>(
                    "SELECT ISNULL(MAX(ExecutionOrder), 0) FROM dbo.CleanTargetTables WHERE JobId = @JobId", 
                    new { JobId = jobId }, transaction);

                foreach (var tableName in tableNames)
                {
                    var exists = await conn.QueryFirstOrDefaultAsync<int?>(
                        "SELECT TOP 1 Id FROM dbo.CleanTargetTables WHERE JobId = @JobId AND TableName = @TableName",
                        new { JobId = jobId, TableName = tableName }, transaction);

                    if (exists != null)
                    {
                        skippedTables.Add(tableName);
                        continue;
                    }

                    maxOrder++;
                    await conn.ExecuteAsync(@"
                        INSERT INTO dbo.CleanTargetTables (JobId, TableName, ExecutionOrder, LastStatus)
                        VALUES (@JobId, @TableName, @ExecutionOrder, 'Pending')",
                        new { JobId = jobId, TableName = tableName, ExecutionOrder = maxOrder }, transaction);

                    addedTables.Add(tableName);
                }

                transaction.Commit();
                return new { Added = addedTables, Skipped = skippedTables };
            }
            catch
            {
                transaction.Rollback();
                throw;
            }
        }

        public async Task DeleteCleanTableAsync(int id)
        {
            using var conn = new SqlConnection(ConfigConnectionString);
            await conn.ExecuteAsync("DELETE FROM dbo.CleanTargetTables WHERE Id = @Id", new { Id = id });
        }

        public async Task ReorderCleanTablesAsync(int jobId, List<ReorderItemDto> items)
        {
            using var conn = new SqlConnection(ConfigConnectionString);
            await conn.OpenAsync();
            using var transaction = conn.BeginTransaction();
            try
            {
                foreach (var item in items)
                {
                    await conn.ExecuteAsync(@"
                        UPDATE dbo.CleanTargetTables
                        SET ExecutionOrder = @ExecutionOrder
                        WHERE Id = @Id AND JobId = @JobId",
                        new { item.Id, item.ExecutionOrder, JobId = jobId }, transaction);
                }
                transaction.Commit();
            }
            catch
            {
                transaction.Rollback();
                throw;
            }
        }

        public async Task<List<object>> RunCleanTablesAsync(int jobId, int? id)
        {
            using var configConn = new SqlConnection(ConfigConnectionString);
            await configConn.OpenAsync();

            var job = await configConn.QuerySingleOrDefaultAsync<MigrationJob>(
                "SELECT * FROM dbo.MigrationJobs WHERE Id = @Id", new { Id = jobId });
            if (job == null) throw new ArgumentException("Job tidak ditemukan.");

            List<CleanTargetTable> tablesToClean;
            if (id.HasValue)
            {
                var singleTable = await configConn.QuerySingleOrDefaultAsync<CleanTargetTable>(
                    "SELECT * FROM dbo.CleanTargetTables WHERE Id = @Id AND JobId = @JobId", 
                    new { Id = id.Value, JobId = jobId });
                if (singleTable == null) throw new ArgumentException("Tabel tidak terdaftar dalam daftar pembersih.");
                tablesToClean = new List<CleanTargetTable> { singleTable };
            }
            else
            {
                tablesToClean = (await configConn.QueryAsync<CleanTargetTable>(
                    "SELECT * FROM dbo.CleanTargetTables WHERE JobId = @JobId ORDER BY ExecutionOrder ASC", 
                    new { JobId = jobId })).ToList();
            }

            if (tablesToClean.Count == 0)
            {
                throw new ArgumentException("Tidak ada tabel untuk dibersihkan.");
            }

            var results = new List<object>();

            using var targetConn = new SqlConnection(job.TargetConnectionString);
            await targetConn.OpenAsync();

            foreach (var table in tablesToClean)
            {
                if (!id.HasValue && string.Equals(table.LastStatus, "Completed", StringComparison.OrdinalIgnoreCase))
                {
                    results.Add(new { Id = table.Id, TableName = table.TableName, Status = "Completed", Message = "Skipped (Already cleaned)" });
                    continue;
                }

                try
                {
                    await configConn.ExecuteAsync(@"
                        UPDATE dbo.CleanTargetTables
                        SET LastStatus = 'InProgress', LastErrorMessage = NULL
                        WHERE Id = @Id", new { Id = table.Id });

                    var quotedTable = SafeQuoteTable(table.TableName);
                    var deleteQuery = $"DELETE FROM {quotedTable}";
                    await targetConn.ExecuteAsync(deleteQuery);

                    var hasIdentity = await targetConn.QueryFirstOrDefaultAsync<int?>(
                        $"SELECT OBJECTPROPERTY(OBJECT_ID('{quotedTable.Replace("'", "''")}'), 'TableHasIdentity')");

                    string msg = "Data deleted.";
                    if (hasIdentity == 1)
                    {
                        var reseedQuery = $"DBCC CHECKIDENT ('{quotedTable.Replace("'", "''")}', RESEED, 0)";
                        await targetConn.ExecuteAsync(reseedQuery);
                        msg = "Data deleted and Identity reseeded to 0.";
                    }

                    await configConn.ExecuteAsync(@"
                        UPDATE dbo.CleanTargetTables
                        SET LastStatus = 'Completed', LastErrorMessage = NULL, LastCleanedAt = GETDATE()
                        WHERE Id = @Id", new { Id = table.Id });

                    results.Add(new { Id = table.Id, TableName = table.TableName, Status = "Completed", Message = msg });
                }
                catch (Exception ex)
                {
                    await configConn.ExecuteAsync(@"
                        UPDATE dbo.CleanTargetTables
                        SET LastStatus = 'Failed', LastErrorMessage = @Error, LastCleanedAt = GETDATE()
                        WHERE Id = @Id", new { Error = ex.Message, Id = table.Id });

                    results.Add(new { Id = table.Id, TableName = table.TableName, Status = "Failed", Message = ex.Message });
                }
            }

            return results;
        }

        public async Task<(string SpName, string SqlScript)> GenerateCleanSpAsync(int jobId)
        {
            using var conn = new SqlConnection(ConfigConnectionString);
            var job = await conn.QuerySingleOrDefaultAsync<MigrationJob>(
                "SELECT * FROM dbo.MigrationJobs WHERE Id = @Id", new { Id = jobId });
            if (job == null) throw new ArgumentException($"Job {jobId} tidak ditemukan");

            var tables = (await conn.QueryAsync<CleanTargetTable>(
                "SELECT * FROM dbo.CleanTargetTables WHERE JobId = @JobId ORDER BY ExecutionOrder ASC", 
                new { JobId = jobId })).ToList();

            if (tables.Count == 0)
            {
                throw new ArgumentException("Tidak ada tabel terdaftar untuk dibersihkan pada Job ini.");
            }

            string targetDb = GetDatabaseName(job.TargetConnectionString);
            string spName = $"sp_CleanTarget_All_{jobId}";

            var sb = new System.Text.StringBuilder();
            sb.AppendLine($"-- ===========================================================================");
            sb.AppendLine($"-- STORED PROCEDURE: {spName}");
            sb.AppendLine($"-- Digenerate secara otomatis oleh DbMigrator.NET");
            sb.AppendLine($"-- Deskripsi: Membersihkan dan me-reseed seluruh tabel target terdaftar secara berurutan");
            sb.AppendLine($"-- Database Target: {targetDb}");
            sb.AppendLine($"-- Tanggal Generate: {DateTime.Now:yyyy-MM-dd HH:mm:ss}");
            sb.AppendLine($"-- ===========================================================================");
            sb.AppendLine($"CREATE OR ALTER PROCEDURE dbo.{spName}");
            sb.AppendLine("AS");
            sb.AppendLine("BEGIN");
            sb.AppendLine("    SET NOCOUNT ON;");
            sb.AppendLine("    BEGIN TRANSACTION;");
            sb.AppendLine("    BEGIN TRY");
            sb.AppendLine();

            int step = 1;
            foreach (var table in tables)
            {
                var quotedTable = SafeQuoteTable(table.TableName);
                sb.AppendLine($"        -- Langkah {step++}: Bersihkan tabel {table.TableName}");
                sb.AppendLine($"        DELETE FROM {quotedTable};");
                sb.AppendLine();
                sb.AppendLine($"        -- Reseed identity jika tabel memiliki kolom Identity");
                sb.AppendLine($"        IF OBJECTPROPERTY(OBJECT_ID('{quotedTable.Replace("'", "''")}'), 'TableHasIdentity') = 1");
                sb.AppendLine("        BEGIN");
                sb.AppendLine($"            DBCC CHECKIDENT ('{quotedTable.Replace("'", "''")}', RESEED, 0);");
                sb.AppendLine("        END");
                sb.AppendLine();
            }

            sb.AppendLine("        COMMIT TRANSACTION;");
            sb.AppendLine($"        PRINT 'Pembersihan seluruh ({tables.Count}) tabel sukses!';");
            sb.AppendLine("    END TRY");
            sb.AppendLine("    BEGIN CATCH");
            sb.AppendLine("        IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;");
            sb.AppendLine("        DECLARE @ErrorMessage NVARCHAR(4000) = ERROR_MESSAGE();");
            sb.AppendLine("        DECLARE @ErrorSeverity INT = ERROR_SEVERITY();");
            sb.AppendLine("        DECLARE @ErrorState INT = ERROR_STATE();");
            sb.AppendLine("        RAISERROR(@ErrorMessage, @ErrorSeverity, @ErrorState);");
            sb.AppendLine("    END CATCH");
            sb.AppendLine("END");

            return (spName, sb.ToString());
        }

        #endregion

        #region Reset Status

        public async Task ResetCleanTablesStatusAsync(int jobId)
        {
            using var conn = new SqlConnection(ConfigConnectionString);
            var job = await conn.QuerySingleOrDefaultAsync<MigrationJob>(
                "SELECT * FROM dbo.MigrationJobs WHERE Id = @Id", new { Id = jobId });
            if (job == null) throw new ArgumentException("Job tidak ditemukan.");

            await conn.ExecuteAsync(@"
                UPDATE dbo.CleanTargetTables
                SET LastStatus = 'Pending', LastErrorMessage = NULL, LastCleanedAt = NULL
                WHERE JobId = @JobId", new { JobId = jobId });
        }

        public async Task ResetDataMappingsStatusAsync(int jobId)
        {
            using var conn = new SqlConnection(ConfigConnectionString);
            var job = await conn.QuerySingleOrDefaultAsync<MigrationJob>(
                "SELECT * FROM dbo.MigrationJobs WHERE Id = @Id", new { Id = jobId });
            if (job == null) throw new ArgumentException("Job tidak ditemukan.");

            await conn.ExecuteAsync(@"
                UPDATE dbo.TableMappings
                SET LastStatus = 'Pending', LastErrorMessage = NULL, LastRunAt = NULL, LastRowsMigrated = 0
                WHERE JobId = @JobId", new { JobId = jobId });
        }

        public async Task ResetObjItemsStatusAsync(int jobId)
        {
            using var conn = new SqlConnection(ConfigConnectionString);
            var job = await conn.QuerySingleOrDefaultAsync<MigrationJob>(
                "SELECT * FROM dbo.MigrationJobs WHERE Id = @Id", new { Id = jobId });
            if (job == null) throw new ArgumentException("Job tidak ditemukan.");

            await conn.ExecuteAsync(@"
                UPDATE dbo.ObjectMigrationItems
                SET LastStatus = 'Pending', LastErrorMessage = NULL, LastRunAt = NULL
                WHERE JobId = @JobId", new { JobId = jobId });
        }

        #endregion

        #region Private Helpers

        private string SafeQuoteTable(string tableName)
        {
            if (string.IsNullOrWhiteSpace(tableName)) return tableName;
            var clean = tableName.Trim();
            if (clean.Contains('.'))
            {
                var parts = clean.Split('.');
                var quotedParts = parts.Select(p => {
                    var pClean = p.Trim('[', ']');
                    return $"[{pClean.Replace("]", "]]")}]";
                });
                return string.Join(".", quotedParts);
            }
            else
            {
                var pClean = clean.Trim('[', ']');
                return $"[{pClean.Replace("]", "]]")}]";
            }
        }

        private string ResolveNativeSqlScript(MigrationJob job, string script)
        {
            if (string.IsNullOrWhiteSpace(script)) return script;

            var sourceBuilder = new SqlConnectionStringBuilder(job.SourceConnectionString);
            var targetBuilder = new SqlConnectionStringBuilder(job.TargetConnectionString);
            var sourceDb = sourceBuilder.InitialCatalog;
            var targetDb = targetBuilder.InitialCatalog;

            var usesSourcePlaceholder =
                script.Contains("{{SOURCE_DB}}", StringComparison.OrdinalIgnoreCase) ||
                script.Contains("{{SOURCE_DATABASE}}", StringComparison.OrdinalIgnoreCase);

            if (usesSourcePlaceholder &&
                !string.Equals(NormalizeSqlDataSource(sourceBuilder.DataSource), NormalizeSqlDataSource(targetBuilder.DataSource), StringComparison.OrdinalIgnoreCase))
            {
                throw new InvalidOperationException("Native SQL Source DB ke Target DB hanya didukung otomatis jika Source dan Target berada di SQL Server instance yang sama. Untuk beda server, gunakan linked server di SQL Server lalu tulis nama linked server di script.");
            }

            return script
                .Replace("{{SOURCE_DB}}", QuoteSqlIdentifier(sourceDb), StringComparison.OrdinalIgnoreCase)
                .Replace("{{SOURCE_DATABASE}}", QuoteSqlIdentifier(sourceDb), StringComparison.OrdinalIgnoreCase)
                .Replace("{{TARGET_DB}}", QuoteSqlIdentifier(targetDb), StringComparison.OrdinalIgnoreCase)
                .Replace("{{TARGET_DATABASE}}", QuoteSqlIdentifier(targetDb), StringComparison.OrdinalIgnoreCase);
        }

        private string NormalizeSqlDataSource(string dataSource)
        {
            return (dataSource ?? string.Empty)
                .Trim()
                .Replace("tcp:", "", StringComparison.OrdinalIgnoreCase)
                .Replace(" ", "");
        }

        private string QuoteSqlIdentifier(string identifier)
        {
            if (string.IsNullOrWhiteSpace(identifier))
            {
                throw new InvalidOperationException("Connection string Source/Target harus memiliki nama database.");
            }
            return $"[{identifier.Replace("]", "]]")}]";
        }

        private async Task MigrateCodeObject(SqlConnection configConn, MigrationJob job, ObjectMigrationItem item, int jobId)
        {
            using var targetConn = new SqlConnection(job.TargetConnectionString);
            await targetConn.OpenAsync();

            string existingDef = await targetConn.QuerySingleOrDefaultAsync<string>(
                "SELECT OBJECT_DEFINITION(OBJECT_ID(@ObjName))", new { ObjName = item.ObjectName });

            if (!string.IsNullOrEmpty(existingDef))
            {
                int nextVersion = (await configConn.QuerySingleOrDefaultAsync<int?>(
                    "SELECT MAX(Version) FROM dbo.ObjectMigrationBackups WHERE ItemId = @ItemId", new { ItemId = item.Id })) ?? 0;
                nextVersion++;
                await configConn.ExecuteAsync(@"
                    INSERT INTO dbo.ObjectMigrationBackups (ItemId, Version, BackupScript)
                    VALUES (@ItemId, @Version, @BackupScript)",
                    new { ItemId = item.Id, Version = nextVersion, BackupScript = existingDef });

                await configConn.ExecuteAsync(@"
                    INSERT INTO dbo.ObjectMigrationLogs (JobId, ObjectName, Action, Status)
                    VALUES (@JobId, @ObjectName, 'BACKUP', 'Completed')",
                    new { JobId = jobId, ObjectName = item.ObjectName });
            }

            using var srcConn = new SqlConnection(job.SourceConnectionString);
            await srcConn.OpenAsync();

            string srcDef = await srcConn.QuerySingleOrDefaultAsync<string>(
                "SELECT OBJECT_DEFINITION(OBJECT_ID(@ObjName))", new { ObjName = item.ObjectName });

            if (string.IsNullOrEmpty(srcDef))
                throw new Exception($"Definisi objek '{item.ObjectName}' tidak ditemukan di Source DB.");

            string dropType = item.ObjectType switch
            {
                "PROCEDURE" => "PROCEDURE",
                "FUNCTION" => "FUNCTION",
                "VIEW" => "VIEW",
                _ => "PROCEDURE"
            };

            await targetConn.ExecuteAsync($"IF OBJECT_ID('{item.ObjectName}', '{dropType[0]}') IS NOT NULL DROP {dropType} [{item.ObjectName.Split('.').Last()}]");

            await configConn.ExecuteAsync(@"
                INSERT INTO dbo.ObjectMigrationLogs (JobId, ObjectName, Action, Status)
                VALUES (@JobId, @ObjectName, 'DROP', 'Completed')",
                new { JobId = jobId, ObjectName = item.ObjectName });

            await targetConn.ExecuteAsync(srcDef);

            await configConn.ExecuteAsync(@"
                INSERT INTO dbo.ObjectMigrationLogs (JobId, ObjectName, Action, Status)
                VALUES (@JobId, @ObjectName, 'CREATE', 'Completed')",
                new { JobId = jobId, ObjectName = item.ObjectName });
        }

        private async Task MigrateTableObject(SqlConnection configConn, MigrationJob job, ObjectMigrationItem item, int jobId)
        {
            using var targetConn = new SqlConnection(job.TargetConnectionString);
            await targetConn.OpenAsync();

            using var srcConn = new SqlConnection(job.SourceConnectionString);
            await srcConn.OpenAsync();

            var cleanName = item.ObjectName.Contains('.') ? item.ObjectName.Split('.').Last() : item.ObjectName;
            var schemaName = item.ObjectName.Contains('.') ? item.ObjectName.Split('.').First() : "dbo";

            bool tableExistsInTarget = (await targetConn.QuerySingleOrDefaultAsync<int>(
                "SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = @Schema AND TABLE_NAME = @Table",
                new { Schema = schemaName, Table = cleanName })) > 0;

            if (!tableExistsInTarget)
            {
                var sourceColumns = await srcConn.QueryAsync(@"
                    SELECT c.COLUMN_NAME, c.DATA_TYPE, c.CHARACTER_MAXIMUM_LENGTH, c.NUMERIC_PRECISION, c.NUMERIC_SCALE, c.IS_NULLABLE, c.COLUMN_DEFAULT
                    FROM INFORMATION_SCHEMA.COLUMNS c
                    WHERE c.TABLE_SCHEMA = @Schema AND c.TABLE_NAME = @Table
                    ORDER BY c.ORDINAL_POSITION",
                    new { Schema = schemaName, Table = cleanName });

                var colDefs = new List<string>();
                foreach (var col in sourceColumns)
                {
                    string typeDef = BuildColumnTypeDef(col);
                    colDefs.Add($"    [{col.COLUMN_NAME}] {typeDef}");
                }

                var pkCols = await srcConn.QueryAsync<string>(@"
                    SELECT c.COLUMN_NAME
                    FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
                    JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE c ON tc.CONSTRAINT_NAME = c.CONSTRAINT_NAME
                    WHERE tc.TABLE_SCHEMA = @Schema AND tc.TABLE_NAME = @Table AND tc.CONSTRAINT_TYPE = 'PRIMARY KEY'
                    ORDER BY c.ORDINAL_POSITION",
                    new { Schema = schemaName, Table = cleanName });

                var pkList = pkCols.ToList();
                if (pkList.Count > 0)
                {
                    colDefs.Add($"    CONSTRAINT [PK_{cleanName}] PRIMARY KEY ([{string.Join("], [", pkList)}])");
                }

                string createSql = $"CREATE TABLE [{schemaName}].[{cleanName}] (\n{string.Join(",\n", colDefs)}\n);";
                await targetConn.ExecuteAsync(createSql);

                await SyncIndexes(srcConn, targetConn, schemaName, cleanName);

                await configConn.ExecuteAsync(@"
                    INSERT INTO dbo.ObjectMigrationLogs (JobId, ObjectName, Action, Status)
                    VALUES (@JobId, @ObjectName, 'CREATE', 'Completed')",
                    new { JobId = jobId, ObjectName = item.ObjectName });
            }
            else
            {
                var backupScript = await GenerateTableBackupScript(targetConn, schemaName, cleanName);
                int nextVersion = (await configConn.QuerySingleOrDefaultAsync<int?>(
                    "SELECT MAX(Version) FROM dbo.ObjectMigrationBackups WHERE ItemId = @ItemId", new { ItemId = item.Id })) ?? 0;
                nextVersion++;
                await configConn.ExecuteAsync(@"
                    INSERT INTO dbo.ObjectMigrationBackups (ItemId, Version, BackupScript)
                    VALUES (@ItemId, @Version, @BackupScript)",
                    new { ItemId = item.Id, Version = nextVersion, BackupScript = backupScript });

                await configConn.ExecuteAsync(@"
                    INSERT INTO dbo.ObjectMigrationLogs (JobId, ObjectName, Action, Status)
                    VALUES (@JobId, @ObjectName, 'BACKUP', 'Completed')",
                    new { JobId = jobId, ObjectName = item.ObjectName });

                var srcCols = (await srcConn.QueryAsync(@"
                    SELECT COLUMN_NAME, DATA_TYPE, CHARACTER_MAXIMUM_LENGTH, NUMERIC_PRECISION, NUMERIC_SCALE, IS_NULLABLE, COLUMN_DEFAULT
                    FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = @Schema AND TABLE_NAME = @Table
                    ORDER BY ORDINAL_POSITION",
                    new { Schema = schemaName, Table = cleanName })).ToList();

                var tgtCols = (await targetConn.QueryAsync(@"
                    SELECT COLUMN_NAME, DATA_TYPE, CHARACTER_MAXIMUM_LENGTH, NUMERIC_PRECISION, NUMERIC_SCALE, IS_NULLABLE, COLUMN_DEFAULT
                    FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = @Schema AND TABLE_NAME = @Table
                    ORDER BY ORDINAL_POSITION",
                    new { Schema = schemaName, Table = cleanName })).ToList();

                var srcColNames = srcCols.Select(c => (string)c.COLUMN_NAME).ToList();
                var tgtColNames = tgtCols.Select(c => (string)c.COLUMN_NAME).ToList();

                foreach (var srcCol in srcCols)
                {
                    string colName = srcCol.COLUMN_NAME;
                    if (!tgtColNames.Contains(colName, StringComparer.OrdinalIgnoreCase))
                    {
                        string typeDef = BuildColumnTypeDef(srcCol);
                        await targetConn.ExecuteAsync($"ALTER TABLE [{schemaName}].[{cleanName}] ADD [{colName}] {typeDef}");
                    }
                }

                if (item.AllowDropColumns)
                {
                    foreach (var tgtCol in tgtCols)
                    {
                        string colName = tgtCol.COLUMN_NAME;
                        if (!srcColNames.Contains(colName, StringComparer.OrdinalIgnoreCase))
                        {
                            try
                            {
                                await targetConn.ExecuteAsync($"ALTER TABLE [{schemaName}].[{cleanName}] DROP COLUMN [{colName}]");
                            }
                            catch { }
                        }
                    }
                }

                await SyncIndexes(srcConn, targetConn, schemaName, cleanName);

                await configConn.ExecuteAsync(@"
                    INSERT INTO dbo.ObjectMigrationLogs (JobId, ObjectName, Action, Status)
                    VALUES (@JobId, @ObjectName, 'ALTER', 'Completed')",
                    new { JobId = jobId, ObjectName = item.ObjectName });
            }
        }

        private string BuildColumnTypeDef(dynamic col)
        {
            string dataType = col.DATA_TYPE;
            string typeDef = dataType;
            int? maxLen = col.CHARACTER_MAXIMUM_LENGTH;
            int? numPrec = col.NUMERIC_PRECISION;
            int? numScale = col.NUMERIC_SCALE;
            string isNullable = col.IS_NULLABLE;

            if (dataType is "varchar" or "nvarchar" or "char" or "nchar" or "varbinary")
            {
                typeDef = maxLen == -1 ? $"{dataType}(MAX)" : $"{dataType}({maxLen})";
            }
            else if (dataType is "decimal" or "numeric")
            {
                typeDef = $"{dataType}({numPrec},{numScale})";
            }

            typeDef += isNullable == "YES" ? " NULL" : " NOT NULL";
            return typeDef;
        }

        private async Task<string> GenerateTableBackupScript(SqlConnection conn, string schema, string table)
        {
            var sb = new System.Text.StringBuilder();
            sb.AppendLine($"-- Backup of [{schema}].[{table}] at {DateTime.Now:yyyy-MM-dd HH:mm:ss}");
            sb.AppendLine();

            var columns = await conn.QueryAsync(@"
                SELECT COLUMN_NAME, DATA_TYPE, CHARACTER_MAXIMUM_LENGTH, NUMERIC_PRECISION, NUMERIC_SCALE, IS_NULLABLE, COLUMN_DEFAULT
                FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = @Schema AND TABLE_NAME = @Table
                ORDER BY ORDINAL_POSITION",
                new { Schema = schema, Table = table });

            var colDefs = new List<string>();
            foreach (var col in columns)
            {
                string typeDef = BuildColumnTypeDef(col);
                string defaultClause = !string.IsNullOrEmpty((string)col.COLUMN_DEFAULT) ? $" DEFAULT {col.COLUMN_DEFAULT}" : "";
                colDefs.Add($"    [{col.COLUMN_NAME}] {typeDef}{defaultClause}");
            }

            var pkCols = await conn.QueryAsync<string>(@"
                SELECT c.COLUMN_NAME
                FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
                JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE c ON tc.CONSTRAINT_NAME = c.CONSTRAINT_NAME AND tc.TABLE_SCHEMA = c.TABLE_SCHEMA AND tc.TABLE_NAME = c.TABLE_NAME
                WHERE tc.TABLE_SCHEMA = @Schema AND tc.TABLE_NAME = @Table AND tc.CONSTRAINT_TYPE = 'PRIMARY KEY'
                ORDER BY c.ORDINAL_POSITION",
                new { Schema = schema, Table = table });

            var pkList = pkCols.ToList();
            if (pkList.Count > 0)
            {
                colDefs.Add($"    CONSTRAINT [PK_{table}] PRIMARY KEY ([{string.Join("], [", pkList)}])");
            }

            sb.AppendLine($"CREATE TABLE [{schema}].[{table}] (");
            sb.AppendLine(string.Join(",\n", colDefs));
            sb.AppendLine(");");
            sb.AppendLine();

            var indexes = await conn.QueryAsync(@"
                SELECT i.name AS IndexName, i.type_desc AS IndexType, i.is_unique AS IsUnique,
                       STUFF((
                           SELECT ', ' + col.name
                           FROM sys.index_columns ic2
                           JOIN sys.columns col ON ic2.object_id = col.object_id AND ic2.column_id = col.column_id
                           WHERE ic2.object_id = i.object_id AND ic2.index_id = i.index_id
                           ORDER BY ic2.key_ordinal
                           FOR XML PATH('')
                       ), 1, 2, '') AS ColumnNames
                FROM sys.indexes i
                WHERE i.object_id = OBJECT_ID(@FullName) AND i.is_primary_key = 0 AND i.type > 0",
                new { FullName = $"{schema}.{table}" });

            foreach (var idx in indexes)
            {
                string unique = (bool)idx.IsUnique ? "UNIQUE " : "";
                sb.AppendLine($"CREATE {unique}INDEX [{idx.IndexName}] ON [{schema}].[{table}] ({idx.ColumnNames});");
            }

            return sb.ToString();
        }

        private async Task SyncIndexes(SqlConnection srcConn, SqlConnection targetConn, string schema, string table)
        {
            var srcIndexes = await srcConn.QueryAsync(@"
                SELECT i.name AS IndexName, i.is_unique AS IsUnique,
                       STUFF((
                           SELECT ', ' + col.name
                           FROM sys.index_columns ic2
                           JOIN sys.columns col ON ic2.object_id = col.object_id AND ic2.column_id = col.column_id
                           WHERE ic2.object_id = i.object_id AND ic2.index_id = i.index_id
                           ORDER BY ic2.key_ordinal
                           FOR XML PATH('')
                       ), 1, 2, '') AS ColumnNames
                FROM sys.indexes i
                WHERE i.object_id = OBJECT_ID(@FullName) AND i.is_primary_key = 0 AND i.type > 0",
                new { FullName = $"{schema}.{table}" });

            var tgtIndexNames = (await targetConn.QueryAsync<string>(@"
                SELECT i.name FROM sys.indexes i 
                WHERE i.object_id = OBJECT_ID(@FullName) AND i.is_primary_key = 0 AND i.type > 0",
                new { FullName = $"{schema}.{table}" })).ToList();

            foreach (var idx in srcIndexes)
            {
                string idxName = idx.IndexName;
                if (!tgtIndexNames.Contains(idxName, StringComparer.OrdinalIgnoreCase))
                {
                    try
                    {
                        string unique = (bool)idx.IsUnique ? "UNIQUE " : "";
                        await targetConn.ExecuteAsync($"CREATE {unique}INDEX [{idxName}] ON [{schema}].[{table}] ({idx.ColumnNames})");
                    }
                    catch { }
                }
            }
        }

        private async Task<string> LoadSingleObjectDdlHelper(SqlConnection conn, string fullName, string objectType)
        {
            var parts = fullName.Split('.');
            string schema = parts.Length > 1 ? parts[0] : "dbo";
            string name = parts.Length > 1 ? parts[1] : parts[0];

            schema = schema.Replace("[", "").Replace("]", "");
            name = name.Replace("[", "").Replace("]", "");
            string cleanFullName = $"{schema}.{name}";

            var typeUpper = (objectType ?? "").ToUpper();

            if (typeUpper == "TABLE")
            {
                var columns = (await conn.QueryAsync<SchemaColumnDto>(@"
                    SELECT c.name AS Name, ty.name AS DataType, c.max_length AS MaxLength,
                           c.precision AS Precision, c.scale AS Scale, c.is_nullable AS IsNullable,
                           c.is_identity AS IsIdentity, dc.definition AS DefaultDefinition, c.column_id AS Ordinal
                    FROM sys.columns c
                    JOIN sys.types ty ON c.user_type_id = ty.user_type_id
                    LEFT JOIN sys.default_constraints dc ON c.default_object_id = dc.object_id
                    WHERE c.object_id = OBJECT_ID(@FullName)
                    ORDER BY c.column_id",
                    new { FullName = cleanFullName })).ToList();

                if (columns.Count == 0) return "-- Objek tidak ditemukan di database --";

                var pkColumns = (await conn.QueryAsync<string>(@"
                    SELECT c.name
                    FROM sys.indexes i
                    JOIN sys.index_columns ic ON i.object_id = ic.object_id AND i.index_id = ic.index_id
                    JOIN sys.columns c ON ic.object_id = c.object_id AND ic.column_id = c.column_id
                    WHERE i.object_id = OBJECT_ID(@FullName) AND i.is_primary_key = 1
                    ORDER BY ic.key_ordinal",
                    new { FullName = cleanFullName })).ToList();

                return SchemaHelper.GenerateComparableTableDdl(schema, name, columns, pkColumns);
            }
            else
            {
                string definition = await conn.QuerySingleOrDefaultAsync<string>(@"
                    SELECT OBJECT_DEFINITION(OBJECT_ID(@FullName))",
                    new { FullName = cleanFullName });

                return definition ?? "-- Objek tidak ditemukan di database --";
            }
        }

        private async Task<Dictionary<string, ComparableDbObject>> LoadComparableObjects(SqlConnection conn)
        {
            var result = new Dictionary<string, ComparableDbObject>(StringComparer.OrdinalIgnoreCase);

            var tables = await conn.QueryAsync(@"
                SELECT s.name AS SchemaName, t.name AS ObjectName
                FROM sys.tables t
                JOIN sys.schemas s ON t.schema_id = s.schema_id
                WHERE t.is_ms_shipped = 0
                ORDER BY s.name, t.name");

            foreach (var table in tables)
            {
                string schema = table.SchemaName;
                string name = table.ObjectName;
                var columns = (await conn.QueryAsync<SchemaColumnDto>(@"
                    SELECT c.name AS Name, ty.name AS DataType, c.max_length AS MaxLength,
                           c.precision AS Precision, c.scale AS Scale, c.is_nullable AS IsNullable,
                           c.is_identity AS IsIdentity, dc.definition AS DefaultDefinition, c.column_id AS Ordinal
                    FROM sys.columns c
                    JOIN sys.types ty ON c.user_type_id = ty.user_type_id
                    LEFT JOIN sys.default_constraints dc ON c.default_object_id = dc.object_id
                    WHERE c.object_id = OBJECT_ID(@FullName)
                    ORDER BY c.column_id",
                    new { FullName = $"{schema}.{name}" })).ToList();

                var pkColumns = (await conn.QueryAsync<string>(@"
                    SELECT c.name
                    FROM sys.indexes i
                    JOIN sys.index_columns ic ON i.object_id = ic.object_id AND i.index_id = ic.index_id
                    JOIN sys.columns c ON ic.object_id = c.object_id AND ic.column_id = c.column_id
                    WHERE i.object_id = OBJECT_ID(@FullName) AND i.is_primary_key = 1
                    ORDER BY ic.key_ordinal",
                    new { FullName = $"{schema}.{name}" })).ToList();

                var obj = new ComparableDbObject
                {
                    Name = $"{schema}.{name}",
                    Type = "TABLE",
                    DisplayType = "Table",
                    Columns = columns,
                    Ddl = SchemaHelper.GenerateComparableTableDdl(schema, name, columns, pkColumns)
                };
                result[obj.Key] = obj;
            }

            var programmableObjects = await conn.QueryAsync(@"
                SELECT s.name AS SchemaName, o.name AS ObjectName, o.type AS ObjectType,
                       OBJECT_DEFINITION(o.object_id) AS Definition
                FROM sys.objects o
                JOIN sys.schemas s ON o.schema_id = s.schema_id
                WHERE o.type IN ('V', 'P', 'FN', 'IF', 'TF', 'FS', 'FT')
                  AND o.is_ms_shipped = 0
                ORDER BY s.name, o.name");

            foreach (var dbObject in programmableObjects)
            {
                string objectType = dbObject.ObjectType;
                var obj = new ComparableDbObject
                {
                    Name = $"{dbObject.SchemaName}.{dbObject.ObjectName}",
                    Type = objectType,
                    DisplayType = objectType switch
                    {
                        "V" => "View",
                        "P" => "Stored Procedure",
                        _ => "Function"
                    },
                    Ddl = dbObject.Definition ?? "-- Definisi objek tidak tersedia --"
                };
                result[obj.Key] = obj;
            }

            return result;
        }

        private List<string> CompareTableColumns(List<SchemaColumnDto> sourceColumns, List<SchemaColumnDto> targetColumns)
        {
            var differences = new List<string>();
            var targetByName = targetColumns.ToDictionary(c => c.Name, StringComparer.OrdinalIgnoreCase);
            var sourceNames = new HashSet<string>(sourceColumns.Select(c => c.Name), StringComparer.OrdinalIgnoreCase);

            foreach (var sourceColumn in sourceColumns)
            {
                if (!targetByName.TryGetValue(sourceColumn.Name, out var targetColumn))
                {
                    differences.Add($"Kolom {sourceColumn.Name} {SchemaHelper.FormatComparableColumnType(sourceColumn)} tidak ditemukan di Target DB.");
                    continue;
                }

                var sourceDef = SchemaHelper.FormatComparableColumnDefinition(sourceColumn, includeName: false);
                var targetDef = SchemaHelper.FormatComparableColumnDefinition(targetColumn, includeName: false);
                if (!string.Equals(sourceDef, targetDef, StringComparison.OrdinalIgnoreCase))
                {
                    differences.Add($"Kolom {sourceColumn.Name} berbeda. Source: {sourceDef}; Target: {targetDef}.");
                }
            }

            foreach (var targetColumn in targetColumns)
            {
                if (!sourceNames.Contains(targetColumn.Name))
                {
                    differences.Add($"Kolom {targetColumn.Name} hanya ada di Target DB.");
                }
            }

            return differences;
        }

        private ColumnSyncPlanDto BuildColumnSyncPlan(ComparableDbObject sourceObj, ComparableDbObject targetObj)
        {
            var targetNames = new HashSet<string>(targetObj.Columns.Select(c => c.Name), StringComparer.OrdinalIgnoreCase);
            var missingColumns = sourceObj.Columns.Where(c => !targetNames.Contains(c.Name)).ToList();
            if (missingColumns.Count == 0) return null;

            var afterColumns = targetObj.Columns
                .Select(c => new ColumnPreviewDto { Name = c.Name, Type = SchemaHelper.FormatComparableColumnDefinition(c, includeName: false), IsNew = false })
                .ToList();

            foreach (var missingColumn in missingColumns)
            {
                afterColumns.Add(new ColumnPreviewDto
                {
                    Name = missingColumn.Name,
                    Type = SchemaHelper.FormatComparableColumnDefinition(missingColumn, includeName: false),
                    IsNew = true
                });
            }

            var tableName = SchemaHelper.QuoteMultipartSqlIdentifier(sourceObj.Name);
            var sql = string.Join(Environment.NewLine, missingColumns.Select(c =>
                $"ALTER TABLE {tableName} ADD {SchemaHelper.FormatComparableColumnDefinition(c, includeName: true)};"));

            return new ColumnSyncPlanDto
            {
                Before = targetObj.Columns.Select(c => new ColumnPreviewDto { Name = c.Name, Type = SchemaHelper.FormatComparableColumnDefinition(c, includeName: false) }).ToList(),
                After = afterColumns,
                Sql = sql
            };
        }

        private string GetDatabaseName(string connectionString)
        {
            try
            {
                var builder = new SqlConnectionStringBuilder(connectionString);
                return builder.InitialCatalog;
            }
            catch
            {
                var match = System.Text.RegularExpressions.Regex.Match(connectionString, @"(?:Database|Initial Catalog)\s*=\s*([^;]+)", System.Text.RegularExpressions.RegexOptions.IgnoreCase);
                return match.Success ? match.Groups[1].Value.Trim() : "DatabaseName";
            }
        }

        private string FormatQualifiedTableName(string dbName, string tableName)
        {
            var cleanName = tableName.Replace("[", "").Replace("]", "");
            var parts = cleanName.Split('.');
            string schema = "dbo";
            string table = cleanName;
            if (parts.Length > 1)
            {
                schema = parts[0];
                table = parts[1];
            }
            return $"[{dbName}].[{schema}].[{table}]";
        }

        private string GetMasterConnectionString(string connStr)
        {
            var builder = new SqlConnectionStringBuilder(connStr);
            builder.InitialCatalog = "master";
            return builder.ConnectionString;
        }

        #endregion
    }
}
