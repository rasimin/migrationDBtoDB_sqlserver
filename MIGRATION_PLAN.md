# Rencana Migrasi Database Dinamis - .NET Core

Dokumen ini mencatat detail koneksi database, rancangan arsitektur, serta solusi teknis dinamis untuk menangani berbagai kasus khusus (*use cases*) dalam migrasi database dari SQL Server ke SQL Server (Source DB ke Target DB) dengan struktur yang berbeda.

---

## 📌 Detail Koneksi Database Aplikasi Migrasi
Aplikasi migrasi ini akan menyimpan konfigurasi mapping, status job, dan log migrasi pada database utama yang diletakkan di server SQL Server berikut:

*   **Host/Server Instance:** `RASIMIN\MSSQLSERVER2022`
*   **Nama Database / Username:** `appims`
*   **Password:** `P4ssw0rd`

### Connection String SQL Server (SQL Authentication):
```connectionstring
Server=RASIMIN\MSSQLSERVER2022;Database=appims;User Id=appims;Password=P4ssw0rd;TrustServerCertificate=True;
```

---

## 🛠️ Desain Arsitektur & Solusi Kasus Khusus

Aplikasi dirancang menggunakan **Metadata-Driven Execution** dengan **ASP.NET Core Web Dashboard** agar seluruh proses migrasi dan konfigurasi dapat diatur secara dinamis tanpa perlu mengubah source code C#.

```
                                +-------------------------------+
                                |        Web Dashboard UI       |
                                |     (ASP.NET Core Web App)    |
                                +---------------+---------------+
                                                |
                                                v (Simpan / Monitor)
                                +---------------+---------------+
                                |        Database appims        |
                                |    (Mapping, Jobs & Logs)     |
                                +---------------+---------------+
                                                |
                                                v (Baca Konfigurasi)
  +--------------------+        +---------------+---------------+        +--------------------+
  |  Source Database   +------->|      Migration Engine         +------->|  Target Database   |
  |  (Struktur Lama A) |        |    (.NET 8 Core & Core API)   |        | (Struktur Baru B)  |
  +--------------------+        +-------------------------------+        +--------------------+
```

---

## 💡 Penanganan Kasus Migrasi Kompleks

Berdasarkan hasil diskusi, berikut adalah solusi teknis dinamis yang kita terapkan untuk menangani relasi database dan logika kondisi:

### 1. Penanganan Primary Key (PK) & Foreign Key (FK)
*   **Urutan Migrasi (Execution Order)**: Kita menggunakan kolom `ExecutionOrder` di konfigurasi tabel (misalnya tabel Induk bernilai `1`, tabel Anak bernilai `2`). Engine migrasi akan selalu memproses data secara berurutan agar integritas relasi (FK) tidak error di database tujuan.
*   **Mempertahankan Nilai ID (Identity)**: Untuk kolom PK auto-increment, aplikasi menggunakan opsi `KeepIdentity` saat melakukan bulk copy. Ini secara otomatis mengaktifkan `SET IDENTITY_INSERT TargetTable ON` di SQL Server sehingga nilai ID asli dari database lama tidak berubah dan relasi dengan tabel anak tetap terjaga sempurna.

### 2. Lookup Relasi Dinamis (Contoh: NIK $\rightarrow$ ID Baru)
*   **Kasus**: Di tabel transaksi database asal hanya ada kolom `nik`, sedangkan tabel transaksi database baru membutuhkan kolom `idcustomer` (yang nilainya baru digenerate saat migrasi tabel induk).
*   **Solusi (In-Memory Cache Lookup)**:
    1. Pada konfigurasi kolom, tipe mapping diatur menjadi `Lookup`.
    2. Konfigurasi mencatat tabel referensi tujuan (`TargetCustomers`), kolom kunci (`nik`), dan kolom nilai yang ingin diambil (`idcustomer`).
    3. Sebelum memproses tabel Transaksi, Engine migrasi akan memuat "kamus data" ke memori RAM: `Dictionary<string, int> lookupMap` yang menghubungkan `nik` dengan `idcustomer`.
    4. Saat data transaksi dibaca satu per satu, Engine melakukan pencarian O(1) yang super cepat di memori untuk menerjemahkan `nik` lama ke `idcustomer` baru, lalu menyimpannya ke tabel transaksi tujuan.

