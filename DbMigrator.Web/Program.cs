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
            WHERE object_id = OBJECT_ID('dbo.MigrationJobs') AND name = 'BackupPath'
        )
        BEGIN
            ALTER TABLE dbo.MigrationJobs ADD BackupPath NVARCHAR(500) NULL;
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

        IF NOT EXISTS (
            SELECT * FROM sys.columns
            WHERE object_id = OBJECT_ID('dbo.TableMappings') AND name = 'WhereClause'
        )
        BEGIN
            ALTER TABLE dbo.TableMappings ADD WhereClause NVARCHAR(MAX) NULL;
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
                IsEnabled BIT NOT NULL DEFAULT 1,
                AllowDropColumns BIT NOT NULL DEFAULT 0
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

        -- Ensure TableMappings has LastRowsMigrated column
        IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID('dbo.TableMappings') AND name = 'LastRowsMigrated')
        BEGIN
            ALTER TABLE dbo.TableMappings ADD LastRowsMigrated INT NOT NULL DEFAULT 0;
        END

        -- Ensure ObjectMigrationItems has status columns
        IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID('dbo.ObjectMigrationItems') AND name = 'LastStatus')
        BEGIN
            ALTER TABLE dbo.ObjectMigrationItems ADD LastStatus NVARCHAR(50) NOT NULL DEFAULT 'Pending';
            ALTER TABLE dbo.ObjectMigrationItems ADD LastErrorMessage NVARCHAR(MAX) NULL;
            ALTER TABLE dbo.ObjectMigrationItems ADD LastRunAt DATETIME NULL;
        END

        -- Ensure ObjectMigrationItems has AllowDropColumns column
        IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID('dbo.ObjectMigrationItems') AND name = 'AllowDropColumns')
        BEGIN
            ALTER TABLE dbo.ObjectMigrationItems ADD AllowDropColumns BIT NOT NULL DEFAULT 0;
        END

        -- Ensure ColumnMappings has IfNull strategy columns (F-04: If-Null Fallback)
        IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID('dbo.ColumnMappings') AND name = 'IfNullAction')
        BEGIN
            ALTER TABLE dbo.ColumnMappings ADD IfNullAction NVARCHAR(50) NULL;
            ALTER TABLE dbo.ColumnMappings ADD IfNullParam NVARCHAR(500) NULL;
        END

        -- Ensure SavedConnections table exists
        IF NOT EXISTS (SELECT * FROM sys.objects WHERE object_id = OBJECT_ID('dbo.SavedConnections') AND type in ('U'))
        BEGIN
            CREATE TABLE dbo.SavedConnections (
                Id INT IDENTITY(1,1) PRIMARY KEY,
                ConnectionName NVARCHAR(255) NOT NULL,
                ServerName NVARCHAR(255) NOT NULL,
                Authentication NVARCHAR(50) NOT NULL,
                Login NVARCHAR(255) NULL,
                Password NVARCHAR(255) NULL,
                CreatedAt DATETIME NOT NULL DEFAULT GETDATE()
            );
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
            SET JobName = @JobName, SourceConnectionString = @SourceConnectionString, TargetConnectionString = @TargetConnectionString, PostMigrationScript = @PostMigrationScript, BackupPath = @BackupPath
            WHERE Id = @Id", job);
        return Results.Ok(job);
    }
    else
    {
        int newId = await conn.QuerySingleAsync<int>(@"
            INSERT INTO dbo.MigrationJobs (JobName, SourceConnectionString, TargetConnectionString, PostMigrationScript, BackupPath)
            VALUES (@JobName, @SourceConnectionString, @TargetConnectionString, @PostMigrationScript, @BackupPath);
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
    
    // BUG-CRUD-003: Validation to prevent duplicate source or target table mappings on the same Job (ignoring NATIVE_SQL steps)
    if (!isNativeSql && mapping.Id == 0)
    {
        var existing = await conn.QueryFirstOrDefaultAsync<int?>(
            "SELECT TOP 1 Id FROM dbo.TableMappings WHERE JobId = @JobId AND MappingMode = 'TABLE' AND (SourceTableName = @SourceTableName OR TargetTableName = @TargetTableName)",
            mapping);
        if (existing != null)
        {
            return Results.BadRequest("Pemetaan untuk tabel asal atau tujuan tersebut sudah terdaftar pada Job ini!");
        }
    }
    else if (!isNativeSql)
    {
        var existing = await conn.QueryFirstOrDefaultAsync<int?>(
            "SELECT TOP 1 Id FROM dbo.TableMappings WHERE JobId = @JobId AND Id <> @Id AND MappingMode = 'TABLE' AND (SourceTableName = @SourceTableName OR TargetTableName = @TargetTableName)",
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
                PostMigrationScript = @PostMigrationScript, MappingMode = @MappingMode, NativeSqlScript = @NativeSqlScript,
                WhereClause = @WhereClause
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
            INSERT INTO dbo.TableMappings (JobId, SourceTableName, TargetTableName, ExecutionOrder, TruncateTarget, IsEnabled, PostMigrationScript, MappingMode, NativeSqlScript, WhereClause)
            VALUES (@JobId, @SourceTableName, @TargetTableName, @ExecutionOrder, @TruncateTarget, @IsEnabled, @PostMigrationScript, @MappingMode, @NativeSqlScript, @WhereClause);
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

        // Apply "If Null" strategy in generated SQL Stored Procedure
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
        var columns = await conn.QueryAsync(@"
            SELECT COLUMN_NAME, DATA_TYPE, CHARACTER_MAXIMUM_LENGTH, NUMERIC_PRECISION, NUMERIC_SCALE 
            FROM INFORMATION_SCHEMA.COLUMNS 
            WHERE TABLE_NAME = @TableName 
            ORDER BY ORDINAL_POSITION",
            new { TableName = tableName });
            
        var result = columns.Select(c => {
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
        return Results.Ok(result);
    }
    catch (Exception ex)
    {
        return Results.BadRequest($"Gagal mengambil kolom: {ex.Message}");
    }
});

// 10a. DYNAMIC DB METADATA: COMPARE SOURCE VS TARGET SCHEMA
app.MapGet("/api/db/schema-comparison", async ([FromQuery] int jobId, IConfiguration config) =>
{
    if (jobId <= 0) return Results.BadRequest("JobId kosong");

    using var configConn = new SqlConnection(config.GetConnectionString("ConfigDb"));
    var job = await configConn.QuerySingleOrDefaultAsync<MigrationJob>("SELECT * FROM dbo.MigrationJobs WHERE Id = @Id", new { Id = jobId });
    if (job == null) return Results.NotFound($"Job {jobId} tidak ditemukan");
    if (string.IsNullOrWhiteSpace(job.SourceConnectionString) || string.IsNullOrWhiteSpace(job.TargetConnectionString))
        return Results.BadRequest("Connection string Source atau Target kosong");

    try
    {
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
                    item.Info = string.Join("<br>", differences.Select(EscapeHtml));
                    item.ColumnSync = BuildColumnSyncPlan(sourceObj, targetObj);
                }
            }
            else if (NormalizeDdl(sourceObj.Ddl) == NormalizeDdl(targetObj.Ddl))
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

        return Results.Ok(new { Summary = summary, Items = items });
    }
    catch (Exception ex)
    {
        return Results.BadRequest($"Gagal membandingkan skema: {ex.Message}");
    }
});

// 10b. DYNAMIC DB METADATA: GET ENTIRE SCHEMA (FOR AUTOCOMPLETE)
app.MapGet("/api/db/schema", async ([FromQuery] int jobId, [FromQuery] string dbType, IConfiguration config) =>
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

        return Results.Ok(new { Objects = objects, Columns = columns });
    }
    catch (Exception ex)
    {
        return Results.BadRequest($"Gagal mengambil skema database: {ex.Message}");
    }
});

