using System;
using System.Collections.Generic;
using System.Data;
using Microsoft.Data.SqlClient;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Dapper;

namespace DbMigrator.Core
{
    public class MigrationEngine
    {
        private readonly string _configConnectionString;

        public MigrationEngine(string configConnectionString)
        {
            _configConnectionString = configConnectionString;
        }

        private string EscapeTableName(string tableName)
        {
            if (string.IsNullOrEmpty(tableName)) return tableName;
            
            // Bersihkan brackets yang ada
            var cleanName = tableName.Replace("[", "").Replace("]", "");
            
            // Pisahkan berdasarkan tanda titik jika ada skema (dbo.Table)
            var parts = cleanName.Split('.');
            return string.Join(".", parts.Select(p => $"[{p}]"));
        }

        private Type GetCSharpType(string sqlDataType)
        {
            switch (sqlDataType.ToLowerInvariant())
            {
                case "int":
                case "integer":
                    return typeof(int);
                case "bigint":
                    return typeof(long);
                case "smallint":
                    return typeof(short);
                case "tinyint":
                    return typeof(byte);
                case "bit":
                    return typeof(bool);
                case "decimal":
                case "numeric":
                case "money":
                case "smallmoney":
                    return typeof(decimal);
                case "float":
                    return typeof(double);
                case "real":
                    return typeof(float);
                case "datetime":
                case "datetime2":
                case "date":
                case "smalldatetime":
                case "time":
                    return typeof(DateTime);
                case "datetimeoffset":
                    return typeof(DateTimeOffset);
                case "uniqueidentifier":
                    return typeof(Guid);
                case "binary":
                case "varbinary":
                case "image":
                    return typeof(byte[]);
                default:
                    return typeof(string);
            }
        }

        private object ConvertValue(object value, Type targetType)
        {
            if (value == null || value == DBNull.Value)
            {
                return DBNull.Value;
            }

            var strVal = value.ToString()?.Trim();
            if (string.IsNullOrEmpty(strVal))
            {
                return DBNull.Value;
            }

            try
            {
                if (targetType == typeof(int))
                {
                    return int.Parse(strVal);
                }
                if (targetType == typeof(long))
                {
                    return long.Parse(strVal);
                }
                if (targetType == typeof(short))
                {
                    return short.Parse(strVal);
                }
                if (targetType == typeof(byte))
                {
                    return byte.Parse(strVal);
                }
                if (targetType == typeof(bool))
                {
                    if (strVal == "1" || strVal.Equals("true", StringComparison.OrdinalIgnoreCase)) return true;
                    if (strVal == "0" || strVal.Equals("false", StringComparison.OrdinalIgnoreCase)) return false;
                    return bool.Parse(strVal);
                }
                if (targetType == typeof(decimal))
                {
                    return decimal.Parse(strVal);
                }
                if (targetType == typeof(double))
                {
                    return double.Parse(strVal);
                }
                if (targetType == typeof(float))
                {
                    return float.Parse(strVal);
                }
                if (targetType == typeof(DateTime))
                {
                    return DateTime.Parse(strVal);
                }
                if (targetType == typeof(DateTimeOffset))
                {
                    return DateTimeOffset.Parse(strVal);
                }
                if (targetType == typeof(Guid))
                {
                    return Guid.Parse(strVal);
                }
                if (targetType == typeof(byte[]))
                {
                    return Convert.FromBase64String(strVal);
                }
                return Convert.ChangeType(value, targetType);
            }
            catch
            {
                return DBNull.Value;
            }
        }

