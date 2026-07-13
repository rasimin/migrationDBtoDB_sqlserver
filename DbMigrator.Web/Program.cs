using System;
using System.Collections.Generic;
using System.Data;
using Microsoft.Data.SqlClient;
using System.Linq;
using System.Threading.Tasks;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.SignalR;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Dapper;
using DbMigrator.Core;
using DbMigrator.Web;
using DbMigrator.Web.Services;
using DbMigrator.Web.Models;

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

        var targetConnStr = builder.Configuration.GetConnectionString("TargetDb");
        
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

        Console.WriteLine("\nTabel: TargetCustomers");
        Console.WriteLine("-------------------------------------------------------------------------------------");
        Console.WriteLine(string.Format("{0,-12} | {1,-15} | {2,-20} | {3,-10} | {4,-15}", "idcustomer", "NIK", "FullName", "PunyaSaldo", "RegDate"));
        Console.WriteLine("-------------------------------------------------------------------------------------");
        var customers = await targetConn.QueryAsync("SELECT idcustomer, NIK, FullName, PunyaSaldo, CONVERT(VARCHAR, RegistrationDate, 120) AS RegDate FROM TargetCustomers");
        foreach (var c in customers)
        {
            Console.WriteLine(string.Format("{0,-12} | {1,-15} | {2,-20} | {3,-10} | {4,-15}", c.idcustomer, c.NIK, c.FullName, c.PunyaSaldo, c.RegDate));
        }

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

// Konfigurasi MVC Controllers
builder.Services.AddControllers().AddJsonOptions(options =>
{
    options.JsonSerializerOptions.PropertyNamingPolicy = null;
});

builder.Services.AddDistributedMemoryCache();
builder.Services.AddSession(options =>
{
    options.Cookie.Name = ".DbMigrator.Session";
    options.Cookie.HttpOnly = true;
    options.Cookie.IsEssential = true;
    options.Cookie.SameSite = SameSiteMode.Strict;
    options.IdleTimeout = TimeSpan.FromHours(12);
});

// Register custom Service classes
builder.Services.AddScoped<QueryService>();
builder.Services.AddScoped<SsrsService>();
builder.Services.AddScoped<WhiteboardService>();
builder.Services.AddScoped<MigrationService>();
builder.Services.AddScoped<ReportRaiderService>();
builder.Services.AddSingleton<AuthConfigService>();