// ============================================================================
// SSMS-LITE QUERY CONSOLE ENDPOINTS
// ============================================================================

// 0. SHARED CONNECTION HISTORY ENDPOINTS
app.MapGet("/api/query/connections", async (IConfiguration config) =>
{
    try
    {
        using var conn = new SqlConnection(config.GetConnectionString("ConfigDb"));
        var connections = await conn.QueryAsync<SavedConnection>(
            "SELECT Id, ConnectionName, ServerName, Authentication, Login, Password, CreatedAt FROM dbo.SavedConnections ORDER BY ConnectionName ASC");
        return Results.Ok(connections);
    }
    catch (Exception ex)
    {
        return Results.BadRequest(new { Success = false, Message = $"Gagal mengambil daftar koneksi: {ex.Message}" });
    }
});

app.MapPost("/api/query/connections", async ([FromBody] SavedConnection request, IConfiguration config) =>
{
    if (string.IsNullOrEmpty(request?.ConnectionName) || string.IsNullOrEmpty(request?.ServerName))
    {
        return Results.BadRequest(new { Success = false, Message = "Nama Koneksi dan Server Name tidak boleh kosong" });
    }

    try
    {
        using var conn = new SqlConnection(config.GetConnectionString("ConfigDb"));
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
            return Results.Ok(new { Success = true, Message = "Koneksi berhasil diperbarui", Id = existing.Value });
        }
        else
        {
            var id = await conn.QuerySingleAsync<int>(@"
                INSERT INTO dbo.SavedConnections (ConnectionName, ServerName, Authentication, Login, Password, CreatedAt)
                VALUES (@ConnectionName, @ServerName, @Authentication, @Login, @Password, GETDATE());
                SELECT CAST(SCOPE_IDENTITY() as int);", 
                request);
            return Results.Ok(new { Success = true, Message = "Koneksi berhasil disimpan", Id = id });
        }
    }
    catch (Exception ex)
    {
        return Results.BadRequest(new { Success = false, Message = $"Gagal menyimpan koneksi: {ex.Message}" });
    }
});

app.MapDelete("/api/query/connections/{id:int}", async (int id, IConfiguration config) =>
{
    try
    {
        using var conn = new SqlConnection(config.GetConnectionString("ConfigDb"));
        var deleted = await conn.ExecuteAsync("DELETE FROM dbo.SavedConnections WHERE Id = @id", new { id });
        if (deleted > 0)
        {
            return Results.Ok(new { Success = true, Message = "Koneksi berhasil dihapus" });
        }
        return Results.NotFound(new { Success = false, Message = "Koneksi tidak ditemukan" });
    }
    catch (Exception ex)
    {
        return Results.BadRequest(new { Success = false, Message = $"Gagal menghapus koneksi: {ex.Message}" });
    }
});

// A. CONNECT TO SERVER (Gets list of databases)
app.MapPost("/api/query/connect", async ([FromBody] QueryConnectRequest request) =>
{
    if (string.IsNullOrEmpty(request?.ServerName))
    {
        return Results.BadRequest(new { Success = false, Message = "Server name tidak boleh kosong" });
    }

    string connectionString = "";
    try
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

        connectionString = builder.ConnectionString;

        using var conn = new SqlConnection(connectionString);
        await conn.OpenAsync();

        // Get list of online databases
        var databases = await conn.QueryAsync<string>(
            "SELECT name FROM sys.databases WHERE state = 0 ORDER BY name");

        return Results.Ok(new { Success = true, Databases = databases, DefaultDatabase = "master" });
    }
    catch (Exception ex)
    {
        return Results.Ok(new { Success = false, Message = $"Gagal terhubung ke server: {ex.Message}" });
    }
});

