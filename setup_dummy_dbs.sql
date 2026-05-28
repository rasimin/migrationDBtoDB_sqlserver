-- ============================================================================
-- SCRIPT SETUP DATABASE DUMMY (SOURCE & TARGET) UNTUK SIMULASI MIGRASI
-- SERVER: RASIMIN\MSSQLSERVER2022
-- ============================================================================

-- 1. SETUP DATABASE SOURCE (DB LAMA A)
IF EXISTS (SELECT * FROM sys.databases WHERE name = 'SourceDB')
BEGIN
    ALTER DATABASE SourceDB SET SINGLE_USER WITH ROLLBACK IMMEDIATE;
    DROP DATABASE SourceDB;
END
GO

CREATE DATABASE SourceDB;
GO

USE SourceDB;
GO

-- Tabel Pelanggan Asal (Menggunakan NIK sebagai Primary Key)
CREATE TABLE dbo.tbl_pelanggan (
    nik NVARCHAR(20) PRIMARY KEY,
    nama_lengkap NVARCHAR(100) NOT NULL,
    telepon NVARCHAR(20) NULL,
    tgl_daftar DATETIME NOT NULL DEFAULT GETDATE()
);

-- Tabel Transaksi Asal (Merujuk ke NIK)
CREATE TABLE dbo.tbl_transaksi (
    id_trx INT IDENTITY(1,1) PRIMARY KEY,
    nik_pelanggan NVARCHAR(20) NOT NULL,
    nominal DECIMAL(18,2) NOT NULL,
    tgl_trx DATETIME NOT NULL DEFAULT GETDATE()
);

-- Tabel History Asal (Digunakan untuk menentukan Flag "PunyaSaldo" di Target)
CREATE TABLE dbo.tbl_history (
    id_hist INT IDENTITY(1,1) PRIMARY KEY,
    nik NVARCHAR(20) NOT NULL,
    aktivitas NVARCHAR(100) NOT NULL
);
GO

-- Masukkan Data Dummy Asal
INSERT INTO dbo.tbl_pelanggan (nik, nama_lengkap, telepon, tgl_daftar) VALUES
('1234567890', 'Rasimin Salim', '08123456789', '2026-01-10 08:00:00'),
('9876543210', 'Budi Hartono', '08567890123', '2026-02-15 09:30:00'),
('5555555555', 'Ahmad Syarif', '08777777777', '2026-03-20 10:45:00');

INSERT INTO dbo.tbl_transaksi (nik_pelanggan, nominal, tgl_trx) VALUES
('1234567890', 150000.00, '2026-05-10 14:00:00'),
('1234567890', 250000.00, '2026-05-12 15:30:00'),
('9876543210', 500000.00, '2026-05-15 11:20:00');

-- Catatan: Hanya Rasimin (1234567890) dan Ahmad (5555555555) yang punya history. 
-- Budi Hartono (9876543210) tidak punya history.
INSERT INTO dbo.tbl_history (nik, aktivitas) VALUES
('1234567890', 'Login Aplikasi Pertama'),
('5555555555', 'Verifikasi Akun Berhasil');
GO


-- 2. SETUP DATABASE TARGET (DB BARU B)
IF EXISTS (SELECT * FROM sys.databases WHERE name = 'TargetDB')
BEGIN
    ALTER DATABASE TargetDB SET SINGLE_USER WITH ROLLBACK IMMEDIATE;
    DROP DATABASE TargetDB;
END
GO

CREATE DATABASE TargetDB;
GO

USE TargetDB;
GO

-- Tabel Pelanggan Tujuan (Menggunakan Surrogate Key INT Auto-Increment, dengan flag PunyaSaldo kondisional)
CREATE TABLE dbo.TargetCustomers (
    idcustomer INT IDENTITY(1,1) PRIMARY KEY,
    nik NVARCHAR(20) NOT NULL UNIQUE,
    FullName NVARCHAR(100) NOT NULL,
    Phone NVARCHAR(20) NULL,
    PunyaSaldo BIT NOT NULL DEFAULT 0, -- Kolom Flag bersyarat
    RegistrationDate DATETIME NOT NULL DEFAULT GETDATE()
);

-- Tabel Transaksi Tujuan (Merujuk ke idcustomer, bukan NIK lagi!)
CREATE TABLE dbo.TargetTransactions (
    Id INT IDENTITY(1,1) PRIMARY KEY,
    idcustomer INT NOT NULL FOREIGN KEY REFERENCES dbo.TargetCustomers(idcustomer),
    Amount DECIMAL(18,2) NOT NULL,
    TransactionDate DATETIME NOT NULL DEFAULT GETDATE()
);
GO