        /// <summary>
        /// Menjalankan seluruh proses migrasi untuk Job tertentu
        /// </summary>
        /// <param name="jobId">ID Job yang akan dijalankan</param>
        /// <param name="onProgress">Callback progres: (tableName, totalRows, rowsMigrated, status, errorMessage)</param>
        /// <param name="cancellationToken">Token pembatalan proses</param>
        public async Task RunJobAsync(int jobId, Action<string, int, int, string, string> onProgress, CancellationToken cancellationToken = default)
        {
            using var configConn = new SqlConnection(_configConnectionString);
            await configConn.OpenAsync();

            // 1. Ambil Data Job
            var job = await configConn.QuerySingleOrDefaultAsync<MigrationJob>(
                "SELECT * FROM dbo.MigrationJobs WHERE Id = @Id", new { Id = jobId });

            if (job == null)
            {
                throw new Exception($"Job dengan ID {jobId} tidak ditemukan!");
            }

            // 2. Ambil semua Table Mapping yang aktif diurutkan berdasarkan ExecutionOrder
            var tableMappings = (await configConn.QueryAsync<TableMapping>(
                "SELECT * FROM dbo.TableMappings WHERE JobId = @JobId AND IsEnabled = 1 ORDER BY ExecutionOrder ASC",
                new { JobId = jobId })).ToList();

            // Load kolom untuk masing-masing tabel
            foreach (var mapping in tableMappings)
            {
                var columns = await configConn.QueryAsync<ColumnMapping>(
                    "SELECT * FROM dbo.ColumnMappings WHERE TableMappingId = @TableMappingId",
                    new { TableMappingId = mapping.Id });
                mapping.Columns = columns.ToList();
            }

            // Update status LastRunAt
            await configConn.ExecuteAsync(
                "UPDATE dbo.MigrationJobs SET LastRunAt = GETDATE() WHERE Id = @Id", new { Id = jobId });

            // 3. Jalankan pemindahan tabel satu per satu
            foreach (var tableMap in tableMappings)
            {
                cancellationToken.ThrowIfCancellationRequested();

                int logId = 0;
                int totalRows = 0;
                int rowsMigrated = 0;
                string currentTable = tableMap.TargetTableName;

                if (IsNativeSqlMapping(tableMap))
                {
                    await ExecuteNativeSqlMappingAsync(configConn, job, tableMap, jobId, onProgress, cancellationToken);
                    continue;
                }

                // A. Persiapan Koneksi Source & Target
                using var sourceConn = new SqlConnection(job.SourceConnectionString);
                using var targetConn = new SqlConnection(job.TargetConnectionString);

                await sourceConn.OpenAsync(cancellationToken);
                await targetConn.OpenAsync(cancellationToken);

                using var transaction = targetConn.BeginTransaction();

                try
                {
                    onProgress?.Invoke(currentTable, 0, 0, "InProgress", null);

                    // Catat Log Awal ke Database
                    logId = await configConn.QuerySingleAsync<int>(@"
                        INSERT INTO dbo.MigrationLogs (JobId, TableName, StartTime, TotalRows, RowsMigrated, Status)
                        VALUES (@JobId, @TableName, GETDATE(), 0, 0, 'InProgress');
                        SELECT CAST(SCOPE_IDENTITY() as int);",
                        new { JobId = jobId, TableName = currentTable });

                    // B. Jalankan Truncate/Delete jika diaktifkan (Secara proaktif memverifikasi FK agar transaksi tidak doomed - BUG-CRUD-004)
                    if (tableMap.TruncateTarget)
                    {
                        int fkCount = 0;
                        using (var fkCheckCmd = new SqlCommand("SELECT COUNT(*) FROM sys.foreign_keys WHERE referenced_object_id = OBJECT_ID(@TableName)", targetConn, transaction))
                        {
                            fkCheckCmd.Parameters.AddWithValue("@TableName", tableMap.TargetTableName);
                            fkCount = Convert.ToInt32(await fkCheckCmd.ExecuteScalarAsync(cancellationToken));
                        }

                        if (fkCount > 0)
                        {
                            using var delCmd = new SqlCommand($"DELETE FROM {EscapeTableName(tableMap.TargetTableName)}", targetConn, transaction);
                            await delCmd.ExecuteNonQueryAsync(cancellationToken);
                        }
                        else
                        {
                            using var truncCmd = new SqlCommand($"TRUNCATE TABLE {EscapeTableName(tableMap.TargetTableName)}", targetConn, transaction);
                            await truncCmd.ExecuteNonQueryAsync(cancellationToken);
                        }
                    }

                    // Query target table metadata
                    var cleanTableName = tableMap.TargetTableName.Replace("[", "").Replace("]", "");
                    string schemaName = "dbo";
                    string rawTableName = cleanTableName;
                    if (cleanTableName.Contains('.'))
                    {
                        var parts = cleanTableName.Split('.');
                        schemaName = parts[0];
                        rawTableName = parts[1];
                    }

                    var columnsMetadata = new Dictionary<string, Type>(StringComparer.OrdinalIgnoreCase);
                    using (var schemaCmd = new SqlCommand(@"
                        SELECT COLUMN_NAME, DATA_TYPE 
                        FROM INFORMATION_SCHEMA.COLUMNS 
                        WHERE TABLE_NAME = @TableName AND TABLE_SCHEMA = @SchemaName", targetConn, transaction))
                    {
                        schemaCmd.Parameters.AddWithValue("@TableName", rawTableName);
                        schemaCmd.Parameters.AddWithValue("@SchemaName", schemaName);
                        using var schemaReader = await schemaCmd.ExecuteReaderAsync(cancellationToken);
                        while (await schemaReader.ReadAsync(cancellationToken))
                        {
                            var colName = schemaReader.GetString(0);
                            var dataType = schemaReader.GetString(1);
                            columnsMetadata[colName] = GetCSharpType(dataType);
                        }
                    }

                    // C. Pemuatan Cache untuk Kolom Tipe Lookup (NIK -> ID)
                    var lookupCaches = new Dictionary<string, Dictionary<string, object>>(StringComparer.OrdinalIgnoreCase);
                    foreach (var col in tableMap.Columns.Where(c => c.MappingType.Equals("Lookup", StringComparison.OrdinalIgnoreCase)))
                    {
                        var cacheDict = new Dictionary<string, object>(StringComparer.OrdinalIgnoreCase);
                        string lookupQuery = $"SELECT [{col.LookupKeyColumn}], [{col.LookupValueColumn}] FROM {EscapeTableName(col.LookupTable)}";
                        
                        using var lookupCmd = new SqlCommand(lookupQuery, targetConn, transaction);
                        using var lookupReader = await lookupCmd.ExecuteReaderAsync(cancellationToken);
                        while (await lookupReader.ReadAsync(cancellationToken))
                        {
                            var keyVal = lookupReader[0]?.ToString()?.Trim();
                            var targetId = lookupReader[1];
                            if (!string.IsNullOrEmpty(keyVal) && !cacheDict.ContainsKey(keyVal))
                            {
                                cacheDict.Add(keyVal, targetId);
                            }
                        }
                        lookupCaches.Add(col.TargetColumnName, cacheDict);
                    }

                    // D. Hitung Total Baris di Tabel Source
                    using (var countCmd = new SqlCommand($"SELECT COUNT(*) FROM {EscapeTableName(tableMap.SourceTableName)}", sourceConn))
                    {
                        totalRows = Convert.ToInt32(await countCmd.ExecuteScalarAsync(cancellationToken));
                    }

                    // Update log dengan jumlah total baris
                    await configConn.ExecuteAsync(
                        "UPDATE dbo.MigrationLogs SET TotalRows = @TotalRows WHERE Id = @Id",
                        new { TotalRows = totalRows, Id = logId });

                    if (totalRows == 0)
                    {
                        // Selesai langsung jika tidak ada data
                        await configConn.ExecuteAsync(@"
                            UPDATE dbo.MigrationLogs 
                            SET EndTime = GETDATE(), Status = 'Completed', RowsMigrated = 0 
                            WHERE Id = @Id", new { Id = logId });

                        transaction.Commit();
                        onProgress?.Invoke(currentTable, 0, 0, "Completed", null);
                        continue;
                    }

                    // E. Bangun Dynamic SELECT Query
                    var selectProjections = new List<string>();
                    var activeCols = tableMap.Columns.Where(c => !c.MappingType.Equals("Ignore", StringComparison.OrdinalIgnoreCase)).ToList();

                    foreach (var col in activeCols)
                    {
                        if (col.MappingType.Equals("Direct", StringComparison.OrdinalIgnoreCase) || 
                            col.MappingType.Equals("Lookup", StringComparison.OrdinalIgnoreCase))
                        {
                            selectProjections.Add($"[{col.SourceColumnName}]");
                        }
                        else if (col.MappingType.Equals("Expression", StringComparison.OrdinalIgnoreCase))
                        {
                            selectProjections.Add($"({col.ExpressionSQL}) AS [{col.TargetColumnName}]");
                        }
                    }

                    // Jika tidak ada proyeksi kolom, ambil semua
                    string selectColumns = selectProjections.Count > 0 ? string.Join(", ", selectProjections) : "*";
                    string selectQuery = $"SELECT {selectColumns} FROM {EscapeTableName(tableMap.SourceTableName)} AS Source";

                    // F. Siapkan Struktur DataTable Target untuk Batching & SqlBulkCopy
                    var targetSchemaTable = new DataTable();
                    foreach (var col in activeCols)
                    {
                        columnsMetadata.TryGetValue(col.TargetColumnName, out var colType);
                        colType ??= typeof(string);
                        targetSchemaTable.Columns.Add(col.TargetColumnName, colType);
                    }

                    // G. Streaming Data & Simpan per Batch
                    using var selectCmd = new SqlCommand(selectQuery, sourceConn);
                    selectCmd.CommandTimeout = 300; 
                    using var reader = await selectCmd.ExecuteReaderAsync(cancellationToken);

                    int batchSize = 5000;
                    var batchTable = targetSchemaTable.Clone();

                    while (await reader.ReadAsync(cancellationToken))
                    {
                        if (cancellationToken.IsCancellationRequested)
                        {
                            throw new OperationCanceledException("Proses dibatalkan oleh pengguna.", cancellationToken);
                        }

                        var newRow = batchTable.NewRow();
                        foreach (var col in activeCols)
                        {
                            object val = DBNull.Value;
                            if (col.MappingType.Equals("Direct", StringComparison.OrdinalIgnoreCase))
                            {
                                val = reader[col.SourceColumnName] ?? DBNull.Value;
                            }
                            else if (col.MappingType.Equals("Constant", StringComparison.OrdinalIgnoreCase))
                            {
                                val = (object)col.ConstantValue ?? DBNull.Value;
                            }
                            else if (col.MappingType.Equals("Expression", StringComparison.OrdinalIgnoreCase))
                            {
                                val = reader[col.TargetColumnName] ?? DBNull.Value;
                            }
                            else if (col.MappingType.Equals("Lookup", StringComparison.OrdinalIgnoreCase))
                            {
                                var sourceVal = reader[col.SourceColumnName]?.ToString()?.Trim();
                                if (!string.IsNullOrEmpty(sourceVal) && lookupCaches.TryGetValue(col.TargetColumnName, out var cache) && cache.TryGetValue(sourceVal, out var matchedId))
                                {
                                    val = matchedId;
                                }
                            }

                            columnsMetadata.TryGetValue(col.TargetColumnName, out var targetType);
                            newRow[col.TargetColumnName] = ConvertValue(val, targetType ?? typeof(object));
                        }

                        batchTable.Rows.Add(newRow);
                        rowsMigrated++;

                        if (batchTable.Rows.Count >= batchSize)
                        {
                            await WriteBatchAsync(batchTable, tableMap.TargetTableName, targetConn, transaction);
                            batchTable.Rows.Clear();

                            // Update log progres ke db configurator
                            await configConn.ExecuteAsync(
                                "UPDATE dbo.MigrationLogs SET RowsMigrated = @RowsMigrated WHERE Id = @Id",
                                new { RowsMigrated = rowsMigrated, Id = logId });

                            onProgress?.Invoke(currentTable, totalRows, rowsMigrated, "InProgress", null);
                        }
                    }

                    // Tulis sisa baris jika ada
                    if (batchTable.Rows.Count > 0)
                    {
                        await WriteBatchAsync(batchTable, tableMap.TargetTableName, targetConn, transaction);
                        batchTable.Rows.Clear();
                    }

                    // Run table-level post-migration script inside the transaction
                    if (!string.IsNullOrWhiteSpace(tableMap.PostMigrationScript))
                    {
                        using var scriptCmd = new SqlCommand(tableMap.PostMigrationScript, targetConn, transaction);
                        scriptCmd.CommandTimeout = 300;
                        await scriptCmd.ExecuteNonQueryAsync(cancellationToken);
                    }

                    transaction.Commit();

                    // Update Status Sukses di Database Log
                    await configConn.ExecuteAsync(@"
                        UPDATE dbo.MigrationLogs 
                        SET EndTime = GETDATE(), Status = 'Completed', RowsMigrated = @RowsMigrated 
                        WHERE Id = @Id", new { RowsMigrated = rowsMigrated, Id = logId });

                    onProgress?.Invoke(currentTable, totalRows, rowsMigrated, "Completed", null);
                }
                catch (Exception ex)
                {
                    try
                    {
                        transaction.Rollback();
                    }
                    catch { }

                    string errorMsg = ex is OperationCanceledException 
                        ? (ex.Message.StartsWith("Proses dibatalkan") ? ex.Message : "Proses dibatalkan oleh pengguna.") 
                        : ex.ToString();
                    
                    if (logId > 0)
                    {
                        await configConn.ExecuteAsync(@"
                            UPDATE dbo.MigrationLogs 
                            SET EndTime = GETDATE(), Status = 'Failed', ErrorMessage = @Error 
                            WHERE Id = @Id", new { Error = errorMsg, Id = logId });
                    }

                    onProgress?.Invoke(currentTable, totalRows, rowsMigrated, "Failed", errorMsg);
                    throw; // Hentikan migrasi jika salah satu tabel gagal (agar integritas terjaga)
                }
            }

            // 4. Jalankan Job-Level Post-Migration Script jika terisi
            if (!string.IsNullOrWhiteSpace(job.PostMigrationScript))
            {
                cancellationToken.ThrowIfCancellationRequested();
                
                int logId = 0;
                string virtualTable = "[POST-MIGRATION-SCRIPT]";
                onProgress?.Invoke(virtualTable, 0, 0, "InProgress", null);
                
                // Catat Log Awal ke Database
                logId = await configConn.QuerySingleAsync<int>(@"
                    INSERT INTO dbo.MigrationLogs (JobId, TableName, StartTime, TotalRows, RowsMigrated, Status)
                    VALUES (@JobId, @TableName, GETDATE(), 0, 0, 'InProgress');
                    SELECT CAST(SCOPE_IDENTITY() as int);",
                    new { JobId = jobId, TableName = virtualTable });
                
                using var targetConn = new SqlConnection(job.TargetConnectionString);
                await targetConn.OpenAsync(cancellationToken);
                using var transaction = targetConn.BeginTransaction();
                
                try
                {
                    using var scriptCmd = new SqlCommand(job.PostMigrationScript, targetConn, transaction);
                    scriptCmd.CommandTimeout = 300;
                    await scriptCmd.ExecuteNonQueryAsync(cancellationToken);
                    
                    transaction.Commit();
                    
                    // Update Status Sukses di Database Log
                    await configConn.ExecuteAsync(@"
                        UPDATE dbo.MigrationLogs 
                        SET EndTime = GETDATE(), Status = 'Completed', RowsMigrated = 0 
                        WHERE Id = @Id", new { Id = logId });
                    
                    onProgress?.Invoke(virtualTable, 0, 0, "Completed", null);
                }
                catch (Exception ex)
                {
                    try { transaction.Rollback(); } catch { }
                    
                    string errorMsg = ex is OperationCanceledException 
                        ? (ex.Message.StartsWith("Proses dibatalkan") ? ex.Message : "Proses dibatalkan oleh pengguna.") 
                        : ex.ToString();
                    
                    await configConn.ExecuteAsync(@"
                        UPDATE dbo.MigrationLogs 
                        SET EndTime = GETDATE(), Status = 'Failed', ErrorMessage = @Error 
                        WHERE Id = @Id", new { Error = errorMsg, Id = logId });
                    
                    onProgress?.Invoke(virtualTable, 0, 0, "Failed", errorMsg);
                    throw; // Re-throw to signal job failure
                }
            }
        }

        private static bool IsNativeSqlMapping(TableMapping tableMap)
        {
            return string.Equals(tableMap.MappingMode, "NATIVE_SQL", StringComparison.OrdinalIgnoreCase)
                || string.Equals(tableMap.SourceTableName, "[NATIVE_SQL]", StringComparison.OrdinalIgnoreCase);
        }

        private static async Task ExecuteNativeSqlMappingAsync(
            SqlConnection configConn,
            MigrationJob job,
            TableMapping tableMap,
            int jobId,
            Action<string, int, int, string, string> onProgress,
            CancellationToken cancellationToken)
        {
            var label = string.IsNullOrWhiteSpace(tableMap.TargetTableName)
                ? "[DATA-NATIVE-SQL]"
                : tableMap.TargetTableName;

            int logId = 0;
            onProgress?.Invoke(label, 0, 0, "InProgress", null);

            logId = await configConn.QuerySingleAsync<int>(@"
                INSERT INTO dbo.MigrationLogs (JobId, TableName, StartTime, TotalRows, RowsMigrated, Status)
                VALUES (@JobId, @TableName, GETDATE(), 0, 0, 'InProgress');
                SELECT CAST(SCOPE_IDENTITY() as int);",
                new { JobId = jobId, TableName = label });

            using var targetConn = new SqlConnection(job.TargetConnectionString);
            await targetConn.OpenAsync(cancellationToken);
            using var transaction = targetConn.BeginTransaction();

            try
            {
                var script = ResolveNativeSqlScript(job, tableMap.NativeSqlScript);
                using var scriptCmd = new SqlCommand(script, targetConn, transaction);
                scriptCmd.CommandTimeout = 300;
                await scriptCmd.ExecuteNonQueryAsync(cancellationToken);

                transaction.Commit();

                await configConn.ExecuteAsync(@"
                    UPDATE dbo.MigrationLogs
                    SET EndTime = GETDATE(), Status = 'Completed', RowsMigrated = 0
                    WHERE Id = @Id", new { Id = logId });

                onProgress?.Invoke(label, 0, 0, "Completed", null);
            }
            catch (Exception ex)
            {
                try
                {
                    transaction.Rollback();
                }
                catch { }

                await configConn.ExecuteAsync(@"
                    UPDATE dbo.MigrationLogs
                    SET EndTime = GETDATE(), Status = 'Failed', ErrorMessage = @Error
                    WHERE Id = @Id", new { Error = ex.ToString(), Id = logId });

                onProgress?.Invoke(label, 0, 0, "Failed", ex.ToString());
                throw;
            }
        }

        private static string ResolveNativeSqlScript(MigrationJob job, string script)
        {
            if (string.IsNullOrWhiteSpace(script)) return script;

            var sourceBuilder = new SqlConnectionStringBuilder(job.SourceConnectionString);
            var targetBuilder = new SqlConnectionStringBuilder(job.TargetConnectionString);
            var usesSourcePlaceholder =
                script.Contains("{{SOURCE_DB}}", StringComparison.OrdinalIgnoreCase) ||
                script.Contains("{{SOURCE_DATABASE}}", StringComparison.OrdinalIgnoreCase);

            if (usesSourcePlaceholder &&
                !string.Equals(NormalizeSqlDataSource(sourceBuilder.DataSource), NormalizeSqlDataSource(targetBuilder.DataSource), StringComparison.OrdinalIgnoreCase))
            {
                throw new InvalidOperationException("Data Native SQL Source DB ke Target DB hanya didukung otomatis jika Source dan Target berada di SQL Server instance yang sama. Untuk beda server, gunakan linked server di SQL Server lalu tulis nama linked server di script.");
            }

            return script
                .Replace("{{SOURCE_DB}}", QuoteSqlIdentifier(sourceBuilder.InitialCatalog), StringComparison.OrdinalIgnoreCase)
                .Replace("{{SOURCE_DATABASE}}", QuoteSqlIdentifier(sourceBuilder.InitialCatalog), StringComparison.OrdinalIgnoreCase)
                .Replace("{{TARGET_DB}}", QuoteSqlIdentifier(targetBuilder.InitialCatalog), StringComparison.OrdinalIgnoreCase)
                .Replace("{{TARGET_DATABASE}}", QuoteSqlIdentifier(targetBuilder.InitialCatalog), StringComparison.OrdinalIgnoreCase);
        }

        private static string NormalizeSqlDataSource(string dataSource)
        {
            return (dataSource ?? string.Empty)
                .Trim()
                .Replace("tcp:", "", StringComparison.OrdinalIgnoreCase)
                .Replace(" ", "");
        }

        private static string QuoteSqlIdentifier(string identifier)
        {
            if (string.IsNullOrWhiteSpace(identifier))
            {
                throw new InvalidOperationException("Connection string Source/Target harus memiliki nama database.");
            }

            return $"[{identifier.Replace("]", "]]")}]";
        }

        /// <summary>
        /// Menulis satu batch data ke database tujuan menggunakan SqlBulkCopy yang sangat cepat
        /// </summary>
        private async Task WriteBatchAsync(DataTable table, string destinationTable, SqlConnection connection, SqlTransaction transaction)
        {
            using var bulkCopy = new SqlBulkCopy(connection, SqlBulkCopyOptions.KeepIdentity | SqlBulkCopyOptions.KeepNulls, transaction)
            {
                DestinationTableName = EscapeTableName(destinationTable),
                BulkCopyTimeout = 300,
                BatchSize = table.Rows.Count
            };

            foreach (DataColumn column in table.Columns)
            {
                bulkCopy.ColumnMappings.Add(column.ColumnName, column.ColumnName);
            }

            await bulkCopy.WriteToServerAsync(table);
        }
    }
}