// B. GET SCHEMA FOR AUTOCOMPLETE (For a specific selected database)
app.MapPost("/api/query/schema", async ([FromBody] QuerySchemaRequest request) =>
{
    if (string.IsNullOrEmpty(request?.ServerName) || string.IsNullOrEmpty(request?.Database))
    {
        return Results.BadRequest("ServerName dan Database tidak boleh kosong");
    }

    try
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

        return Results.Ok(new { Objects = objects, Columns = columns });
    }
    catch (Exception ex)
    {
        return Results.BadRequest($"Gagal mengambil skema database: {ex.Message}");
    }
});

// C. EXECUTE QUERY
app.MapPost("/api/query/execute", async ([FromBody] QueryExecuteRequest request) =>
{
    if (string.IsNullOrEmpty(request?.ServerName) || string.IsNullOrEmpty(request?.Database) || string.IsNullOrEmpty(request?.QueryText))
    {
        return Results.BadRequest(new { Success = false, Message = "ServerName, Database, dan QueryText tidak boleh kosong" });
    }

    try
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

        var stopwatch = System.Diagnostics.Stopwatch.StartNew();
        using var command = new SqlCommand(request.QueryText, conn);
        using var reader = await command.ExecuteReaderAsync();

        var headers = new List<string>();
        var rows = new List<List<object>>();

        if (reader.FieldCount == 0)
        {
            // Command completed without returning a result set (e.g. UPDATE, INSERT, DELETE)
            headers.Add("Info");
            rows.Add(new List<object> { $"{reader.RecordsAffected} baris terpengaruh." });
        }
        else
        {
            for (int i = 0; i < reader.FieldCount; i++)
            {
                headers.Add(reader.GetName(i));
            }

            while (await reader.ReadAsync())
            {
                var row = new List<object>();
                for (int i = 0; i < reader.FieldCount; i++)
                {
                    var val = reader.GetValue(i);
                    row.Add(val == DBNull.Value ? null : val);
                }
                rows.Add(row);
            }
        }
        stopwatch.Stop();

        return Results.Ok(new { 
            Success = true, 
            Headers = headers, 
            Rows = rows, 
            ExecutionTimeMs = stopwatch.ElapsedMilliseconds 
        });
    }
    catch (Exception ex)
    {
        return Results.Ok(new { Success = false, Message = ex.Message });
    }
});

// D. GENERATE INSERT SCRIPT
app.MapPost("/api/query/generate-inserts", async ([FromBody] QueryGenerateInsertsRequest request) =>
{
    if (string.IsNullOrEmpty(request?.ServerName) || string.IsNullOrEmpty(request?.Database) || string.IsNullOrEmpty(request?.TableName))
    {
        return Results.BadRequest(new { Success = false, Message = "ServerName, Database, dan TableName tidak boleh kosong" });
    }

    try
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

        // Limit results to 1000 if where clause is empty to prevent memory overflow
        string topClause = string.IsNullOrWhiteSpace(request.WhereClause) ? "TOP 1000 " : "";
        string sql = $"SELECT {topClause}* FROM {escapedTable}{whereSql}";
        
        using var cmd = new SqlCommand(sql, conn);
        using var reader = await cmd.ExecuteReaderAsync();

        var inserts = new List<string>();
        bool hasIdentity = false;
        var readOnlyColumns = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

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

                // If column is read-only and NOT an identity column, it is a computed column or rowversion. Exclude it!
                if (isReadOnly && !isId)
                {
                    readOnlyColumns.Add(columnName);
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
                continue; // Skip computed/read-only columns
            }
            columns.Add(colName);
            columnOrdinals.Add(i);
        }

        if (columns.Count == 0)
        {
            return Results.Ok(new { Success = true, Script = "-- Tidak ada kolom yang dapat disisipkan --", RowCount = 0 });
        }

        string columnsPart = string.Join(", ", columns.Select(c => $"[{c}]"));

        while (await reader.ReadAsync())
        {
            var values = new List<string>();
            foreach (var ordinal in columnOrdinals)
            {
                values.Add(FormatValueForSql(reader.GetValue(ordinal)));
            }
            inserts.Add($"INSERT INTO {escapedTable} ({columnsPart}) VALUES ({string.Join(", ", values)});");
        }

        if (inserts.Count == 0)
        {
            return Results.Ok(new { Success = true, Script = "-- Tidak ada data yang cocok dengan kriteria WHERE --", RowCount = 0 });
        }

        var sb = new System.Text.StringBuilder();
        if (hasIdentity)
        {
            sb.AppendLine($"SET IDENTITY_INSERT {escapedTable} ON;");
            sb.AppendLine();
        }

        foreach (var ins in inserts)
        {
            sb.AppendLine(ins);
        }

        if (hasIdentity)
        {
            sb.AppendLine();
            sb.AppendLine($"SET IDENTITY_INSERT {escapedTable} OFF;");
        }

        return Results.Ok(new { Success = true, Script = sb.ToString(), RowCount = inserts.Count });
    }
    catch (Exception ex)
    {
        return Results.Ok(new { Success = false, Message = $"Gagal generate insert script: {ex.Message}" });
    }
});

// 11. RUN MIGRATION JOB (BACKGROUND PROCESS WITH REAL-TIME SIGNALR BROADCAST)
app.MapPost("/api/jobs/{id:int}/run", (int id, [FromQuery] int? mappingId, [FromQuery] bool checkConstraints, IConfiguration config, IHubContext<MigrationHub> hubContext, IHostApplicationLifetime appLifetime) =>
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
            }, token, mappingId, checkConstraints);
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

// ============================================================================
// APPIMS CONFIGURATOR DATABASE BACKUP & RESTORE ENDPOINTS [NEW]
// ============================================================================