### 3. Pemetaan Bersyarat / Kolom Baru (Contoh: Flag `PunyaSaldo` dari Tabel `History`)
*   **Kasus**: Di database tujuan ada kolom flag `PunyaSaldo`, sedangkan di database asal kolom ini tidak ada dan nilainya bergantung pada apakah pelanggan tersebut memiliki data di tabel `history`.
*   **Solusi A (SQL Expression Dinamis)**:
    *   Tipe mapping diatur menjadi `Expression`.
    *   Kita memasukkan potongan query SQL kondisional pada konfigurasi mapping:
        `CASE WHEN EXISTS (SELECT 1 FROM tbl_history H WHERE H.nik = Source.nik) THEN 1 ELSE 0 END`
    *   Saat menarik data dari database asal, Engine secara dinamis merangkai potongan query tersebut ke dalam perintah `SELECT` utama. Database asal akan mengeksekusi logika ini secara native dengan kecepatan maksimal, lalu hasilnya langsung dipetakan ke kolom `PunyaSaldo` di target.
*   **Solusi B (Post-Migration Script)**:
    *   Tabel konfigurasi mendukung pengisian script SQL pasca migrasi. Setelah tabel utama selesai dipindahkan, script SQL optimasi/update massal akan otomatis dijalankan untuk mengisi flag-flag bersyarat tersebut secara massal di database tujuan.

---

## 🎨 Premium Web UI Dashboard
Untuk mempermudah pengelolaan seluruh pemetaan ini tanpa perlu menulis query SQL manual ke tabel konfigurasi, kita akan melengkapi aplikasi ini dengan Dashboard Web modern berbasis **ASP.NET Core**:

1.  **Database Connection Manager**: Halaman untuk input dan verifikasi koneksi ke Source DB, Target DB, dan database migrasi `appims`.
2.  **Interactive Column Mapper**: Interface intuitif berupa drop-down untuk memilih tipe mapping kolom:
    *   Jika pilih `Direct` $\rightarrow$ Muncul dropdown kolom asal.
    *   Jika pilih `Constant` $\rightarrow$ Muncul form input nilai statis.
    *   Jika pilih `Lookup` $\rightarrow$ Form input tabel referensi, kolom kunci, dan kolom ID tujuan akan muncul secara dinamis.
    *   Jika pilih `Expression` $\rightarrow$ Muncul area penulisan query SQL kondisional.
3.  **Real-Time Migration Runner**: Halaman eksekusi dengan tombol "Run" dilengkapi **Progress Bar real-time** berbasis **SignalR** dan log berwarna (hijau untuk sukses, merah untuk error) untuk memonitor jalannya data yang dipindahkan detik demi detik.

---

## 📅 Rencana Langkah Implementasi Lanjutan

1.  **Langkah 1: Setup Skema Database Konfigurasi (`appims`)**
    *   Menyiapkan file script `schema.sql` untuk di-deploy ke server `RASIMIN\MSSQLSERVER2022`.
2.  **Langkah 2: Pembuatan Solution & Project .NET 8**
    *   Inisialisasi solution `.sln` dengan project `DbMigrator.Core` (Engine) dan `DbMigrator.Web` (Dashboard UI).
3.  **Langkah 3: Implementasi Engine Inti & Caching**
    *   Menulis modul pembaca data dinamis (`SqlDataReader`), in-memory lookup cache, dan dynamic query compiler.
4.  **Langkah 4: Pembuatan Web UI Dashboard**
    *   Mendesain frontend premium (Vanilla CSS dengan nuansa gelap/terang modern, layout responsif, animasi mikro).
    *   Integrasi SignalR untuk push status migrasi secara real-time dari backend ke halaman browser.
5.  **Langkah 5: Pengujian & Simulasi**
    *   Menyiapkan data dummy untuk melakukan simulasi skenario PK/FK, pencarian NIK $\rightarrow$ ID, serta pengisian kolom bersyarat `PunyaSaldo`.
