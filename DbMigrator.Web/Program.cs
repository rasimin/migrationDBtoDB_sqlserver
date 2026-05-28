using System;
using System.Collections.Generic;
using System.Data;
using Microsoft.Data.SqlClient;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using System.Collections.Concurrent;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.SignalR;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Dapper;
using DbMigrator.Core;
using DbMigrator.Web;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;

var builder = WebApplication.CreateBuilder(args);

// ============================================================================
// MODUL VERIFIKASI OTOMATIS (CLI RUNNER)
// ============================================================================
if (args.Contains("--verify"))
{
    var configDbStr = builder.Configuration.GetConnectionString("ConfigDb");
    Console.WriteLine("\n====================================================================");
    Console.WriteLine("🛡️  MEMULAI VERIFIKASI ENGINE MIGRASI DINAMIS");
    Console.WriteLine("====================================================================");
    
    try
    {
        int? jobId = null;
        using (var configConn = new SqlConnection(configDbStr))
        {
            await configConn.OpenAsync();
            jobId = await configConn.QueryFirstOrDefaultAsync<int?>("SELECT TOP 1 Id FROM dbo.MigrationJobs ORDER BY Id ASC");
        }

        if (jobId == null)
        {
            throw new Exception("Tidak ada Job Migrasi yang ditemukan di database configurator!");
        }

        var engine = new MigrationEngine(configDbStr);
        await engine.RunJobAsync(jobId.Value, (tableName, totalRows, rowsMigrated, status, error) =>
        {
            if (status == "InProgress")
            {
                Console.WriteLine($"⏳ [InProgress] Tabel: {tableName} | Progres: {rowsMigrated}/{totalRows}");
            }
            else if (status == "Completed")
            {
                Console.WriteLine($"✅ [COMPLETED] Tabel: {tableName} | Sukses memindahkan {rowsMigrated} baris.");
            }
            else if (status == "Failed")
            {
                Console.WriteLine($"❌ [FAILED] Tabel: {tableName} | Error: {error}");
            }
        });

        Console.WriteLine("\n====================================================================");
        Console.WriteLine("📊 HASIL MIGRASI DI DATABASE TUJUAN (TargetDB)");
        Console.WriteLine("====================================================================");

        // Baca dari connection string 'TargetDb' di appsettings.json atau parameter CLI, atau fallback ke default
        var targetConnStr = builder.Configuration.GetConnectionString("TargetDb");
        
        // Periksa parameter CLI tambahan (misal: --target-conn "...")
        var targetConnIndex = Array.IndexOf(args, "--target-conn");
        if (targetConnIndex >= 0 && targetConnIndex < args.Length - 1)
        {
            targetConnStr = args[targetConnIndex + 1];
        }

        if (string.IsNullOrEmpty(targetConnStr))
        {
            targetConnStr = "Server=RASIMIN\\MSSQLSERVER2022;Database=TargetDB;Integrated Security=True;TrustServerCertificate=True;";
        }

        using var targetConn = new SqlConnection(targetConnStr);
        await targetConn.OpenAsync();

        // 1. Tampilkan tabel TargetCustomers
        Console.WriteLine("\nTabel: TargetCustomers");
        Console.WriteLine("-------------------------------------------------------------------------------------");
        Console.WriteLine(string.Format("{0,-12} | {1,-15} | {2,-20} | {3,-10} | {4,-15}", "idcustomer", "NIK", "FullName", "PunyaSaldo", "RegDate"));
        Console.WriteLine("-------------------------------------------------------------------------------------");
        var customers = await targetConn.QueryAsync("SELECT idcustomer, NIK, FullName, PunyaSaldo, CONVERT(VARCHAR, RegistrationDate, 120) AS RegDate FROM TargetCustomers");
        foreach (var c in customers)
        {
            Console.WriteLine(string.Format("{0,-12} | {1,-15} | {2,-20} | {3,-10} | {4,-15}", c.idcustomer, c.NIK, c.FullName, c.PunyaSaldo, c.RegDate));
        }

        // 2. Tampilkan tabel TargetTransactions
        Console.WriteLine("\nTabel: TargetTransactions");
        Console.WriteLine("-------------------------------------------------------------------------------------");
        Console.WriteLine(string.Format("{0,-10} | {1,-12} | {2,-15} | {3,-15}", "Id", "idcustomer", "Amount", "TransactionDate"));
        Console.WriteLine("-------------------------------------------------------------------------------------");
        var transactions = await targetConn.QueryAsync("SELECT Id, idcustomer, Amount, CONVERT(VARCHAR, TransactionDate, 120) AS TrxDate FROM TargetTransactions");
        foreach (var t in transactions)
        {
            Console.WriteLine(string.Format("{0,-10} | {1,-12} | {2,-15} | {3,-15}", t.Id, t.idcustomer, t.Amount, t.TrxDate));
        }
        
        Console.WriteLine("\n====================================================================");
        Console.WriteLine("🎉 VERIFIKASI MIGRASI SELESAI DENGAN SUKSES!");
        Console.WriteLine("====================================================================\n");
    }
    catch (Exception ex)
    {
        Console.ForegroundColor = ConsoleColor.Red;
        Console.WriteLine($"\n❌ VERIFIKASI GAGAL: {ex.Message}");
        Console.ResetColor();
    }
    return;
}

// Tambahkan SignalR untuk real-time update
builder.Services.AddSignalR().AddJsonProtocol(options =>
{
    options.PayloadSerializerOptions.PropertyNamingPolicy = null;
});
builder.Services.AddCors(options =>
{
    options.AddPolicy("AllowAll", p => p.AllowAnyOrigin().AllowAnyHeader().AllowAnyMethod());
});

// Konfigurasi agar JSON serializer mempertahankan casing model C# (PascalCase)
builder.Services.Configure<Microsoft.AspNetCore.Http.Json.JsonOptions>(options =>
{
    options.SerializerOptions.PropertyNamingPolicy = null;
});

var app = builder.Build();

// Static collection for active migration cancellation tokens
var ActiveJobTokens = new ConcurrentDictionary<int, CancellationTokenSource>();