app.MapGet("/api/appims/backup-settings", async (IConfiguration config, IWebHostEnvironment env) =>
{
    var filePath = Path.Combine(env.ContentRootPath, "app-config.json");
    string serverName = "Unknown Server";
    try
    {
        var builder = new SqlConnectionStringBuilder(config.GetConnectionString("ConfigDb"));
        serverName = builder.DataSource;
    }
    catch { }

    if (!File.Exists(filePath))
    {
        return Results.Ok(new { Success = true, AppimsBackupPath = "", Server = serverName });
    }
    try
    {
        var json = await File.ReadAllTextAsync(filePath);
        var settings = System.Text.Json.JsonSerializer.Deserialize<GeneralAppSettings>(json);
        return Results.Ok(new { Success = true, AppimsBackupPath = settings?.AppimsBackupPath ?? "", Server = serverName });
    }
    catch (Exception ex)
    {
        return Results.Ok(new { Success = false, Message = $"Gagal membaca pengaturan: {ex.Message}", AppimsBackupPath = "", Server = serverName });
    }
});

app.MapPost("/api/appims/backup-settings", async ([FromBody] GeneralAppSettings settings, IWebHostEnvironment env) =>
{
    if (settings == null) return Results.BadRequest("Request invalid");
    var filePath = Path.Combine(env.ContentRootPath, "app-config.json");
    try
    {
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
        return Results.Ok(new { Success = true, Message = "Pengaturan berhasil disimpan ke app-config.json!" });
    }
    catch (Exception ex)
    {
        return Results.Ok(new { Success = false, Message = $"Gagal menyimpan pengaturan: {ex.Message}" });
    }
});

app.MapPost("/api/appims/backup", async (IConfiguration config, IWebHostEnvironment env) =>
{
    var filePath = Path.Combine(env.ContentRootPath, "app-config.json");
    string backupPath = "";
    if (File.Exists(filePath))
    {
        try
        {
            var json = await File.ReadAllTextAsync(filePath);
            var settings = System.Text.Json.JsonSerializer.Deserialize<GeneralAppSettings>(json);
            backupPath = settings?.AppimsBackupPath ?? "";
        }
        catch { }
    }

    if (string.IsNullOrEmpty(backupPath))
    {
        return Results.BadRequest(new { Success = false, Message = "Path backup kosong. Harap atur path folder backup AppIMS terlebih dahulu!" });
    }

    var configConnStr = config.GetConnectionString("ConfigDb");
    var dbName = GetDatabaseName(configConnStr);

    try
    {
        var path = backupPath.Trim().TrimEnd('\\').TrimEnd('/');
        var dateStr = DateTime.Now.ToString("yyyyMMdd_HHmmss");
        var filename = $"{dbName}_{dateStr}.bak";
        var fullBackupFilePath = $"{path}\\{filename}";

        using var conn = new SqlConnection(configConnStr);
        await conn.OpenAsync();

        var backupSql = @"
            BACKUP DATABASE [" + dbName + @"]
            TO DISK = @BackupPath
            WITH COMPRESSION, INIT, STATS = 10;
        ";

        await conn.ExecuteAsync(backupSql, new { BackupPath = fullBackupFilePath }, commandTimeout: 300);

        return Results.Ok(new { Success = true, Message = $"Database AppIMS '{dbName}' berhasil di-backup ke file '{filename}'!", Filename = filename, Path = fullBackupFilePath });
    }
    catch (Exception ex)
    {
        return Results.Ok(new { Success = false, Message = $"Gagal mem-backup database AppIMS: {ex.Message}" });
    }
});

app.MapGet("/api/appims/backup-files", async (IConfiguration config, IWebHostEnvironment env) =>
{
    var filePath = Path.Combine(env.ContentRootPath, "app-config.json");
    string backupPath = "";
    if (File.Exists(filePath))
    {
        try
        {
            var json = await File.ReadAllTextAsync(filePath);
            var settings = System.Text.Json.JsonSerializer.Deserialize<GeneralAppSettings>(json);
            backupPath = settings?.AppimsBackupPath ?? "";
        }
        catch { }
    }

    if (string.IsNullOrEmpty(backupPath))
    {
        return Results.BadRequest(new { Success = false, Message = "Path backup kosong. Harap atur path folder backup AppIMS terlebih dahulu!" });
    }

    var configConnStr = config.GetConnectionString("ConfigDb");
    try
    {
        var path = backupPath.Trim().TrimEnd('\\').TrimEnd('/');

        using var conn = new SqlConnection(configConnStr);
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
            
            SELECT subdirectory AS Filename 
            FROM #Files 
            WHERE [file] = 1 AND subdirectory LIKE '%.bak'
            ORDER BY subdirectory DESC;
            
            DROP TABLE #Files;
        ";

        var files = (await conn.QueryAsync<string>(sql, new { BackupPath = path })).ToList();
        return Results.Ok(new { Success = true, Files = files });
    }
    catch (Exception ex)
    {
        return Results.Ok(new { Success = false, Message = $"Gagal mendeteksi file backup AppIMS di server database: {ex.Message}" });
    }
});

