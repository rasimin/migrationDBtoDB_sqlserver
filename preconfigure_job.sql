-- ============================================================================
-- SCRIPT PRE-KONFIGURASI JOB DAN MAPPING SIMULASI KE DATABASE appims
-- SERVER: RASIMIN\MSSQLSERVER2022
-- ============================================================================

USE appims;
GO

-- Bersihkan data contoh awal agar rapi
DELETE FROM dbo.ColumnMappings;
DELETE FROM dbo.TableMappings;
DELETE FROM dbo.MigrationJobs;
GO

-- 1. Sisipkan Job Migrasi Utama
DECLARE @JobId INT;

INSERT INTO dbo.MigrationJobs (JobName, SourceConnectionString, TargetConnectionString)
VALUES (
    'Migrasi Pelanggan & Transaksi (Struktur Berbeda)',
    'Server=RASIMIN\MSSQLSERVER2022;Database=SourceDB;Integrated Security=True;TrustServerCertificate=True;',
    'Server=RASIMIN\MSSQLSERVER2022;Database=TargetDB;Integrated Security=True;TrustServerCertificate=True;'
);

SELECT @JobId = SCOPE_IDENTITY();

-- 2. Sisipkan Table Mappings
DECLARE @TableMapCustomerId INT;
DECLARE @TableMapTransactionId INT;

-- A. Mapping Pelanggan (ExecutionOrder = 1, karena tabel induk)
INSERT INTO dbo.TableMappings (JobId, SourceTableName, TargetTableName, ExecutionOrder, TruncateTarget, IsEnabled)
VALUES (@JobId, 'tbl_pelanggan', 'TargetCustomers', 1, 1, 1);

SELECT @TableMapCustomerId = SCOPE_IDENTITY();

-- B. Mapping Transaksi (ExecutionOrder = 2, karena tabel anak merujuk ke pelanggan)
INSERT INTO dbo.TableMappings (JobId, SourceTableName, TargetTableName, ExecutionOrder, TruncateTarget, IsEnabled)
VALUES (@JobId, 'tbl_transaksi', 'TargetTransactions', 2, 1, 1);

SELECT @TableMapTransactionId = SCOPE_IDENTITY();

-- 3. Sisipkan Column Mappings untuk Pelanggan (tbl_pelanggan -> TargetCustomers)
-- Catatan: idcustomer tidak dipetakan karena auto-increment di database target dan tidak ada di source.
INSERT INTO dbo.ColumnMappings (TableMappingId, SourceColumnName, TargetColumnName, MappingType, ConstantValue, LookupTable, LookupKeyColumn, LookupValueColumn, ExpressionSQL)
VALUES
-- nik -> nik (Direct)
(@TableMapCustomerId, 'nik', 'nik', 'Direct', NULL, NULL, NULL, NULL, NULL),
-- nama_lengkap -> FullName (Direct)
(@TableMapCustomerId, 'nama_lengkap', 'FullName', 'Direct', NULL, NULL, NULL, NULL, NULL),
-- telepon -> Phone (Direct)
(@TableMapCustomerId, 'telepon', 'Phone', 'Direct', NULL, NULL, NULL, NULL, NULL),
-- tgl_daftar -> RegistrationDate (Direct)
(@TableMapCustomerId, 'tgl_daftar', 'RegistrationDate', 'Direct', NULL, NULL, NULL, NULL, NULL),
-- PunyaSaldo (Expression: Cek apakah nik ada di tbl_history database source)
(@TableMapCustomerId, NULL, 'PunyaSaldo', 'Expression', NULL, NULL, NULL, NULL, 
 'CASE WHEN EXISTS (SELECT 1 FROM SourceDB.dbo.tbl_history H WHERE H.nik = Source.nik) THEN 1 ELSE 0 END');

-- 4. Sisipkan Column Mappings untuk Transaksi (tbl_transaksi -> TargetTransactions)
INSERT INTO dbo.ColumnMappings (TableMappingId, SourceColumnName, TargetColumnName, MappingType, ConstantValue, LookupTable, LookupKeyColumn, LookupValueColumn, ExpressionSQL)
VALUES
-- id_trx -> Id (Direct)
(@TableMapTransactionId, 'id_trx', 'Id', 'Direct', NULL, NULL, NULL, NULL, NULL),
-- nominal -> Amount (Direct)
(@TableMapTransactionId, 'nominal', 'Amount', 'Direct', NULL, NULL, NULL, NULL, NULL),
-- tgl_trx -> TransactionDate (Direct)
(@TableMapTransactionId, 'tgl_trx', 'TransactionDate', 'Direct', NULL, NULL, NULL, NULL, NULL),
-- idcustomer (Lookup: cari idcustomer di TargetCustomers berdasarkan nik_pelanggan dari source)
(@TableMapTransactionId, 'nik_pelanggan', 'idcustomer', 'Lookup', NULL, 'TargetCustomers', 'nik', 'idcustomer', NULL);
GO
