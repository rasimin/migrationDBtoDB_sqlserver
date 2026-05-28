-- ============================================================================
-- SCRIPT PEMBUATAN DATABASE DAN SKEMA CONFIGURATOR MIGRASI - appims
-- SERVER: RASIMIN\MSSQLSERVER2022
-- ============================================================================

-- 1. Buat Database appims jika belum ada
IF NOT EXISTS (SELECT * FROM sys.databases WHERE name = 'appims')
BEGIN
    CREATE DATABASE appims;
END
GO

USE appims;
GO

-- 2. Hapus tabel jika sudah ada (urutannya disesuaikan untuk menghindari masalah FK)
IF OBJECT_ID('dbo.MigrationLogs', 'U') IS NOT NULL DROP TABLE dbo.MigrationLogs;
IF OBJECT_ID('dbo.ColumnMappings', 'U') IS NOT NULL DROP TABLE dbo.ColumnMappings;
IF OBJECT_ID('dbo.TableMappings', 'U') IS NOT NULL DROP TABLE dbo.TableMappings;
IF OBJECT_ID('dbo.MigrationJobs', 'U') IS NOT NULL DROP TABLE dbo.MigrationJobs;
GO

-- 3. Membuat Tabel MigrationJobs (Mengelola koneksi Source & Target)
CREATE TABLE dbo.MigrationJobs (
    Id INT IDENTITY(1,1) PRIMARY KEY,
    JobName NVARCHAR(100) NOT NULL,
    SourceConnectionString NVARCHAR(1000) NOT NULL,
    TargetConnectionString NVARCHAR(1000) NOT NULL,
    CreatedAt DATETIME DEFAULT GETDATE(),
    LastRunAt DATETIME NULL
);

-- 4. Membuat Tabel TableMappings (Mengelola pemetaan antar tabel & urutan eksekusi)
CREATE TABLE dbo.TableMappings (
    Id INT IDENTITY(1,1) PRIMARY KEY,
    JobId INT NOT NULL FOREIGN KEY REFERENCES dbo.MigrationJobs(Id) ON DELETE CASCADE,
    SourceTableName NVARCHAR(128) NOT NULL,
    TargetTableName NVARCHAR(128) NOT NULL,
    ExecutionOrder INT NOT NULL DEFAULT 1,
    TruncateTarget BIT NOT NULL DEFAULT 0,
    IsEnabled BIT NOT NULL DEFAULT 1
);

-- 5. Membuat Tabel ColumnMappings (Mengelola pemetaan dinamis antar kolom)
CREATE TABLE dbo.ColumnMappings (
    Id INT IDENTITY(1,1) PRIMARY KEY,
    TableMappingId INT NOT NULL FOREIGN KEY REFERENCES dbo.TableMappings(Id) ON DELETE CASCADE,
    SourceColumnName NVARCHAR(128) NULL, -- Bisa null jika tipe Constant
    TargetColumnName NVARCHAR(128) NOT NULL,
    MappingType NVARCHAR(50) NOT NULL, -- Direct, Constant, Lookup, Expression, Ignore
    ConstantValue NVARCHAR(MAX) NULL,   -- Nilai jika MappingType = Constant
    LookupTable NVARCHAR(128) NULL,     -- Tabel referensi jika MappingType = Lookup (misal: TargetCustomers)
    LookupKeyColumn NVARCHAR(128) NULL, -- Kolom kunci asal pencarian di tabel referensi (misal: nik)
    LookupValueColumn NVARCHAR(128) NULL, -- Kolom ID tujuan di tabel referensi (misal: idcustomer)
    ExpressionSQL NVARCHAR(MAX) NULL,   -- Formula SQL jika MappingType = Expression
    CONSTRAINT CHK_MappingType CHECK (MappingType IN ('Direct', 'Constant', 'Lookup', 'Expression', 'Ignore'))
);

-- 6. Membuat Tabel MigrationLogs (Mencatat riwayat eksekusi migrasi data)
CREATE TABLE dbo.MigrationLogs (
    Id INT IDENTITY(1,1) PRIMARY KEY,
    JobId INT NOT NULL FOREIGN KEY REFERENCES dbo.MigrationJobs(Id) ON DELETE CASCADE,
    TableName NVARCHAR(128) NOT NULL,
    StartTime DATETIME NOT NULL DEFAULT GETDATE(),
    EndTime DATETIME NULL,
    TotalRows INT NOT NULL DEFAULT 0,
    RowsMigrated INT NOT NULL DEFAULT 0,
    Status NVARCHAR(50) NOT NULL DEFAULT 'InProgress', -- InProgress, Completed, Failed
    ErrorMessage NVARCHAR(MAX) NULL,
    CONSTRAINT CHK_LogStatus CHECK (Status IN ('InProgress', 'Completed', 'Failed'))
);
GO

-- ============================================================================
-- INPUT DUMMY DATA SEBAGAI CONTOH AWAL
-- ============================================================================

-- Masukkan 1 Job Contoh Awal
INSERT INTO dbo.MigrationJobs (JobName, SourceConnectionString, TargetConnectionString)
VALUES (
    'Migrasi Modul Customer & Transaksi',
    'Server=RASIMIN\MSSQLSERVER2022;Database=SourceDB;Integrated Security=True;TrustServerCertificate=True;',
    'Server=RASIMIN\MSSQLSERVER2022;Database=TargetDB;Integrated Security=True;TrustServerCertificate=True;'
);
GO