app.MapPost("/api/appims/restore", async ([FromBody] RestoreRequest request, IConfiguration config, IWebHostEnvironment env) =>
{
    if (request == null || string.IsNullOrEmpty(request.BackupFilename))
    {
        return Results.BadRequest(new { Success = false, Message = "Filename backup kosong!" });
    }

    var filePath = Path.Combine(env.ContentRootPath, "app-config.json");
    string backupPath = "";
    if (File.Exists(filePath))
    {
        try
        {
            var json = await File.ReadAllTextAsync(filePath);
            var settings = System.Text.Json.JsonSerializer.Deserialize<GeneralAppSettings>(json);
            backupPath = settings?.AppimsBackupPath ?? "";
        }
        catch { }
    }

    if (string.IsNullOrEmpty(backupPath))
    {
        return Results.BadRequest(new { Success = false, Message = "Path backup kosong. Harap atur path folder backup AppIMS terlebih dahulu!" });
    }

    var configConnStr = config.GetConnectionString("ConfigDb");
    var dbName = GetDatabaseName(configConnStr);

    try
    {
        var path = backupPath.Trim().TrimEnd('\\').TrimEnd('/');
        var fullBackupFilePath = $"{path}\\{request.BackupFilename}";

        var restoreDbName = string.IsNullOrEmpty(request.RestoreDbName) 
            ? dbName 
            : request.RestoreDbName.Trim();

        var isNewDb = !string.Equals(restoreDbName, dbName, StringComparison.OrdinalIgnoreCase);

        var masterConnStr = GetMasterConnectionString(configConnStr);
        using var masterConn = new SqlConnection(masterConnStr);
        await masterConn.OpenAsync();

        if (!isNewDb)
        {
            var setSingleUserSql = @"
                IF EXISTS (SELECT * FROM sys.databases WHERE name = @DbName)
                BEGIN
                    ALTER DATABASE [" + restoreDbName + @"] SET SINGLE_USER WITH ROLLBACK IMMEDIATE;
                END
            ";
            await masterConn.ExecuteAsync(setSingleUserSql, new { DbName = restoreDbName });

            try
            {
                var restoreSql = @"
                    RESTORE DATABASE [" + restoreDbName + @"]
                    FROM DISK = @BackupPath
                    WITH REPLACE;
                ";
                await masterConn.ExecuteAsync(restoreSql, new { BackupPath = fullBackupFilePath }, commandTimeout: 300);
            }
            finally
            {
                var setMultiUserSql = @"
                    IF EXISTS (SELECT * FROM sys.databases WHERE name = @DbName)
                    BEGIN
                        ALTER DATABASE [" + restoreDbName + @"] SET MULTI_USER;
                    END
                ";
                await masterConn.ExecuteAsync(setMultiUserSql, new { DbName = restoreDbName });
            }

            return Results.Ok(new { Success = true, Message = $"Database AppIMS '{restoreDbName}' berhasil di-restore dengan sukses!" });
        }
        else
        {
            var fileListSql = "RESTORE FILELISTONLY FROM DISK = @BackupPath;";
            var files = (await masterConn.QueryAsync(fileListSql, new { BackupPath = fullBackupFilePath })).ToList();

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

                moveClauses.Add("MOVE @LogicalName_" + fileIdx + " TO @PhysicalName_" + fileIdx);
                paramDict.Add("LogicalName_" + fileIdx, logicalName);
                paramDict.Add("PhysicalName_" + fileIdx, newPhysicalName);
                fileIdx++;
            }

            var moveSqlStr = string.Join(",\n                ", moveClauses);
            var restoreSql = @"
                RESTORE DATABASE [" + restoreDbName + @"]
                FROM DISK = @BackupPath
                WITH REPLACE,
                " + moveSqlStr + @";
            ";

            await masterConn.ExecuteAsync(restoreSql, paramDict, commandTimeout: 300);

            return Results.Ok(new { Success = true, Message = $"Database baru '{restoreDbName}' berhasil dibuat dan di-restore dari backup AppIMS!" });
        }
    }
    catch (Exception ex)
    {
        return Results.Ok(new { Success = false, Message = $"Gagal me-restore database AppIMS: {ex.Message}" });
    }
});


// ============================================================================
// DYNAMIC DB BACKUP & RESTORE ENDPOINTS [NEW]
// ============================================================================

// 1. BACKUP DB TARGET
app.MapPost("/api/jobs/{id:int}/backup", async (int id, IConfiguration config) =>
{
    using var configConn = new SqlConnection(config.GetConnectionString("ConfigDb"));
    var job = await configConn.QuerySingleOrDefaultAsync<MigrationJob>("SELECT * FROM dbo.MigrationJobs WHERE Id = @Id", new { Id = id });
    if (job == null) return Results.NotFound($"Job {id} tidak ditemukan");

    if (string.IsNullOrEmpty(job.BackupPath))
    {
        return Results.BadRequest(new { Success = false, Message = "Path backup kosong. Harap atur path backup terlebih dahulu di konfigurasi Job!" });
    }

    if (string.IsNullOrEmpty(job.TargetConnectionString))
    {
        return Results.BadRequest(new { Success = false, Message = "Target Connection String kosong!" });
    }

    try
    {
        var targetDb = GetDatabaseName(job.TargetConnectionString);
        if (string.IsNullOrEmpty(targetDb))
        {
            return Results.BadRequest(new { Success = false, Message = "Gagal mendeteksi nama database target dari connection string." });
        }

        var path = job.BackupPath.Trim().TrimEnd('\\').TrimEnd('/');
        var dateStr = DateTime.Now.ToString("yyyyMMdd_HHmmss");
        var filename = $"{targetDb}_{dateStr}.bak";
        var fullBackupFilePath = $"{path}\\{filename}";

        using var targetConn = new SqlConnection(job.TargetConnectionString);
        await targetConn.OpenAsync();

        var backupSql = @"
            BACKUP DATABASE [" + targetDb + @"]
            TO DISK = @BackupPath
            WITH COMPRESSION, INIT, STATS = 10;
        ";

        await targetConn.ExecuteAsync(backupSql, new { BackupPath = fullBackupFilePath }, commandTimeout: 300);

        return Results.Ok(new { Success = true, Message = $"Database '{targetDb}' berhasil di-backup ke file '{filename}'!", Filename = filename, Path = fullBackupFilePath });
    }
    catch (Exception ex)
    {
        return Results.Ok(new { Success = false, Message = $"Gagal mem-backup database: {ex.Message}" });
    }
});