var app = builder.Build();

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

        IF OBJECT_ID('dbo.ObjectMigrationBackups', 'U') IS NOT NULL
            AND OBJECT_ID('dbo.ObjectMigrationItems', 'U') IS NOT NULL
        BEGIN
            IF EXISTS (
                SELECT 1 FROM sys.foreign_keys fk
                JOIN sys.tables t ON fk.referenced_object_id = t.object_id
                WHERE fk.parent_object_id = OBJECT_ID('dbo.ObjectMigrationItems')
                  AND t.name = 'ObjectMigrationJobs'
            )
            BEGIN
                DROP TABLE dbo.ObjectMigrationBackups;
                IF OBJECT_ID('dbo.ObjectMigrationLogs', 'U') IS NOT NULL
                    DROP TABLE dbo.ObjectMigrationLogs;
                DROP TABLE dbo.ObjectMigrationItems;
                IF OBJECT_ID('dbo.ObjectMigrationJobs', 'U') IS NOT NULL
                    DROP TABLE dbo.ObjectMigrationJobs;
            END
        END
        ELSE IF OBJECT_ID('dbo.ObjectMigrationJobs', 'U') IS NOT NULL
            AND OBJECT_ID('dbo.ObjectMigrationItems', 'U') IS NULL
        BEGIN
            DROP TABLE dbo.ObjectMigrationJobs;
        END

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

        IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID('dbo.TableMappings') AND name = 'LastStatus')
        BEGIN
            ALTER TABLE dbo.TableMappings ADD LastStatus NVARCHAR(50) NOT NULL DEFAULT 'Pending';
            ALTER TABLE dbo.TableMappings ADD LastErrorMessage NVARCHAR(MAX) NULL;
            ALTER TABLE dbo.TableMappings ADD LastRunAt DATETIME NULL;
        END

        IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID('dbo.TableMappings') AND name = 'LastRowsMigrated')
        BEGIN
            ALTER TABLE dbo.TableMappings ADD LastRowsMigrated INT NOT NULL DEFAULT 0;
        END

        IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID('dbo.ObjectMigrationItems') AND name = 'LastStatus')
        BEGIN
            ALTER TABLE dbo.ObjectMigrationItems ADD LastStatus NVARCHAR(50) NOT NULL DEFAULT 'Pending';
            ALTER TABLE dbo.ObjectMigrationItems ADD LastErrorMessage NVARCHAR(MAX) NULL;
            ALTER TABLE dbo.ObjectMigrationItems ADD LastRunAt DATETIME NULL;
        END

        IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID('dbo.ObjectMigrationItems') AND name = 'AllowDropColumns')
        BEGIN
            ALTER TABLE dbo.ObjectMigrationItems ADD AllowDropColumns BIT NOT NULL DEFAULT 0;
        END

        IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID('dbo.ColumnMappings') AND name = 'IfNullAction')
        BEGIN
            ALTER TABLE dbo.ColumnMappings ADD IfNullAction NVARCHAR(50) NULL;
            ALTER TABLE dbo.ColumnMappings ADD IfNullParam NVARCHAR(500) NULL;
        END

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

        IF NOT EXISTS (SELECT * FROM sys.objects WHERE object_id = OBJECT_ID('dbo.SavedSsrsConnections') AND type in ('U'))
        BEGIN
            CREATE TABLE dbo.SavedSsrsConnections (
                Id INT IDENTITY(1,1) PRIMARY KEY,
                ConnectionName NVARCHAR(255) NOT NULL,
                Url NVARCHAR(500) NOT NULL,
                Username NVARCHAR(255) NOT NULL,
                Password NVARCHAR(255) NULL,
                Domain NVARCHAR(255) NULL,
                CreatedAt DATETIME NOT NULL DEFAULT GETDATE()
            );
        END

        IF EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID('dbo.JobWhiteboards') AND name = 'JobId')
        BEGIN
            DROP TABLE dbo.JobWhiteboards;
        END

        IF NOT EXISTS (SELECT * FROM sys.objects WHERE object_id = OBJECT_ID('dbo.JobWhiteboards') AND type in ('U'))
        BEGIN
            CREATE TABLE dbo.JobWhiteboards (
                Id INT IDENTITY(1,1) PRIMARY KEY,
                AliasName NVARCHAR(255) NOT NULL UNIQUE,
                TagName NVARCHAR(100) NULL,
                WhiteboardData NVARCHAR(MAX) NULL,
                ThumbnailData NVARCHAR(MAX) NULL,
                CreatedAt DATETIME NOT NULL DEFAULT GETDATE(),
                UpdatedAt DATETIME NOT NULL DEFAULT GETDATE()
            );
        END

        IF NOT EXISTS (SELECT * FROM sys.objects WHERE object_id = OBJECT_ID('dbo.SavedQueries') AND type in ('U'))
        BEGIN
            CREATE TABLE dbo.SavedQueries (
                Id INT IDENTITY(1,1) PRIMARY KEY,
                QueryName NVARCHAR(255) NOT NULL,
                QueryText NVARCHAR(MAX) NOT NULL,
                CreatedAt DATETIME NOT NULL DEFAULT GETDATE(),
                UpdatedAt DATETIME NOT NULL DEFAULT GETDATE()
            );
        END

        IF NOT EXISTS (SELECT * FROM sys.objects WHERE object_id = OBJECT_ID('dbo.SavedQueryHistory') AND type in ('U'))
        BEGIN
            CREATE TABLE dbo.SavedQueryHistory (
                Id INT IDENTITY(1,1) PRIMARY KEY,
                QueryId INT NOT NULL FOREIGN KEY REFERENCES dbo.SavedQueries(Id) ON DELETE CASCADE,
                QueryName NVARCHAR(255) NOT NULL,
                QueryText NVARCHAR(MAX) NOT NULL,
                SavedAt DATETIME NOT NULL DEFAULT GETDATE()
            );
        END

        IF NOT EXISTS (SELECT * FROM sys.objects WHERE object_id = OBJECT_ID('dbo.QueryExecutionLogs') AND type in ('U'))
        BEGIN
            CREATE TABLE dbo.QueryExecutionLogs (
                Id INT IDENTITY(1,1) PRIMARY KEY,
                ServerName NVARCHAR(255) NOT NULL,
                DatabaseName NVARCHAR(255) NOT NULL,
                QueryText NVARCHAR(MAX) NOT NULL,
                Status NVARCHAR(50) NOT NULL,
                ExecutionTimeMs BIGINT NULL,
                ErrorMessage NVARCHAR(MAX) NULL,
                ResponseMessages NVARCHAR(MAX) NULL,
                ExecutedAt DATETIME NOT NULL DEFAULT GETDATE()
            );
        END
    ");
}

app.UseCors("AllowAll");
app.UseSession();

app.Use(async (context, next) =>
{
    var authConfig = context.RequestServices.GetRequiredService<AuthConfigService>().Get();
    var path = context.Request.Path;
    var isPublicPath = path.Equals("/login.html", StringComparison.OrdinalIgnoreCase)
        || path.StartsWithSegments("/api/auth/login")
        || path.StartsWithSegments("/api/auth/status");
    var sessionUser = context.Session.GetString(DbMigrator.Web.Controllers.AuthController.SessionUserKey);
    var isAuthenticated = !authConfig.LoginEnabled || sessionUser == authConfig.Username;

    if (!isPublicPath && !isAuthenticated)
    {
        if (path.StartsWithSegments("/api") || path.StartsWithSegments("/migrationHub"))
        {
            context.Response.StatusCode = StatusCodes.Status401Unauthorized;
            context.Response.ContentType = "application/json";
            await context.Response.WriteAsJsonAsync(new { Success = false, Message = "Sesi login tidak valid atau sudah berakhir." });
            return;
        }

        var returnUrl = Uri.EscapeDataString($"{path}{context.Request.QueryString}");
        context.Response.Redirect($"/login.html?returnUrl={returnUrl}");
        return;
    }

    await next();
});

app.UseDefaultFiles();
app.UseStaticFiles();

// Map SignalR Hub
app.MapHub<MigrationHub>("/migrationHub");

// Map API Controllers
app.MapControllers();

app.Run();