// Run automatic database alterations at startup
using (var conn = new SqlConnection(builder.Configuration.GetConnectionString("ConfigDb")))
{
    await conn.OpenAsync();
    await conn.ExecuteAsync(@"
        IF NOT EXISTS (
            SELECT * FROM sys.columns 
            WHERE object_id = OBJECT_ID('dbo.MigrationJobs') AND name = 'PostMigrationScript'
        )
        BEGIN
            ALTER TABLE dbo.MigrationJobs ADD PostMigrationScript NVARCHAR(MAX) NULL;
        END

        IF NOT EXISTS (
            SELECT * FROM sys.columns 
            WHERE object_id = OBJECT_ID('dbo.TableMappings') AND name = 'PostMigrationScript'
        )
        BEGIN
            ALTER TABLE dbo.TableMappings ADD PostMigrationScript NVARCHAR(MAX) NULL;
        END

        IF NOT EXISTS (
            SELECT * FROM sys.columns
            WHERE object_id = OBJECT_ID('dbo.TableMappings') AND name = 'MappingMode'
        )
        BEGIN
            ALTER TABLE dbo.TableMappings ADD MappingMode NVARCHAR(50) NOT NULL CONSTRAINT DF_TableMappings_MappingMode DEFAULT 'TABLE';
        END

        IF NOT EXISTS (
            SELECT * FROM sys.columns
            WHERE object_id = OBJECT_ID('dbo.TableMappings') AND name = 'NativeSqlScript'
        )
        BEGIN
            ALTER TABLE dbo.TableMappings ADD NativeSqlScript NVARCHAR(MAX) NULL;
        END

        -- ================================================================
        -- OBJECT MIGRATION TABLES (DDL Migrator) - Unified Connection
        -- ObjectMigrationItems & Logs langsung FK ke dbo.MigrationJobs
        -- ================================================================

        -- Langkah 1: Pastikan ObjectMigrationBackups tidak memiliki FK constraint lama
        -- sebelum drop ObjectMigrationItems (jika pernah ada struktur lama)
        IF OBJECT_ID('dbo.ObjectMigrationBackups', 'U') IS NOT NULL
            AND OBJECT_ID('dbo.ObjectMigrationItems', 'U') IS NOT NULL
        BEGIN
            -- Cek apakah ObjectMigrationItems.JobId masih FK ke ObjectMigrationJobs
            IF EXISTS (
                SELECT 1 FROM sys.foreign_keys fk
                JOIN sys.tables t ON fk.referenced_object_id = t.object_id
                WHERE fk.parent_object_id = OBJECT_ID('dbo.ObjectMigrationItems')
                  AND t.name = 'ObjectMigrationJobs'
            )
            BEGIN
                -- Drop Backups terlebih dahulu (child)
                DROP TABLE dbo.ObjectMigrationBackups;
                -- Drop Logs (jika FK ke ObjectMigrationJobs)
                IF OBJECT_ID('dbo.ObjectMigrationLogs', 'U') IS NOT NULL
                    DROP TABLE dbo.ObjectMigrationLogs;
                -- Drop Items (child dari ObjectMigrationJobs)
                DROP TABLE dbo.ObjectMigrationItems;
                -- Drop Job tabel lama
                IF OBJECT_ID('dbo.ObjectMigrationJobs', 'U') IS NOT NULL
                    DROP TABLE dbo.ObjectMigrationJobs;
            END
        END
        ELSE IF OBJECT_ID('dbo.ObjectMigrationJobs', 'U') IS NOT NULL
            AND OBJECT_ID('dbo.ObjectMigrationItems', 'U') IS NULL
        BEGIN
            -- Items belum dibuat, aman drop ObjectMigrationJobs langsung
            DROP TABLE dbo.ObjectMigrationJobs;
        END

        -- Langkah 2: Buat tabel baru yang FK ke dbo.MigrationJobs
        IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'ObjectMigrationItems')
        BEGIN
            CREATE TABLE dbo.ObjectMigrationItems (
                Id INT IDENTITY(1,1) PRIMARY KEY,
                JobId INT NOT NULL REFERENCES dbo.MigrationJobs(Id) ON DELETE CASCADE,
                ObjectName NVARCHAR(255) NOT NULL,
                ObjectType NVARCHAR(50) NOT NULL,
                NativeSqlScript NVARCHAR(MAX) NULL,
                ExecutionOrder INT NOT NULL DEFAULT 1,
                IsEnabled BIT NOT NULL DEFAULT 1
            );
        END

        IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'ObjectMigrationBackups')
        BEGIN
            CREATE TABLE dbo.ObjectMigrationBackups (
                Id INT IDENTITY(1,1) PRIMARY KEY,
                ItemId INT NOT NULL REFERENCES dbo.ObjectMigrationItems(Id) ON DELETE CASCADE,
                Version INT NOT NULL DEFAULT 1,
                BackupScript NVARCHAR(MAX) NOT NULL,
                BackedUpAt DATETIME NOT NULL DEFAULT GETDATE()
            );
        END

        IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'ObjectMigrationLogs')
        BEGIN
            CREATE TABLE dbo.ObjectMigrationLogs (
                Id INT IDENTITY(1,1) PRIMARY KEY,
                JobId INT NOT NULL REFERENCES dbo.MigrationJobs(Id) ON DELETE CASCADE,
                ObjectName NVARCHAR(255) NOT NULL,
                Action NVARCHAR(50) NOT NULL,
                Status NVARCHAR(50) NOT NULL,
                ExecutedAt DATETIME NOT NULL DEFAULT GETDATE(),
                ErrorMessage NVARCHAR(MAX) NULL
            );
        END

        IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'CleanTargetTables')
        BEGIN
            CREATE TABLE dbo.CleanTargetTables (
                Id INT IDENTITY(1,1) PRIMARY KEY,
                JobId INT NOT NULL REFERENCES dbo.MigrationJobs(Id) ON DELETE CASCADE,
                TableName NVARCHAR(255) NOT NULL,
                ExecutionOrder INT NOT NULL DEFAULT 1,
                LastStatus NVARCHAR(50) NOT NULL DEFAULT 'Pending',
                LastErrorMessage NVARCHAR(MAX) NULL,
                LastCleanedAt DATETIME NULL
            );
        END

        -- Ensure TableMappings has status columns
        IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID('dbo.TableMappings') AND name = 'LastStatus')
        BEGIN
            ALTER TABLE dbo.TableMappings ADD LastStatus NVARCHAR(50) NOT NULL DEFAULT 'Pending';
            ALTER TABLE dbo.TableMappings ADD LastErrorMessage NVARCHAR(MAX) NULL;
            ALTER TABLE dbo.TableMappings ADD LastRunAt DATETIME NULL;
        END

        -- Ensure ObjectMigrationItems has status columns
        IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID('dbo.ObjectMigrationItems') AND name = 'LastStatus')
        BEGIN
            ALTER TABLE dbo.ObjectMigrationItems ADD LastStatus NVARCHAR(50) NOT NULL DEFAULT 'Pending';
            ALTER TABLE dbo.ObjectMigrationItems ADD LastErrorMessage NVARCHAR(MAX) NULL;
            ALTER TABLE dbo.ObjectMigrationItems ADD LastRunAt DATETIME NULL;
        END

        -- Ensure ColumnMappings has IfNull strategy columns (F-04: If-Null Fallback)
        IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID('dbo.ColumnMappings') AND name = 'IfNullAction')
        BEGIN
            ALTER TABLE dbo.ColumnMappings ADD IfNullAction NVARCHAR(50) NULL;
            ALTER TABLE dbo.ColumnMappings ADD IfNullParam NVARCHAR(500) NULL;
        END
    ");
}

app.UseCors("AllowAll");
app.UseDefaultFiles();
app.UseStaticFiles();

// ============================================================================
// REST API ENDPOINTS - CONFIGURATOR MIGRASI
// ============================================================================

// 1. GET ALL JOBS
app.MapGet("/api/jobs", async (IConfiguration config) =>
{
    using var conn = new SqlConnection(config.GetConnectionString("ConfigDb"));
    var jobs = await conn.QueryAsync<MigrationJob>("SELECT * FROM dbo.MigrationJobs ORDER BY Id DESC");
    return Results.Ok(jobs);
});

// 2. GET JOB BY ID
app.MapGet("/api/jobs/{id:int}", async (int id, IConfiguration config) =>
{
    using var conn = new SqlConnection(config.GetConnectionString("ConfigDb"));
    var job = await conn.QuerySingleOrDefaultAsync<MigrationJob>("SELECT * FROM dbo.MigrationJobs WHERE Id = @Id", new { Id = id });
    return job != null ? Results.Ok(job) : Results.NotFound($"Job {id} tidak ditemukan");
});