// 2. GET BACKUP FILES
app.MapGet("/api/jobs/{id:int}/backup-files", async (int id, IConfiguration config) =>
{
    using var configConn = new SqlConnection(config.GetConnectionString("ConfigDb"));
    var job = await configConn.QuerySingleOrDefaultAsync<MigrationJob>("SELECT * FROM dbo.MigrationJobs WHERE Id = @Id", new { Id = id });
    if (job == null) return Results.NotFound($"Job {id} tidak ditemukan");

    if (string.IsNullOrEmpty(job.BackupPath))
    {
        return Results.BadRequest(new { Success = false, Message = "Path backup kosong. Harap atur path backup terlebih dahulu di konfigurasi Job!" });
    }

    if (string.IsNullOrEmpty(job.TargetConnectionString))
    {
        return Results.BadRequest(new { Success = false, Message = "Target Connection String kosong!" });
    }

    try
    {
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
            
            SELECT subdirectory AS Filename 
            FROM #Files 
            WHERE [file] = 1 AND subdirectory LIKE '%.bak'
            ORDER BY subdirectory DESC;
            
            DROP TABLE #Files;
        ";

        var files = (await targetConn.QueryAsync<string>(sql, new { BackupPath = path })).ToList();
        return Results.Ok(new { Success = true, Files = files });
    }
    catch (Exception ex)
    {
        return Results.Ok(new { Success = false, Message = $"Gagal mendeteksi file backup di server database: {ex.Message}" });
    }
});

// 3. RESTORE DB TARGET
app.MapPost("/api/jobs/{id:int}/restore", async (int id, [FromBody] RestoreRequest request, IConfiguration config) =>
{
    if (request == null || string.IsNullOrEmpty(request.BackupFilename))
    {
        return Results.BadRequest(new { Success = false, Message = "Filename backup kosong!" });
    }

    using var configConn = new SqlConnection(config.GetConnectionString("ConfigDb"));
    var job = await configConn.QuerySingleOrDefaultAsync<MigrationJob>("SELECT * FROM dbo.MigrationJobs WHERE Id = @Id", new { Id = id });
    if (job == null) return Results.NotFound($"Job {id} tidak ditemukan");

    if (string.IsNullOrEmpty(job.BackupPath))
    {
        return Results.BadRequest(new { Success = false, Message = "Path backup kosong di konfigurasi Job!" });
    }

    if (string.IsNullOrEmpty(job.TargetConnectionString))
    {
        return Results.BadRequest(new { Success = false, Message = "Target Connection String kosong!" });
    }

    try
    {
        var targetDb = GetDatabaseName(job.TargetConnectionString);
        var path = job.BackupPath.Trim().TrimEnd('\\').TrimEnd('/');
        var fullBackupFilePath = $"{path}\\{request.BackupFilename}";

        var restoreDbName = string.IsNullOrEmpty(request.RestoreDbName) 
            ? targetDb 
            : request.RestoreDbName.Trim();

        var isNewDb = !string.Equals(restoreDbName, targetDb, StringComparison.OrdinalIgnoreCase);

        var masterConnStr = GetMasterConnectionString(job.TargetConnectionString);
        using var masterConn = new SqlConnection(masterConnStr);
        await masterConn.OpenAsync();

        if (!isNewDb)
        {
            var setSingleUserSql = @"
                IF EXISTS (SELECT * FROM sys.databases WHERE name = @DbName)
                BEGIN
                    ALTER DATABASE [" + restoreDbName + @"] SET SINGLE_USER WITH ROLLBACK IMMEDIATE;
                END
            ";
            await masterConn.ExecuteAsync(setSingleUserSql, new { DbName = restoreDbName });

            try
            {
                var restoreSql = @"
                    RESTORE DATABASE [" + restoreDbName + @"]
                    FROM DISK = @BackupPath
                    WITH REPLACE;
                ";
                await masterConn.ExecuteAsync(restoreSql, new { BackupPath = fullBackupFilePath }, commandTimeout: 300);
            }
            finally
            {
                var setMultiUserSql = @"
                    IF EXISTS (SELECT * FROM sys.databases WHERE name = @DbName)
                    BEGIN
                        ALTER DATABASE [" + restoreDbName + @"] SET MULTI_USER;
                    END
                ";
                await masterConn.ExecuteAsync(setMultiUserSql, new { DbName = restoreDbName });
            }

            return Results.Ok(new { Success = true, Message = $"Database '{restoreDbName}' berhasil di-restore dengan sukses!" });
        }
        else
        {
            var fileListSql = "RESTORE FILELISTONLY FROM DISK = @BackupPath;";
            var files = (await masterConn.QueryAsync(fileListSql, new { BackupPath = fullBackupFilePath })).ToList();

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

                moveClauses.Add("MOVE @LogicalName_" + fileIdx + " TO @PhysicalName_" + fileIdx);
                paramDict.Add("LogicalName_" + fileIdx, logicalName);
                paramDict.Add("PhysicalName_" + fileIdx, newPhysicalName);
                fileIdx++;
            }

            var moveSqlStr = string.Join(",\n                ", moveClauses);
            var restoreSql = @"
                RESTORE DATABASE [" + restoreDbName + @"]
                FROM DISK = @BackupPath
                WITH REPLACE,
                " + moveSqlStr + @";
            ";

            await masterConn.ExecuteAsync(restoreSql, paramDict, commandTimeout: 300);

            return Results.Ok(new { Success = true, Message = $"Database baru '{restoreDbName}' berhasil dibuat dan di-restore dari backup!" });
        }
    }
    catch (Exception ex)
    {
        return Results.Ok(new { Success = false, Message = $"Gagal me-restore database: {ex.Message}" });
    }
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
                ExecutionOrder = @ExecutionOrder, IsEnabled = @IsEnabled, AllowDropColumns = @AllowDropColumns
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
            INSERT INTO dbo.ObjectMigrationItems (JobId, ObjectName, ObjectType, NativeSqlScript, ExecutionOrder, IsEnabled, AllowDropColumns)
            VALUES (@JobId, @ObjectName, @ObjectType, @NativeSqlScript, @ExecutionOrder, @IsEnabled, @AllowDropColumns);
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
        item.AllowDropColumns = false;
        await conn.ExecuteAsync(@"
            IF NOT EXISTS (SELECT 1 FROM dbo.ObjectMigrationItems WHERE JobId = @JobId AND ObjectName = @ObjectName AND ObjectType = @ObjectType)
            INSERT INTO dbo.ObjectMigrationItems (JobId, ObjectName, ObjectType, NativeSqlScript, ExecutionOrder, IsEnabled, AllowDropColumns)
            VALUES (@JobId, @ObjectName, @ObjectType, @NativeSqlScript, @ExecutionOrder, @IsEnabled, @AllowDropColumns);", item);
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
    var backup = await conn.QuerySingleOrDefaultAsync<dynamic>(
        @"SELECT b.BackupScript, b.Version, b.BackedUpAt, i.ObjectName 
          FROM dbo.ObjectMigrationBackups b
          JOIN dbo.ObjectMigrationItems i ON b.ItemId = i.Id
          WHERE b.Id = @Id", new { Id = id });
          
    if (backup == null) return Results.NotFound();

    string backupScript = backup.BackupScript;
    int version = backup.Version;
    DateTime backedUpAt = backup.BackedUpAt;
    string objectName = backup.ObjectName ?? "backup";

    // Sanitize filename to avoid invalid characters or confusing extension dots
    string safeObjectName = objectName;
    foreach (char c in System.IO.Path.GetInvalidFileNameChars())
    {
        safeObjectName = safeObjectName.Replace(c, '_');
    }
    safeObjectName = safeObjectName.Replace('.', '_');

    var bytes = System.Text.Encoding.UTF8.GetBytes(backupScript);
    return Results.File(bytes, "application/sql", $"{safeObjectName}_v{version}_{backedUpAt:yyyyMMdd_HHmmss}.sql");
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
        SET LastStatus = 'Pending', LastErrorMessage = NULL, LastRunAt = NULL, LastRowsMigrated = 0
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
        if (item.AllowDropColumns)
        {
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

async Task SyncIndexes(SqlConnection srcConn, SqlConnection targetConn, string schema, string table)
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
            catch { /* Index creation may fail if columns don't exist yet - skip */ }
        }
    }
}



// ============================================================================
// HELPER FUNCTIONS FOR SCHEMA COMPARISON
// ============================================================================
async Task<Dictionary<string, ComparableDbObject>> LoadComparableObjects(SqlConnection conn)
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
            Ddl = GenerateComparableTableDdl(schema, name, columns, pkColumns)
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

List<string> CompareTableColumns(List<SchemaColumnDto> sourceColumns, List<SchemaColumnDto> targetColumns)
{
    var differences = new List<string>();
    var targetByName = targetColumns.ToDictionary(c => c.Name, StringComparer.OrdinalIgnoreCase);
    var sourceNames = new HashSet<string>(sourceColumns.Select(c => c.Name), StringComparer.OrdinalIgnoreCase);

    foreach (var sourceColumn in sourceColumns)
    {
        if (!targetByName.TryGetValue(sourceColumn.Name, out var targetColumn))
        {
            differences.Add($"Kolom {sourceColumn.Name} {FormatComparableColumnType(sourceColumn)} tidak ditemukan di Target DB.");
            continue;
        }

        var sourceDef = FormatComparableColumnDefinition(sourceColumn, includeName: false);
        var targetDef = FormatComparableColumnDefinition(targetColumn, includeName: false);
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

ColumnSyncPlanDto? BuildColumnSyncPlan(ComparableDbObject sourceObj, ComparableDbObject targetObj)
{
    var targetNames = new HashSet<string>(targetObj.Columns.Select(c => c.Name), StringComparer.OrdinalIgnoreCase);
    var missingColumns = sourceObj.Columns.Where(c => !targetNames.Contains(c.Name)).ToList();
    if (missingColumns.Count == 0) return null;

    var afterColumns = targetObj.Columns
        .Select(c => new ColumnPreviewDto { Name = c.Name, Type = FormatComparableColumnDefinition(c, includeName: false), IsNew = false })
        .ToList();

    foreach (var missingColumn in missingColumns)
    {
        afterColumns.Add(new ColumnPreviewDto
        {
            Name = missingColumn.Name,
            Type = FormatComparableColumnDefinition(missingColumn, includeName: false),
            IsNew = true
        });
    }

    var tableName = QuoteMultipartSqlIdentifier(sourceObj.Name);
    var sql = string.Join(Environment.NewLine, missingColumns.Select(c =>
        $"ALTER TABLE {tableName} ADD {FormatComparableColumnDefinition(c, includeName: true)};"));

    return new ColumnSyncPlanDto
    {
        Before = targetObj.Columns.Select(c => new ColumnPreviewDto { Name = c.Name, Type = FormatComparableColumnDefinition(c, includeName: false) }).ToList(),
        After = afterColumns,
        Sql = sql
    };
}

string GenerateComparableTableDdl(string schema, string table, List<SchemaColumnDto> columns, List<string> pkColumns)
{
    var lines = columns.Select(c => "    " + FormatComparableColumnDefinition(c, includeName: true)).ToList();
    if (pkColumns.Count > 0)
    {
        lines.Add($"    CONSTRAINT [PK_{table}] PRIMARY KEY ({string.Join(", ", pkColumns.Select(c => $"[{c.Replace("]", "]]")}]"))})");
    }

    return $"CREATE TABLE [{schema.Replace("]", "]]")}].[{table.Replace("]", "]]")}] (\n{string.Join(",\n", lines)}\n);";
}