// 3. CREATE / UPDATE JOB
app.MapPost("/api/jobs", async ([FromBody] MigrationJob job, IConfiguration config) =>
{
    using var conn = new SqlConnection(config.GetConnectionString("ConfigDb"));
    if (job.Id > 0)
    {
        await conn.ExecuteAsync(@"
            UPDATE dbo.MigrationJobs 
            SET JobName = @JobName, SourceConnectionString = @SourceConnectionString, TargetConnectionString = @TargetConnectionString, PostMigrationScript = @PostMigrationScript
            WHERE Id = @Id", job);
        return Results.Ok(job);
    }
    else
    {
        int newId = await conn.QuerySingleAsync<int>(@"
            INSERT INTO dbo.MigrationJobs (JobName, SourceConnectionString, TargetConnectionString, PostMigrationScript)
            VALUES (@JobName, @SourceConnectionString, @TargetConnectionString, @PostMigrationScript);
            SELECT CAST(SCOPE_IDENTITY() as int);", job);
        job.Id = newId;
        return Results.Created($"/api/jobs/{newId}", job);
    }
});

// BUG-CRUD-001 (Delete Job Endpoint)
app.MapDelete("/api/jobs/{id:int}", async (int id, IConfiguration config) =>
{
    using var conn = new SqlConnection(config.GetConnectionString("ConfigDb"));
    var rows = await conn.ExecuteAsync("DELETE FROM dbo.MigrationJobs WHERE Id = @Id", new { Id = id });
    if (rows == 0)
    {
        return Results.NotFound($"Job {id} tidak ditemukan");
    }
    return Results.Ok();
});

// BUG-CRUD-002 (Test Connection Endpoint)
app.MapPost("/api/jobs/test-connection", async ([FromBody] TestConnectionRequest request) =>
{
    if (string.IsNullOrEmpty(request?.ConnectionString))
    {
        return Results.BadRequest(new { Success = false, Message = "Connection string kosong" });
    }

    try
    {
        using var conn = new SqlConnection(request.ConnectionString);
        await conn.OpenAsync();
        return Results.Ok(new { Success = true, Message = "Koneksi berhasil terhubung!" });
    }
    catch (Exception ex)
    {
        return Results.Ok(new { Success = false, Message = $"Gagal terhubung: {ex.Message}" });
    }
});

// 4. GET TABLE MAPPINGS FOR JOB
app.MapGet("/api/mappings/tables/{jobId:int}", async (int jobId, IConfiguration config) =>
{
    using var conn = new SqlConnection(config.GetConnectionString("ConfigDb"));
    var mappings = await conn.QueryAsync<TableMapping>(
        "SELECT * FROM dbo.TableMappings WHERE JobId = @JobId ORDER BY ExecutionOrder ASC", new { JobId = jobId });
    return Results.Ok(mappings);
});

// 4B. REORDER TABLE MAPPINGS FOR JOB
app.MapPost("/api/mappings/tables/{jobId:int}/reorder", async (int jobId, [FromBody] List<ReorderItemDto> items, IConfiguration config) =>
{
    if (items == null || items.Count == 0)
    {
        return Results.BadRequest("Daftar urutan tidak boleh kosong.");
    }

    using var conn = new SqlConnection(config.GetConnectionString("ConfigDb"));
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
        return Results.Ok(new { Message = "Urutan pemetaan tabel berhasil diperbarui." });
    }
    catch
    {
        transaction.Rollback();
        throw;
    }
});

// 5. SAVE / UPDATE TABLE MAPPING
app.MapPost("/api/mappings/tables", async ([FromBody] TableMapping mapping, IConfiguration config) =>
{
    using var conn = new SqlConnection(config.GetConnectionString("ConfigDb"));
    var isNativeSql = string.Equals(mapping.MappingMode, "NATIVE_SQL", StringComparison.OrdinalIgnoreCase);
    
    // BUG-CRUD-003: Validation to prevent duplicate source or target table mappings on the same Job
    if (!isNativeSql && mapping.Id == 0)
    {
        var existing = await conn.QueryFirstOrDefaultAsync<int?>(
            "SELECT TOP 1 Id FROM dbo.TableMappings WHERE JobId = @JobId AND (SourceTableName = @SourceTableName OR TargetTableName = @TargetTableName)",
            mapping);
        if (existing != null)
        {
            return Results.BadRequest("Pemetaan untuk tabel asal atau tujuan tersebut sudah terdaftar pada Job ini!");
        }
    }
    else if (!isNativeSql)
    {
        var existing = await conn.QueryFirstOrDefaultAsync<int?>(
            "SELECT TOP 1 Id FROM dbo.TableMappings WHERE JobId = @JobId AND Id <> @Id AND (SourceTableName = @SourceTableName OR TargetTableName = @TargetTableName)",
            mapping);
        if (existing != null)
        {
            return Results.BadRequest("Pemetaan untuk tabel asal atau tujuan tersebut sudah terdaftar pada Job ini!");
        }
    }

    if (mapping.Id > 0)
    {
        await conn.ExecuteAsync(@"
            UPDATE dbo.TableMappings 
            SET SourceTableName = @SourceTableName, TargetTableName = @TargetTableName, 
                ExecutionOrder = @ExecutionOrder, TruncateTarget = @TruncateTarget, IsEnabled = @IsEnabled,
                PostMigrationScript = @PostMigrationScript, MappingMode = @MappingMode, NativeSqlScript = @NativeSqlScript
            WHERE Id = @Id", mapping);
        return Results.Ok(mapping);
    }
    else
    {
        // Tentukan urutan eksekusi terakhir + 1 jika tidak diisi atau <= 0
        if (mapping.ExecutionOrder <= 0)
        {
            var maxOrder = await conn.QueryFirstOrDefaultAsync<int?>(
                "SELECT MAX(ExecutionOrder) FROM dbo.TableMappings WHERE JobId = @JobId", new { JobId = mapping.JobId });
            mapping.ExecutionOrder = (maxOrder ?? 0) + 1;
        }

        int newId = await conn.QuerySingleAsync<int>(@"
            INSERT INTO dbo.TableMappings (JobId, SourceTableName, TargetTableName, ExecutionOrder, TruncateTarget, IsEnabled, PostMigrationScript, MappingMode, NativeSqlScript)
            VALUES (@JobId, @SourceTableName, @TargetTableName, @ExecutionOrder, @TruncateTarget, @IsEnabled, @PostMigrationScript, @MappingMode, @NativeSqlScript);
            SELECT CAST(SCOPE_IDENTITY() as int);", mapping);
        mapping.Id = newId;
        return Results.Created($"/api/mappings/tables/{newId}", mapping);
    }
});

// 6. DELETE TABLE MAPPING
app.MapDelete("/api/mappings/tables/{id:int}", async (int id, IConfiguration config) =>
{
    using var conn = new SqlConnection(config.GetConnectionString("ConfigDb"));
    await conn.ExecuteAsync("DELETE FROM dbo.TableMappings WHERE Id = @Id", new { Id = id });
    return Results.Ok();
});

// 7. GET COLUMN MAPPINGS FOR TABLE MAPPING
app.MapGet("/api/mappings/columns/{tableMappingId:int}", async (int tableMappingId, IConfiguration config) =>
{
    using var conn = new SqlConnection(config.GetConnectionString("ConfigDb"));
    var columns = await conn.QueryAsync<ColumnMapping>(
        "SELECT * FROM dbo.ColumnMappings WHERE TableMappingId = @TableMappingId", new { TableMappingId = tableMappingId });
    return Results.Ok(columns);
});

// 8. SAVE ALL COLUMN MAPPINGS FOR TABLE (BULK RE-CREATE)
app.MapPost("/api/mappings/columns/{tableMappingId:int}", async (int tableMappingId, [FromBody] List<ColumnMapping> columns, IConfiguration config) =>
{
    using var conn = new SqlConnection(config.GetConnectionString("ConfigDb"));
    await conn.OpenAsync();
    using var transaction = conn.BeginTransaction();
    
    try
    {
        // Hapus kolom mapping lama
        await conn.ExecuteAsync("DELETE FROM dbo.ColumnMappings WHERE TableMappingId = @TableMappingId", new { TableMappingId = tableMappingId }, transaction);
        
        // Masukkan kolom mapping baru
        foreach (var col in columns)
        {
            col.TableMappingId = tableMappingId;
            await conn.ExecuteAsync(@"
                INSERT INTO dbo.ColumnMappings (TableMappingId, SourceColumnName, TargetColumnName, MappingType, ConstantValue, LookupTable, LookupKeyColumn, LookupValueColumn, ExpressionSQL, IfNullAction, IfNullParam)
                VALUES (@TableMappingId, @SourceColumnName, @TargetColumnName, @MappingType, @ConstantValue, @LookupTable, @LookupKeyColumn, @LookupValueColumn, @ExpressionSQL, @IfNullAction, @IfNullParam)",
                col, transaction);
        }
        
        transaction.Commit();
        return Results.Ok(columns);
    }
    catch (Exception ex)
    {
        transaction.Rollback();
        return Results.BadRequest($"Gagal menyimpan pemetaan kolom: {ex.Message}");
    }
});

// GET /api/mappings/tables/{id:int}/generate-sp (GENERATOR STORED PROCEDURE UNTUK MIGRASI MANUAL)
app.MapGet("/api/mappings/tables/{id:int}/generate-sp", async (int id, IConfiguration config) =>
{
    using var conn = new SqlConnection(config.GetConnectionString("ConfigDb"));
    var tableMap = await conn.QuerySingleOrDefaultAsync<TableMapping>(
        "SELECT * FROM dbo.TableMappings WHERE Id = @Id", new { Id = id });
    if (tableMap == null) return Results.NotFound($"Table mapping {id} tidak ditemukan");

    var job = await conn.QuerySingleOrDefaultAsync<MigrationJob>(
        "SELECT * FROM dbo.MigrationJobs WHERE Id = @Id", new { Id = tableMap.JobId });
    if (job == null) return Results.NotFound($"Job {tableMap.JobId} tidak ditemukan");

    var columns = (await conn.QueryAsync<ColumnMapping>(
        "SELECT * FROM dbo.ColumnMappings WHERE TableMappingId = @TableMappingId", 
        new { TableMappingId = id })).ToList();

    string sourceDb = GetDatabaseName(job.SourceConnectionString);
    string targetDb = GetDatabaseName(job.TargetConnectionString);

    string sourceTableFq = FormatQualifiedTableName(sourceDb, tableMap.SourceTableName);
    string targetTableFq = FormatQualifiedTableName(targetDb, tableMap.TargetTableName);

    // Filter kolom aktif (selain tipe Ignore)
    var activeCols = columns.Where(c => !c.MappingType.Equals("Ignore", StringComparison.OrdinalIgnoreCase)).ToList();

    // JIKA kolom pemetaan belum di-save (kosong), lakukan auto-fallback ke pencocokan skema langsung dari Target DB
    if (activeCols.Count == 0)
    {
        try
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
        catch (Exception ex)
        {
            return Results.BadRequest($"Gagal mendeteksi skema otomatis: {ex.Message}");
        }
    }

    if (activeCols.Count == 0)
    {
        return Results.BadRequest("Tabel pemetaan tidak memiliki kolom aktif untuk dimigrasi dan gagal mendeteksi skema otomatis.");
    }

    var targetColsList = new List<string>();
    var selectProjections = new List<string>();

    foreach (var col in activeCols)
    {
        targetColsList.Add($"[{col.TargetColumnName}]");

        if (col.MappingType.Equals("Direct", StringComparison.OrdinalIgnoreCase))
        {
            selectProjections.Add($"Source.[{col.SourceColumnName}]");
        }
        else if (col.MappingType.Equals("Constant", StringComparison.OrdinalIgnoreCase))
        {
            string val = col.ConstantValue ?? "";
            string sqlVal = val.Replace("'", "''");
            if (decimal.TryParse(val, out _))
            {
                selectProjections.Add(sqlVal);
            }
            else
            {
                selectProjections.Add($"'{sqlVal}'");
            }
        }
        else if (col.MappingType.Equals("Expression", StringComparison.OrdinalIgnoreCase))
        {
            selectProjections.Add($"({col.ExpressionSQL})");
        }
        else if (col.MappingType.Equals("Lookup", StringComparison.OrdinalIgnoreCase))
        {
            string lookupTableFq = FormatQualifiedTableName(targetDb, col.LookupTable);
            selectProjections.Add($"(SELECT [{col.LookupValueColumn}] FROM {lookupTableFq} WHERE [{col.LookupKeyColumn}] = Source.[{col.SourceColumnName}])");
        }
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
    sb.AppendLine($"        FROM {sourceTableFq} AS Source;");
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

    return Results.Ok(new { SpName = spName, SqlScript = sb.ToString() });
});

// 9. DYNAMIC DB METADATA: GET TABLES
app.MapGet("/api/db/tables", async ([FromQuery] int jobId, [FromQuery] string dbType, IConfiguration config) =>
{
    if (jobId <= 0 || string.IsNullOrEmpty(dbType)) return Results.BadRequest("JobId atau dbType kosong");
    
    using var configConn = new SqlConnection(config.GetConnectionString("ConfigDb"));
    var job = await configConn.QuerySingleOrDefaultAsync<MigrationJob>("SELECT * FROM dbo.MigrationJobs WHERE Id = @Id", new { Id = jobId });
    if (job == null) return Results.NotFound($"Job {jobId} tidak ditemukan");

    string connectionString = dbType.Equals("source", StringComparison.OrdinalIgnoreCase) 
        ? job.SourceConnectionString 
        : job.TargetConnectionString;

    if (string.IsNullOrEmpty(connectionString)) return Results.BadRequest("Connection string kosong");

    try
    {
        using var conn = new SqlConnection(connectionString);
        await conn.OpenAsync();
        var tables = await conn.QueryAsync<string>(
            "SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME");
        return Results.Ok(tables);
    }
    catch (Exception ex)
    {
        return Results.BadRequest($"Gagal mengambil tabel: {ex.Message}");
    }
});

// 10. DYNAMIC DB METADATA: GET COLUMNS
app.MapGet("/api/db/columns", async ([FromQuery] int jobId, [FromQuery] string dbType, [FromQuery] string tableName, IConfiguration config) =>
{
    if (jobId <= 0 || string.IsNullOrEmpty(dbType) || string.IsNullOrEmpty(tableName)) 
        return Results.BadRequest("JobId, dbType, atau table name kosong");
    
    using var configConn = new SqlConnection(config.GetConnectionString("ConfigDb"));
    var job = await configConn.QuerySingleOrDefaultAsync<MigrationJob>("SELECT * FROM dbo.MigrationJobs WHERE Id = @Id", new { Id = jobId });
    if (job == null) return Results.NotFound($"Job {jobId} tidak ditemukan");

    string connectionString = dbType.Equals("source", StringComparison.OrdinalIgnoreCase) 
        ? job.SourceConnectionString 
        : job.TargetConnectionString;

    if (string.IsNullOrEmpty(connectionString)) return Results.BadRequest("Connection string kosong");

    try
    {
        using var conn = new SqlConnection(connectionString);
        await conn.OpenAsync();
        var columns = await conn.QueryAsync(
            "SELECT COLUMN_NAME, DATA_TYPE FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = @TableName ORDER BY ORDINAL_POSITION",
            new { TableName = tableName });
        return Results.Ok(columns.Select(c => new { Name = c.COLUMN_NAME, Type = c.DATA_TYPE }));
    }
    catch (Exception ex)
    {
        return Results.BadRequest($"Gagal mengambil kolom: {ex.Message}");
    }
});

// 11. RUN MIGRATION JOB (BACKGROUND PROCESS WITH REAL-TIME SIGNALR BROADCAST)
app.MapPost("/api/jobs/{id:int}/run", (int id, [FromQuery] int? mappingId, IConfiguration config, IHubContext<MigrationHub> hubContext, IHostApplicationLifetime appLifetime) =>
{
    var configDbStr = config.GetConnectionString("ConfigDb");
    
    // Create new CancellationTokenSource for this active job
    var cts = new CancellationTokenSource();
    ActiveJobTokens[id] = cts;
    
    // Linked token combining manual cancellation and server shutdown
    var linkedCts = CancellationTokenSource.CreateLinkedTokenSource(cts.Token, appLifetime.ApplicationStopping);
    var token = linkedCts.Token;

    // Jalankan di background agar API tidak memblokir browser
    _ = Task.Run(async () =>
    {
        try
        {
            var engine = new MigrationEngine(configDbStr);
            
            await engine.RunJobAsync(id, (tableName, totalRows, rowsMigrated, status, error) =>
            {
                // Kirim update real-time via SignalR ke semua browser di grup job ini
                hubContext.Clients.Group("JobGroup_" + id).SendAsync("ReceiveProgress", new
                {
                    JobId = id,
                    TableName = tableName,
                    TotalRows = totalRows,
                    RowsMigrated = rowsMigrated,
                    Status = status,
                    ErrorMessage = error
                }).GetAwaiter().GetResult();
            }, token, mappingId);
        }
        catch (Exception ex)
        {
            // Error ditangani secara individual per tabel di dalam engine, 
            // namun jika ada kegagalan job fatal, kirim ke client.
            var errorMsg = ex is OperationCanceledException ? "Proses dibatalkan oleh pengguna." : ex.Message;
            hubContext.Clients.Group("JobGroup_" + id).SendAsync("ReceiveError", new
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
    }, appLifetime.ApplicationStopping);

    return Results.Accepted("/api/jobs/" + id + "/run", new { Message = "Proses migrasi telah dimulai di background." });
});

// FEAT-001 (Interactive Migration Cancellation Endpoint)
app.MapPost("/api/jobs/{id:int}/cancel", (int id) =>
{
    if (ActiveJobTokens.TryRemove(id, out var cts))
    {
        try
        {
            cts.Cancel();
            return Results.Ok(new { Message = "Proses pembatalan berhasil dipicu." });
        }
        catch (Exception ex)
        {
            return Results.BadRequest($"Gagal membatalkan: {ex.Message}");
        }
    }
    return Results.NotFound($"Tidak ada proses migrasi aktif yang ditemukan untuk Job {id}");
});

// FEAT-004 (JSON Export Endpoint)
app.MapGet("/api/jobs/{id:int}/export", async (int id, IConfiguration config) =>
{
    using var conn = new SqlConnection(config.GetConnectionString("ConfigDb"));
    var job = await conn.QuerySingleOrDefaultAsync<MigrationJob>("SELECT * FROM dbo.MigrationJobs WHERE Id = @Id", new { Id = id });
    if (job == null) return Results.NotFound($"Job {id} tidak ditemukan");

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
            Columns = columns.Select(c => new ExportColumnMappingDto
            {
                SourceColumnName = c.SourceColumnName,
                TargetColumnName = c.TargetColumnName,
                MappingType = c.MappingType,
                ConstantValue = c.ConstantValue,
                LookupTable = c.LookupTable,
                LookupKeyColumn = c.LookupKeyColumn,
                LookupValueColumn = c.LookupValueColumn,
                ExpressionSQL = c.ExpressionSQL
            }).ToList()
        };
        export.TableMappings.Add(tDto);
    }

    return Results.Ok(export);
});

// FEAT-004 (JSON Import Endpoint)
app.MapPost("/api/jobs/import", async ([FromBody] ExportJobDto import, IConfiguration config) =>
{
    if (import == null || string.IsNullOrEmpty(import.JobName))
    {
        return Results.BadRequest("Data import tidak valid");
    }

    using var conn = new SqlConnection(config.GetConnectionString("ConfigDb"));
    await conn.OpenAsync();
    using var transaction = conn.BeginTransaction();

    try
    {
        // Periksa apakah nama job sudah ada
        string jobName = import.JobName;
        var existingJob = await conn.QueryFirstOrDefaultAsync<int?>(
            "SELECT TOP 1 Id FROM dbo.MigrationJobs WHERE JobName = @JobName", 
            new { JobName = jobName }, transaction);
        
        if (existingJob != null)
        {
            jobName += " - Imported";
        }

        // Buat Job baru
        int newJobId = await conn.QuerySingleAsync<int>(@"
            INSERT INTO dbo.MigrationJobs (JobName, SourceConnectionString, TargetConnectionString, PostMigrationScript)
            VALUES (@JobName, @SourceConnectionString, @TargetConnectionString, @PostMigrationScript);
            SELECT CAST(SCOPE_IDENTITY() as int);",
            new { JobName = jobName, SourceConnectionString = import.SourceConnectionString, TargetConnectionString = import.TargetConnectionString, PostMigrationScript = import.PostMigrationScript },
            transaction);

        // Masukkan TableMappings & ColumnMappings
        foreach (var t in import.TableMappings)
        {
            int newTableMappingId = await conn.QuerySingleAsync<int>(@"
                INSERT INTO dbo.TableMappings (JobId, SourceTableName, TargetTableName, ExecutionOrder, TruncateTarget, IsEnabled, PostMigrationScript, MappingMode, NativeSqlScript)
                VALUES (@JobId, @SourceTableName, @TargetTableName, @ExecutionOrder, @TruncateTarget, @IsEnabled, @PostMigrationScript, @MappingMode, @NativeSqlScript);
                SELECT CAST(SCOPE_IDENTITY() as int);",
                new { JobId = newJobId, SourceTableName = t.SourceTableName, TargetTableName = t.TargetTableName, ExecutionOrder = t.ExecutionOrder, TruncateTarget = t.TruncateTarget, IsEnabled = t.IsEnabled, PostMigrationScript = t.PostMigrationScript, MappingMode = string.IsNullOrWhiteSpace(t.MappingMode) ? "TABLE" : t.MappingMode, NativeSqlScript = t.NativeSqlScript },
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
        
        var newJob = new MigrationJob
        {
            Id = newJobId,
            JobName = jobName,
            SourceConnectionString = import.SourceConnectionString,
            TargetConnectionString = import.TargetConnectionString,
            PostMigrationScript = import.PostMigrationScript
        };
        return Results.Created($"/api/jobs/{newJobId}", newJob);
    }
    catch (Exception ex)
    {
        transaction.Rollback();
        return Results.BadRequest($"Gagal melakukan impor: {ex.Message}");
    }
});

// 12. GET RECENT LOGS FOR JOB
app.MapGet("/api/logs/{jobId:int}", async (int jobId, IConfiguration config) =>
{
    using var conn = new SqlConnection(config.GetConnectionString("ConfigDb"));
    var logs = await conn.QueryAsync<MigrationLog>(
        "SELECT TOP 100 * FROM dbo.MigrationLogs WHERE JobId = @JobId ORDER BY StartTime DESC", new { JobId = jobId });
    return Results.Ok(logs);
});

app.MapHub<MigrationHub>("/migrationHub");

// ============================================================================
// OBJECT MIGRATION (DDL MIGRATOR) API ENDPOINTS
// Semua endpoint sekarang menggunakan MigrationJob (unified connection)
// URL: /api/jobs/{id}/obj-* (bukan /api/obj-jobs lagi)
// ============================================================================

// OBJ-SCAN. SCAN OBJECTS FROM SOURCE DB (pakai connection dari MigrationJob)
app.MapGet("/api/jobs/{id:int}/obj-scan", async (int id, IConfiguration config) =>
{
    using var configConn = new SqlConnection(config.GetConnectionString("ConfigDb"));
    var job = await configConn.QuerySingleOrDefaultAsync<MigrationJob>(
        "SELECT * FROM dbo.MigrationJobs WHERE Id = @Id", new { Id = id });
    if (job == null) return Results.NotFound("Job tidak ditemukan.");

    try
    {
        using var srcConn = new SqlConnection(job.SourceConnectionString);
        await srcConn.OpenAsync();
        var objects = await srcConn.QueryAsync(@"
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
        return Results.Ok(objects);
    }
    catch (Exception ex)
    {
        return Results.BadRequest($"Gagal scan objek: {ex.Message}");
    }
});

// OBJ-ITEMS. GET ITEMS FOR JOB
app.MapGet("/api/jobs/{id:int}/obj-items", async (int id, IConfiguration config) =>
{
    using var conn = new SqlConnection(config.GetConnectionString("ConfigDb"));
    var items = await conn.QueryAsync<ObjectMigrationItem>(
        "SELECT * FROM dbo.ObjectMigrationItems WHERE JobId = @JobId ORDER BY ExecutionOrder ASC", new { JobId = id });
    return Results.Ok(items);
});

// OBJ-ITEMS-REORDER. REORDER ITEMS FOR JOB
app.MapPost("/api/jobs/{id:int}/obj-items/reorder", async (int id, [FromBody] List<ReorderItemDto> items, IConfiguration config) =>
{
    if (items == null || items.Count == 0)
    {
        return Results.BadRequest("Daftar urutan tidak boleh kosong.");
    }

    using var conn = new SqlConnection(config.GetConnectionString("ConfigDb"));
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
                new { item.Id, item.ExecutionOrder, JobId = id }, transaction);
        }

        transaction.Commit();
        return Results.Ok(new { Message = "Urutan migrasi objek berhasil diperbarui." });
    }
    catch
    {
        transaction.Rollback();
        throw;
    }
});

// OBJ-ITEM-SAVE. ADD/UPDATE ITEM
app.MapPost("/api/obj-items", async ([FromBody] ObjectMigrationItem item, IConfiguration config) =>
{
    using var conn = new SqlConnection(config.GetConnectionString("ConfigDb"));
    if (item.Id > 0)
    {
        await conn.ExecuteAsync(@"
            UPDATE dbo.ObjectMigrationItems 
            SET ObjectName = @ObjectName, ObjectType = @ObjectType, NativeSqlScript = @NativeSqlScript,
                ExecutionOrder = @ExecutionOrder, IsEnabled = @IsEnabled
            WHERE Id = @Id", item);
        return Results.Ok(item);
    }
    else
    {
        // Tentukan urutan eksekusi terakhir + 1 jika tidak diisi atau <= 0
        if (item.ExecutionOrder <= 0)
        {
            var maxOrder = await conn.QueryFirstOrDefaultAsync<int?>(
                "SELECT MAX(ExecutionOrder) FROM dbo.ObjectMigrationItems WHERE JobId = @JobId", new { JobId = item.JobId });
            item.ExecutionOrder = (maxOrder ?? 0) + 1;
        }

        int newId = await conn.QuerySingleAsync<int>(@"
            INSERT INTO dbo.ObjectMigrationItems (JobId, ObjectName, ObjectType, NativeSqlScript, ExecutionOrder, IsEnabled)
            VALUES (@JobId, @ObjectName, @ObjectType, @NativeSqlScript, @ExecutionOrder, @IsEnabled);
            SELECT CAST(SCOPE_IDENTITY() as int);", item);
        item.Id = newId;
        return Results.Created($"/api/obj-items/{newId}", item);
    }
});

// OBJ-ITEMS-BULK. BULK ADD ITEMS (from scan selection)
app.MapPost("/api/jobs/{id:int}/obj-items/bulk", async (int id, [FromBody] List<ObjectMigrationItem> items, IConfiguration config) =>
{
    using var conn = new SqlConnection(config.GetConnectionString("ConfigDb"));
    await conn.OpenAsync();
    int order = 1;
    foreach (var item in items)
    {
        item.JobId = id;
        item.ExecutionOrder = order++;
        item.IsEnabled = true;
        await conn.ExecuteAsync(@"
            IF NOT EXISTS (SELECT 1 FROM dbo.ObjectMigrationItems WHERE JobId = @JobId AND ObjectName = @ObjectName AND ObjectType = @ObjectType)
            INSERT INTO dbo.ObjectMigrationItems (JobId, ObjectName, ObjectType, NativeSqlScript, ExecutionOrder, IsEnabled)
            VALUES (@JobId, @ObjectName, @ObjectType, @NativeSqlScript, @ExecutionOrder, @IsEnabled);", item);
    }
    return Results.Ok(new { Message = $"{items.Count} objek berhasil ditambahkan." });
});

// OBJ-ITEM-DELETE. DELETE ITEM
app.MapDelete("/api/obj-items/{id:int}", async (int id, IConfiguration config) =>
{
    using var conn = new SqlConnection(config.GetConnectionString("ConfigDb"));
    await conn.ExecuteAsync("DELETE FROM dbo.ObjectMigrationItems WHERE Id = @Id", new { Id = id });
    return Results.Ok();
});

// OBJ-BACKUPS. GET BACKUPS FOR ITEM
app.MapGet("/api/obj-items/{id:int}/backups", async (int id, IConfiguration config) =>
{
    using var conn = new SqlConnection(config.GetConnectionString("ConfigDb"));
    var backups = await conn.QueryAsync<ObjectMigrationBackup>(
        "SELECT * FROM dbo.ObjectMigrationBackups WHERE ItemId = @ItemId ORDER BY Version DESC", new { ItemId = id });
    return Results.Ok(backups);
});

// OBJ-BACKUP-DOWNLOAD. DOWNLOAD BACKUP AS .SQL FILE
app.MapGet("/api/obj-backups/{id:int}/download", async (int id, IConfiguration config) =>
{
    using var conn = new SqlConnection(config.GetConnectionString("ConfigDb"));
    var backup = await conn.QuerySingleOrDefaultAsync<ObjectMigrationBackup>(
        "SELECT * FROM dbo.ObjectMigrationBackups WHERE Id = @Id", new { Id = id });
    if (backup == null) return Results.NotFound();

    var bytes = System.Text.Encoding.UTF8.GetBytes(backup.BackupScript);
    return Results.File(bytes, "application/sql", $"backup_v{backup.Version}_{backup.BackedUpAt:yyyyMMdd_HHmmss}.sql");
});

// OBJ-LOGS. GET LOGS FOR JOB
app.MapGet("/api/jobs/{id:int}/obj-logs", async (int id, IConfiguration config) =>
{
    using var conn = new SqlConnection(config.GetConnectionString("ConfigDb"));
    var logs = await conn.QueryAsync<ObjectMigrationLog>(
        "SELECT TOP 200 * FROM dbo.ObjectMigrationLogs WHERE JobId = @JobId ORDER BY ExecutedAt DESC", new { JobId = id });
    return Results.Ok(logs);
});

// OBJ-RUN. RUN OBJECT MIGRATION JOB (pakai MigrationJob connection)
app.MapPost("/api/jobs/{id:int}/obj-run", async (int id, [FromQuery] int? itemId, IConfiguration config) =>
{
    var configDbStr = config.GetConnectionString("ConfigDb");

    using var configConn = new SqlConnection(configDbStr);
    await configConn.OpenAsync();

    // Ambil MigrationJob (bukan ObjectMigrationJob)
    var job = await configConn.QuerySingleOrDefaultAsync<MigrationJob>(
        "SELECT * FROM dbo.MigrationJobs WHERE Id = @Id", new { Id = id });
    if (job == null) return Results.NotFound("Job tidak ditemukan.");

    List<ObjectMigrationItem> items;
    if (itemId.HasValue)
    {
        items = (await configConn.QueryAsync<ObjectMigrationItem>(
            "SELECT * FROM dbo.ObjectMigrationItems WHERE Id = @Id AND JobId = @JobId AND IsEnabled = 1",
            new { Id = itemId.Value, JobId = id })).ToList();
    }
    else
    {
        items = (await configConn.QueryAsync<ObjectMigrationItem>(
            "SELECT * FROM dbo.ObjectMigrationItems WHERE JobId = @JobId AND IsEnabled = 1 ORDER BY ExecutionOrder ASC",
            new { JobId = id })).ToList();
    }

    if (items.Count == 0) return Results.BadRequest("Tidak ada objek aktif untuk dimigrasi.");

    var results = new List<object>();

    foreach (var item in items)
    {
        // Done-Skipping Check (hanya jika eksekusi massal / bukan single play)
        if (!itemId.HasValue && string.Equals(item.LastStatus, "Completed", StringComparison.OrdinalIgnoreCase))
        {
            results.Add(new { ObjectName = item.ObjectName, Status = "Completed", Message = "Skipped (Already migrated)" });
            continue;
        }

        try
        {
            // Set status to InProgress
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
                    new { JobId = id, ObjectName = item.ObjectName });

                results.Add(new { ObjectName = item.ObjectName, Status = "Completed", Message = "Native SQL executed successfully." });
            }
            else if (item.ObjectType == "TABLE")
            {
                await MigrateTableObject(configConn, job, item, id);
                results.Add(new { ObjectName = item.ObjectName, Status = "Completed", Message = "Table synced." });
            }
            else
            {
                await MigrateCodeObject(configConn, job, item, id);
                results.Add(new { ObjectName = item.ObjectName, Status = "Completed", Message = $"{item.ObjectType} migrated." });
            }

            // Update to Completed
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
                new { JobId = id, ObjectName = item.ObjectName, Action = item.ObjectType, ErrorMessage = ex.Message });

            // Update to Failed
            await configConn.ExecuteAsync(@"
                UPDATE dbo.ObjectMigrationItems
                SET LastStatus = 'Failed', LastErrorMessage = @Error, LastRunAt = GETDATE()
                WHERE Id = @Id", new { Error = ex.Message, Id = item.Id });

            results.Add(new { ObjectName = item.ObjectName, Status = "Failed", Message = ex.Message });
        }
    }

    return Results.Ok(new { Message = "Migrasi objek selesai.", Results = results });
});

// ============================================================================
// CLEAN TARGET TABLE API ENDPOINTS
// ============================================================================

// 1. GET ALL CLEAN TABLES FOR JOB
app.MapGet("/api/jobs/{jobId:int}/clean-tables", async (int jobId, IConfiguration config) =>
{
    using var conn = new SqlConnection(config.GetConnectionString("ConfigDb"));
    var tables = await conn.QueryAsync<CleanTargetTable>(
        "SELECT * FROM dbo.CleanTargetTables WHERE JobId = @JobId ORDER BY ExecutionOrder ASC", new { JobId = jobId });
    return Results.Ok(tables);
});

// 2. ADD CLEAN TABLES (SUPPORT COMMA-SEPARATED BULK)
app.MapPost("/api/jobs/{jobId:int}/clean-tables", async (int jobId, [FromBody] CleanTableRequest request, IConfiguration config) =>
{
    if (request == null || string.IsNullOrWhiteSpace(request.TableNames))
    {
        return Results.BadRequest("Nama tabel tidak boleh kosong.");
    }

    using var conn = new SqlConnection(config.GetConnectionString("ConfigDb"));
    await conn.OpenAsync();

    var tableNames = request.TableNames
        .Split(new[] { ',', '\n', '\r' }, StringSplitOptions.RemoveEmptyEntries)
        .Select(t => t.Trim())
        .Where(t => !string.IsNullOrEmpty(t))
        .ToList();

    if (tableNames.Count == 0)
    {
        return Results.BadRequest("Nama tabel tidak valid.");
    }

    var addedTables = new List<string>();
    var skippedTables = new List<string>();

    using var transaction = conn.BeginTransaction();
    try
    {
        // Ambil order terakhir
        int maxOrder = await conn.QueryFirstOrDefaultAsync<int>(
            "SELECT ISNULL(MAX(ExecutionOrder), 0) FROM dbo.CleanTargetTables WHERE JobId = @JobId", 
            new { JobId = jobId }, transaction);

        foreach (var tableName in tableNames)
        {
            // Cek apakah sudah terdaftar
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
        return Results.Ok(new { 
            Message = "Proses penambahan selesai.", 
            Added = addedTables, 
            Skipped = skippedTables 
        });
    }
    catch (Exception ex)
    {
        transaction.Rollback();
        return Results.BadRequest($"Gagal menambahkan tabel: {ex.Message}");
    }
});

// 3. DELETE CLEAN TABLE
app.MapDelete("/api/clean-tables/{id:int}", async (int id, IConfiguration config) =>
{
    using var conn = new SqlConnection(config.GetConnectionString("ConfigDb"));
    await conn.ExecuteAsync("DELETE FROM dbo.CleanTargetTables WHERE Id = @Id", new { Id = id });
    return Results.Ok();
});

// 4. REORDER CLEAN TABLES
app.MapPost("/api/jobs/{jobId:int}/clean-tables/reorder", async (int jobId, [FromBody] List<ReorderItemDto> items, IConfiguration config) =>
{
    if (items == null || items.Count == 0)
    {
        return Results.BadRequest("Daftar urutan tidak boleh kosong.");
    }

    using var conn = new SqlConnection(config.GetConnectionString("ConfigDb"));
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
        return Results.Ok(new { Message = "Urutan tabel pembersih berhasil diperbarui." });
    }
    catch (Exception ex)
    {
        transaction.Rollback();
        return Results.BadRequest($"Gagal memperbarui urutan: {ex.Message}");
    }
});

// 5. RUN CLEANING (DELETE & RESEED IDENTITY, HANDLE FK GRACEFULLY)
app.MapPost("/api/jobs/{jobId:int}/clean-tables/run", async (int jobId, [FromQuery] int? id, IConfiguration config) =>
{
    var configDbStr = config.GetConnectionString("ConfigDb");
    using var configConn = new SqlConnection(configDbStr);
    await configConn.OpenAsync();

    // 1. Ambil Job koneksi
    var job = await configConn.QuerySingleOrDefaultAsync<MigrationJob>(
        "SELECT * FROM dbo.MigrationJobs WHERE Id = @Id", new { Id = jobId });
    if (job == null) return Results.NotFound("Job tidak ditemukan.");

    // 2. Ambil tabel yang akan dibersihkan
    List<CleanTargetTable> tablesToClean;
    if (id.HasValue)
    {
        var singleTable = await configConn.QuerySingleOrDefaultAsync<CleanTargetTable>(
            "SELECT * FROM dbo.CleanTargetTables WHERE Id = @Id AND JobId = @JobId", 
            new { Id = id.Value, JobId = jobId });
        if (singleTable == null) return Results.NotFound("Tabel tidak terdaftar dalam daftar pembersih.");
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
        return Results.BadRequest("Tidak ada tabel untuk dibersihkan.");
    }

    var results = new List<object>();

    using var targetConn = new SqlConnection(job.TargetConnectionString);
    await targetConn.OpenAsync();

    foreach (var table in tablesToClean)
    {
        // Done-Skipping Check (hanya jika eksekusi massal / bukan single play)
        if (!id.HasValue && string.Equals(table.LastStatus, "Completed", StringComparison.OrdinalIgnoreCase))
        {
            results.Add(new { Id = table.Id, TableName = table.TableName, Status = "Completed", Message = "Skipped (Already cleaned)" });
            continue;
        }

        try
        {
            // Set status to InProgress
            await configConn.ExecuteAsync(@"
                UPDATE dbo.CleanTargetTables
                SET LastStatus = 'InProgress', LastErrorMessage = NULL
                WHERE Id = @Id", new { Id = table.Id });

            var quotedTable = SafeQuoteTable(table.TableName);

            // A. DELETE DATA
            var deleteQuery = $"DELETE FROM {quotedTable}";
            await targetConn.ExecuteAsync(deleteQuery);

            // B. CHECK & RESEED IDENTITY (Jika ada kolom Identity)
            var hasIdentity = await targetConn.QueryFirstOrDefaultAsync<int?>(
                $"SELECT OBJECTPROPERTY(OBJECT_ID('{quotedTable.Replace("'", "''")}'), 'TableHasIdentity')");

            string msg = "Data deleted.";
            if (hasIdentity == 1)
            {
                var reseedQuery = $"DBCC CHECKIDENT ('{quotedTable.Replace("'", "''")}', RESEED, 0)";
                await targetConn.ExecuteAsync(reseedQuery);
                msg = "Data deleted and Identity reseeded to 0.";
            }

            // Update to Completed
            await configConn.ExecuteAsync(@"
                UPDATE dbo.CleanTargetTables
                SET LastStatus = 'Completed', LastErrorMessage = NULL, LastCleanedAt = GETDATE()
                WHERE Id = @Id", new { Id = table.Id });

            results.Add(new { Id = table.Id, TableName = table.TableName, Status = "Completed", Message = msg });
        }
        catch (Exception ex)
        {
            // Catch error gracefully (e.g. FK constraint) and log it
            await configConn.ExecuteAsync(@"
                UPDATE dbo.CleanTargetTables
                SET LastStatus = 'Failed', LastErrorMessage = @Error, LastCleanedAt = GETDATE()
                WHERE Id = @Id", new { Error = ex.Message, Id = table.Id });

            results.Add(new { Id = table.Id, TableName = table.TableName, Status = "Failed", Message = ex.Message });
        }
    }

    return Results.Ok(new { Message = "Proses pembersihan selesai.", Results = results });
});

// 6. GENERATE UNIFIED CLEAN SP FOR ALL TABLES
app.MapGet("/api/jobs/{jobId:int}/clean-tables/generate-sp", async (int jobId, IConfiguration config) =>
{
    using var conn = new SqlConnection(config.GetConnectionString("ConfigDb"));
    var job = await conn.QuerySingleOrDefaultAsync<MigrationJob>(
        "SELECT * FROM dbo.MigrationJobs WHERE Id = @Id", new { Id = jobId });
    if (job == null) return Results.NotFound($"Job {jobId} tidak ditemukan");

    var tables = (await conn.QueryAsync<CleanTargetTable>(
        "SELECT * FROM dbo.CleanTargetTables WHERE JobId = @JobId ORDER BY ExecutionOrder ASC", 
        new { JobId = jobId })).ToList();

    if (tables.Count == 0)
    {
        return Results.BadRequest("Tidak ada tabel terdaftar untuk dibersihkan pada Job ini.");
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

    return Results.Ok(new { SpName = spName, SqlScript = sb.ToString() });
});

// ============================================================================
// RESET STATUS ENDPOINTS (DATA, OBJECT, CLEAN)
// ============================================================================

// 1. Reset Clean Target Tables
app.MapPost("/api/jobs/{jobId:int}/clean-tables/reset-status", async (int jobId, IConfiguration config) =>
{
    using var conn = new SqlConnection(config.GetConnectionString("ConfigDb"));
    await conn.OpenAsync();

    var job = await conn.QuerySingleOrDefaultAsync<MigrationJob>(
        "SELECT * FROM dbo.MigrationJobs WHERE Id = @Id", new { Id = jobId });
    if (job == null) return Results.NotFound("Job tidak ditemukan.");

    await conn.ExecuteAsync(@"
        UPDATE dbo.CleanTargetTables
        SET LastStatus = 'Pending', LastErrorMessage = NULL, LastCleanedAt = NULL
        WHERE JobId = @JobId", new { JobId = jobId });

    return Results.Ok(new { Message = "Status pembersihan berhasil direset ke Pending." });
});

// 2. Reset Data Migration Mappings
app.MapPost("/api/jobs/{jobId:int}/mappings/reset-status", async (int jobId, IConfiguration config) =>
{
    using var conn = new SqlConnection(config.GetConnectionString("ConfigDb"));
    await conn.OpenAsync();

    var job = await conn.QuerySingleOrDefaultAsync<MigrationJob>(
        "SELECT * FROM dbo.MigrationJobs WHERE Id = @Id", new { Id = jobId });
    if (job == null) return Results.NotFound("Job tidak ditemukan.");

    await conn.ExecuteAsync(@"
        UPDATE dbo.TableMappings
        SET LastStatus = 'Pending', LastErrorMessage = NULL, LastRunAt = NULL
        WHERE JobId = @JobId", new { JobId = jobId });

    return Results.Ok(new { Message = "Status pemetaan data berhasil direset ke Pending." });
});

// 3. Reset Object Migration Items
app.MapPost("/api/jobs/{jobId:int}/obj-items/reset-status", async (int jobId, IConfiguration config) =>
{
    using var conn = new SqlConnection(config.GetConnectionString("ConfigDb"));
    await conn.OpenAsync();

    var job = await conn.QuerySingleOrDefaultAsync<MigrationJob>(
        "SELECT * FROM dbo.MigrationJobs WHERE Id = @Id", new { Id = jobId });
    if (job == null) return Results.NotFound("Job tidak ditemukan.");

    await conn.ExecuteAsync(@"
        UPDATE dbo.ObjectMigrationItems
        SET LastStatus = 'Pending', LastErrorMessage = NULL, LastRunAt = NULL
        WHERE JobId = @JobId", new { JobId = jobId });

    return Results.Ok(new { Message = "Status objek migrasi berhasil direset ke Pending." });
});

app.Run();

// ============================================================================
// SAFE QUOTING UTILITY FOR SQL SERVER
// ============================================================================
string SafeQuoteTable(string tableName)
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

// ============================================================================
// OBJECT MIGRATION HELPER FUNCTIONS
// ============================================================================
string ResolveNativeSqlScript(MigrationJob job, string script)
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

string NormalizeSqlDataSource(string dataSource)
{
    return (dataSource ?? string.Empty)
        .Trim()
        .Replace("tcp:", "", StringComparison.OrdinalIgnoreCase)
        .Replace(" ", "");
}

string QuoteSqlIdentifier(string identifier)
{
    if (string.IsNullOrWhiteSpace(identifier))
    {
        throw new InvalidOperationException("Connection string Source/Target harus memiliki nama database.");
    }

    return $"[{identifier.Replace("]", "]]")}]";
}

async Task MigrateCodeObject(SqlConnection configConn, MigrationJob job, ObjectMigrationItem item, int jobId)
{
    // 1. Backup existing object from Target DB (if exists)
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

    // 2. Get source definition
    using var srcConn = new SqlConnection(job.SourceConnectionString);
    await srcConn.OpenAsync();

    string srcDef = await srcConn.QuerySingleOrDefaultAsync<string>(
        "SELECT OBJECT_DEFINITION(OBJECT_ID(@ObjName))", new { ObjName = item.ObjectName });

    if (string.IsNullOrEmpty(srcDef))
        throw new Exception($"Definisi objek '{item.ObjectName}' tidak ditemukan di Source DB.");

    // 3. Drop from Target
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

    // 4. Create in Target using source definition
    await targetConn.ExecuteAsync(srcDef);

    await configConn.ExecuteAsync(@"
        INSERT INTO dbo.ObjectMigrationLogs (JobId, ObjectName, Action, Status)
        VALUES (@JobId, @ObjectName, 'CREATE', 'Completed')",
        new { JobId = jobId, ObjectName = item.ObjectName });
}

async Task MigrateTableObject(SqlConnection configConn, MigrationJob job, ObjectMigrationItem item, int jobId)
{
    using var targetConn = new SqlConnection(job.TargetConnectionString);
    await targetConn.OpenAsync();

    using var srcConn = new SqlConnection(job.SourceConnectionString);
    await srcConn.OpenAsync();

    var cleanName = item.ObjectName.Contains('.') ? item.ObjectName.Split('.').Last() : item.ObjectName;
    var schemaName = item.ObjectName.Contains('.') ? item.ObjectName.Split('.').First() : "dbo";

    // Check if table exists in target
    bool tableExistsInTarget = (await targetConn.QuerySingleOrDefaultAsync<int>(
        "SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = @Schema AND TABLE_NAME = @Table",
        new { Schema = schemaName, Table = cleanName })) > 0;

    if (!tableExistsInTarget)
    {
        // CREATE TABLE from Source schema
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

        // Get Primary Key
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

        // Create indexes from source
        await SyncIndexes(srcConn, targetConn, schemaName, cleanName);

        await configConn.ExecuteAsync(@"
            INSERT INTO dbo.ObjectMigrationLogs (JobId, ObjectName, Action, Status)
            VALUES (@JobId, @ObjectName, 'CREATE', 'Completed')",
            new { JobId = jobId, ObjectName = item.ObjectName });
    }
    else
    {
        // ALTER TABLE SYNC: backup old schema, then compare & sync columns
        // 1. Backup current schema
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

        // 2. Compare columns
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

        // ADD columns that exist in Source but NOT in Target
        foreach (var srcCol in srcCols)
        {
            string colName = srcCol.COLUMN_NAME;
            if (!tgtColNames.Contains(colName, StringComparer.OrdinalIgnoreCase))
            {
                string typeDef = BuildColumnTypeDef(srcCol);
                await targetConn.ExecuteAsync($"ALTER TABLE [{schemaName}].[{cleanName}] ADD [{colName}] {typeDef}");
            }
        }

        // DROP columns that exist in Target but NOT in Source
        foreach (var tgtCol in tgtCols)
        {
            string colName = tgtCol.COLUMN_NAME;
            if (!srcColNames.Contains(colName, StringComparer.OrdinalIgnoreCase))
            {
                // Check if column is part of a constraint before dropping
                try
                {
                    await targetConn.ExecuteAsync($"ALTER TABLE [{schemaName}].[{cleanName}] DROP COLUMN [{colName}]");
                }
                catch { /* Skip columns that can't be dropped (PK, FK constraints) */ }
            }
        }

        // Sync indexes
        await SyncIndexes(srcConn, targetConn, schemaName, cleanName);

        await configConn.ExecuteAsync(@"
            INSERT INTO dbo.ObjectMigrationLogs (JobId, ObjectName, Action, Status)
            VALUES (@JobId, @ObjectName, 'ALTER', 'Completed')",
            new { JobId = jobId, ObjectName = item.ObjectName });
    }
}

string BuildColumnTypeDef(dynamic col)
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

async Task<string> GenerateTableBackupScript(SqlConnection conn, string schema, string table)
{
    var sb = new System.Text.StringBuilder();
    sb.AppendLine($"-- Backup of [{schema}].[{table}] at {DateTime.Now:yyyy-MM-dd HH:mm:ss}");
    sb.AppendLine();

    // Columns
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

    // Primary Key
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

    // Indexes
    var indexes = await conn.QueryAsync(@"
        SELECT i.name AS IndexName, i.type_desc AS IndexType, i.is_unique AS IsUnique,
               STRING_AGG(c.name, ', ') WITHIN GROUP (ORDER BY ic.key_ordinal) AS ColumnNames
        FROM sys.indexes i
        JOIN sys.index_columns ic ON i.object_id = ic.object_id AND i.index_id = ic.index_id
        JOIN sys.columns c ON ic.object_id = c.object_id AND ic.column_id = c.column_id
        WHERE i.object_id = OBJECT_ID(@FullName) AND i.is_primary_key = 0 AND i.type > 0
        GROUP BY i.name, i.type_desc, i.is_unique",
        new { FullName = $"{schema}.{table}" });

    foreach (var idx in indexes)
    {
        string unique = (bool)idx.IsUnique ? "UNIQUE " : "";
        sb.AppendLine($"CREATE {unique}INDEX [{idx.IndexName}] ON [{schema}].[{table}] ({idx.ColumnNames});");
    }

    return sb.ToString();
}

async Task SyncIndexes(SqlConnection srcConn, SqlConnection targetConn, string schema, string table)
{
    var srcIndexes = await srcConn.QueryAsync(@"
        SELECT i.name AS IndexName, i.is_unique AS IsUnique,
               STRING_AGG(c.name, ', ') WITHIN GROUP (ORDER BY ic.key_ordinal) AS ColumnNames
        FROM sys.indexes i
        JOIN sys.index_columns ic ON i.object_id = ic.object_id AND i.index_id = ic.index_id
        JOIN sys.columns c ON ic.object_id = c.object_id AND ic.column_id = c.column_id
        WHERE i.object_id = OBJECT_ID(@FullName) AND i.is_primary_key = 0 AND i.type > 0
        GROUP BY i.name, i.is_unique",
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
            catch { /* Index creation may fail if columns don't exist yet - skip */ }
        }
    }
}



// ============================================================================
// HELPER FUNCTIONS FOR STORED PROCEDURE GENERATION
// ============================================================================
string GetDatabaseName(string connectionString)
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

string FormatQualifiedTableName(string dbName, string tableName)
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

// ============================================================================
// DATA TRANSFER OBJECTS (DTOs)
// ============================================================================
public class TestConnectionRequest
{
    public string ConnectionString { get; set; }
}

public class ReorderItemDto
{
    public int Id { get; set; }
    public int ExecutionOrder { get; set; }
}

public class ExportJobDto
{
    public string JobName { get; set; }
    public string SourceConnectionString { get; set; }
    public string TargetConnectionString { get; set; }
    public string PostMigrationScript { get; set; }
    public List<ExportTableMappingDto> TableMappings { get; set; } = new();
}

public class ExportTableMappingDto
{
    public string SourceTableName { get; set; }
    public string TargetTableName { get; set; }
    public int ExecutionOrder { get; set; }
    public bool TruncateTarget { get; set; }
    public bool IsEnabled { get; set; }
    public string MappingMode { get; set; }
    public string NativeSqlScript { get; set; }
    public string PostMigrationScript { get; set; }
    public List<ExportColumnMappingDto> Columns { get; set; } = new();
}

public class ExportColumnMappingDto
{
    public string SourceColumnName { get; set; }
    public string TargetColumnName { get; set; }
    public string MappingType { get; set; }
    public string ConstantValue { get; set; }
    public string LookupTable { get; set; }
    public string LookupKeyColumn { get; set; }
    public string LookupValueColumn { get; set; }
    public string ExpressionSQL { get; set; }
    public string IfNullAction { get; set; }
    public string IfNullParam { get; set; }
}