string FormatComparableColumnDefinition(SchemaColumnDto column, bool includeName)
{
    var parts = new List<string>();
    if (includeName)
    {
        parts.Add($"[{column.Name.Replace("]", "]]")}]");
    }

    parts.Add(FormatComparableColumnType(column));
    if (column.IsIdentity) parts.Add("IDENTITY(1,1)");
    parts.Add(column.IsNullable ? "NULL" : "NOT NULL");
    if (!string.IsNullOrWhiteSpace(column.DefaultDefinition)) parts.Add($"DEFAULT {column.DefaultDefinition}");
    return string.Join(" ", parts);
}

string FormatComparableColumnType(SchemaColumnDto column)
{
    var dataType = column.DataType?.ToLowerInvariant() ?? "";
    if (dataType is "varchar" or "char" or "varbinary" or "binary")
    {
        return column.MaxLength == -1 ? $"{dataType}(MAX)" : $"{dataType}({column.MaxLength})";
    }
    if (dataType is "nvarchar" or "nchar")
    {
        return column.MaxLength == -1 ? $"{dataType}(MAX)" : $"{dataType}({column.MaxLength / 2})";
    }
    if (dataType is "decimal" or "numeric")
    {
        return $"{dataType}({column.Precision},{column.Scale})";
    }
    if (dataType is "datetime2" or "datetimeoffset" or "time")
    {
        return $"{dataType}({column.Scale})";
    }

    return dataType;
}

string NormalizeDdl(string ddl)
{
    if (string.IsNullOrWhiteSpace(ddl)) return string.Empty;
    return System.Text.RegularExpressions.Regex.Replace(ddl.Trim(), @"\s+", " ").ToLowerInvariant();
}

string EscapeHtml(string value)
{
    return System.Net.WebUtility.HtmlEncode(value);
}

string QuoteMultipartSqlIdentifier(string name)
{
    return string.Join(".", name.Split('.', StringSplitOptions.RemoveEmptyEntries)
        .Select(part => $"[{part.Replace("[", "").Replace("]", "]]")}]"));
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

public class SchemaComparisonSummaryDto
{
    public int SourceCount { get; set; }
    public int TargetCount { get; set; }
    public int MissingCount { get; set; }
    public int MismatchCount { get; set; }
    public int OutdatedCount { get; set; }
}

public class SchemaComparisonItemDto
{
    public string Name { get; set; }
    public string Type { get; set; }
    public string Status { get; set; }
    public string Info { get; set; }
    public string SourceDdl { get; set; }
    public string TargetDdl { get; set; }
    public ColumnSyncPlanDto? ColumnSync { get; set; }
}

public class ColumnSyncPlanDto
{
    public List<ColumnPreviewDto> Before { get; set; } = new();
    public List<ColumnPreviewDto> After { get; set; } = new();
    public string Sql { get; set; }
}

public class ColumnPreviewDto
{
    public string Name { get; set; }
    public string Type { get; set; }
    public bool IsNew { get; set; }
}

public class SchemaColumnDto
{
    public string Name { get; set; }
    public string DataType { get; set; }
    public short MaxLength { get; set; }
    public byte Precision { get; set; }
    public byte Scale { get; set; }
    public bool IsNullable { get; set; }
    public bool IsIdentity { get; set; }
    public string DefaultDefinition { get; set; }
    public int Ordinal { get; set; }
}

public class ComparableDbObject
{
    public string Name { get; set; }
    public string Type { get; set; }
    public string DisplayType { get; set; }
    public string Ddl { get; set; }
    public List<SchemaColumnDto> Columns { get; set; } = new();
    public string Key => $"{DisplayType}:{Name}";
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
    public string WhereClause { get; set; }
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

public class RestoreRequest
{
    public string BackupFilename { get; set; }
    public string RestoreDbName { get; set; }
}

public class GeneralAppSettings
{
    public string AppimsBackupPath { get; set; } = string.Empty;
}

public class SavedConnection
{
    public int Id { get; set; }
    public string ConnectionName { get; set; }
    public string ServerName { get; set; }
    public string Authentication { get; set; }
    public string Login { get; set; }
    public string Password { get; set; }
    public DateTime CreatedAt { get; set; }
}

public class QueryConnectRequest
{
    public string ServerName { get; set; }
    public string Authentication { get; set; } // "SQL" or "Windows"
    public string Login { get; set; }
    public string Password { get; set; }
}

public class QuerySchemaRequest
{
    public string ServerName { get; set; }
    public string Authentication { get; set; }
    public string Login { get; set; }
    public string Password { get; set; }
    public string Database { get; set; }
}

public class QueryGenerateInsertsRequest
{
    public string ServerName { get; set; }
    public string Authentication { get; set; }
    public string Login { get; set; }
    public string Password { get; set; }
    public string Database { get; set; }
    public string TableName { get; set; }
    public string WhereClause { get; set; }
}

public class QueryExecuteRequest
{
    public string ServerName { get; set; }
    public string Authentication { get; set; }
    public string Login { get; set; }
    public string Password { get; set; }
    public string Database { get; set; }
    public string QueryText { get; set; }
}

public partial class Program
{
    private static string GetMasterConnectionString(string connStr)
    {
        var builder = new SqlConnectionStringBuilder(connStr);
        builder.InitialCatalog = "master";
        return builder.ConnectionString;
    }

    private static string FormatValueForSql(object val)
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
