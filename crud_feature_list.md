# 📝 Daftar Temuan Audit CRUD & Spesifikasi Fitur Baru (CRUD & Feature List)

Aplikasi: **DbMigrator (.NET Core 8 & Single-Page Web UI)**  
Workspace: `D:\Rasimin\Learn\HIbankQNB`  
Status Siklus: **Siklus Pertama (Pengujian & Spesifikasi Awal)**  

---

## 📌 Ringkasan Temuan Audit CRUD
Kami telah melakukan pengujian fungsional yang kritis terhadap operasi CRUD pada entitas **Jobs, Table Mappings, dan Column Mappings** di tingkat visual Web UI maupun backend REST API. Kami menemukan beberapa celah kritis terkait validasi data, ketiadaan fungsi hapus pada entitas utama, serta potensi ketidakstabilan migrasi yang disebabkan oleh duplikasi data konfigurasi.

Selain itu, kami merancang **4 fitur baru** yang krusial untuk meningkatkan keandalan migrasi database, efisiensi kerja administrator, dan pemantauan historis yang transparan.

---

## 🛠️ Daftar Tugas Bug CRUD & Fitur Baru (Task List)

### 1. BUG-CRUD-001: Ketiadaan API dan UI untuk Menghapus Job (Delete Job)
*   **ID**: `BUG-CRUD-001`
*   **Judul & Komponen**: Ketiadaan Fungsi Penghapusan Job (Backend REST API & Frontend Sidebar)
*   **Tipe**: `CRUD Bug`
*   **Deskripsi**:  
    Saat ini, pengguna dapat membuat Job baru (`POST /api/jobs`) dan memperbaruinya, tetapi **tidak ada** mekanisme atau tombol untuk menghapus Job yang sudah usang atau salah konfigurasi secara fatal. Ini mengakibatkan penumpukan data sampah pada database konfigurasi `appims.dbo.MigrationJobs`.
*   **Expected Behavior / Acceptance Criteria**:
    1. **Backend REST API**:
       - Tambahkan endpoint `DELETE /api/jobs/{id:int}` di `DbMigrator.Web/Program.cs`.
       - Endpoint ini harus melakukan penghapusan rekaman Job dari tabel `dbo.MigrationJobs` berdasarkan ID-nya.
       - Skema database configurator menggunakan `ON DELETE CASCADE` untuk relasi foreign key dari tabel `TableMappings`, `ColumnMappings`, dan `MigrationLogs` ke `MigrationJobs`. Pastikan penghapusan job secara otomatis menghapus seluruh data relasi tersebut di database secara aman.
       - Mengembalikan status `200 OK` jika berhasil, atau `404 NotFound` jika Job tidak ditemukan.
    2. **Frontend UI**:
       - Di dalam kontainer daftar job (`job-list-container`) pada `wwwroot/app.js` dan `index.html`, tambahkan tombol/icon hapus (misalnya icon tong sampah `fa-solid fa-trash-can` berwarna merah) di samping setiap item Job.
       - Tombol harus menghentikan event bubbling agar tidak men-trigger event `selectJob(id)` saat diklik.
       - Tampilkan dialog konfirmasi interaktif: `Apakah Anda yakin ingin menghapus Job [Nama Job] beserta seluruh konfigurasi tabel dan kolomnya? Tindakan ini tidak dapat dibatalkan!` sebelum memanggil API.
       - Jika sukses dihapus, refresh daftar job menggunakan `loadJobs()` dan bersihkan panel editor utama ke tampilan `welcome-panel`.
*   **Status**: [x] Resolved

---

### 2. BUG-CRUD-002: Kerentanan Connection Timeout & Ketiadaan Validasi Connection String di Backend
*   **ID**: `BUG-CRUD-002`
*   **Judul & Komponen**: Ketiadaan Validasi Koneksi Database Saat Pembuatan/Perbaruan Job (Backend Validation & Frontend UI)
*   **Tipe**: `CRUD Bug`
*   **Deskripsi**:  
    Ketika pengguna mengisi form Job baru atau mengedit Job, program langsung menyimpan connection string Source dan Target DB secara mentah tanpa memvalidasi apakah string tersebut valid atau dapat diakses. Jika terdapat kesalahan ketik atau server database tidak aktif, program akan sukses menyimpannya di DB configurator, tetapi kemudian akan crash dengan `SqlException` (connection timeout/handshake failed) ketika dashboard mencoba mengambil skema metadata tabel/kolom atau saat migrasi dijalankan.
*   **Expected Behavior / Acceptance Criteria**:
    1. **Backend REST API**:
       - Buat endpoint baru `POST /api/jobs/test-connection` di `Program.cs`.
       - Endpoint ini menerima payload connection string dan mencoba membuka koneksi database menggunakan `SqlConnection.OpenAsync()`.
       - Jika koneksi berhasil terbuka, tutup koneksi dan kembalikan `200 OK` dengan properti `{ Success: true, Message: "Koneksi berhasil terhubung!" }`.
       - Jika terjadi error (misalnya login failed, network error, timeout), tangkap exception dan kembalikan `{ Success: false, Message: "Gagal terhubung: [Detail Pesan Error]" }`.
    2. **Frontend UI**:
       - Di dalam form `job-form-box` di `index.html`, tambahkan tombol **"Test Connection"** di samping input `Source Connection String` dan `Target Connection String`.
       - Ketika tombol diklik, panggil endpoint `/api/jobs/test-connection` menggunakan `fetch` dan tampilkan indikator visual loading, serta tampilkan pesan alert sukses/gagal secara interaktif kepada pengguna.
       - Lakukan validasi otomatis sebelum menyimpan job: jika test koneksi gagal, berikan peringatan kepada pengguna namun tetap perbolehkan penyimpanan dengan opsi override jika user memaksa.
*   **Status**: [x] Resolved

---

### 3. BUG-CRUD-003: Kerentanan Duplikasi Table Mapping pada Job yang Sama
*   **ID**: `BUG-CRUD-003`
*   **Judul & Komponen**: Duplikasi Pemetaan Tabel Asal/Tujuan pada Satu Job (Backend API Validation)
*   **Tipe**: `CRUD Bug`
*   **Deskripsi**:  
    Saat ini tidak ada validasi unik di tingkat REST API untuk mencegah pembuatan pemetaan tabel ganda untuk tabel asal atau tujuan yang sama pada satu Job. Jika pengguna secara tidak sengaja menambahkan pemetaan untuk `tbl_pelanggan -> TargetCustomers` sebanyak dua kali, engine migrasi akan memproses tabel tersebut dua kali. Hal ini menyebabkan crash karena duplikasi data primer atau kerusakan integritas data.
*   **Expected Behavior / Acceptance Criteria**:
    1. **Backend REST API**:
       - Pada endpoint `POST /api/mappings/tables` di `Program.cs`, tambahkan logika validasi sebelum melakukan operasi INSERT atau UPDATE.
       - Jika operasi adalah INSERT (Id == 0): Pastikan tidak ada rekaman di tabel `dbo.TableMappings` untuk `JobId` yang sama yang memiliki `SourceTableName` ATAU `TargetTableName` yang sama dengan input.
       - Jika operasi adalah UPDATE (Id > 0): Pastikan tidak ada rekaman lain (Id berbeda) untuk `JobId` yang sama yang memiliki `SourceTableName` atau `TargetTableName` yang sama.
       - Jika terdeteksi adanya duplikasi, batalkan penyimpanan dan kembalikan `400 BadRequest` dengan pesan error: `Pemetaan untuk tabel asal atau tujuan tersebut sudah terdaftar pada Job ini!`.
    2. **Frontend UI**:
       - Tampilkan pesan kesalahan dari backend tersebut menggunakan dialog modal/alert interaktif jika pengguna mencoba memasukkan data duplikat.
*   **Status**: [x] Resolved

---

### 4. FEAT-001: Fitur Pembatalan Migrasi yang Sedang Berjalan (Interactive Migration Cancellation)
*   **ID**: `FEAT-001`
*   **Judul & Komponen**: Fitur Membatalkan Proses Migrasi Berjalan (Backend Engine CancellationToken & Frontend UI Runner)
*   **Tipe**: `New Feature`
*   **Deskripsi**:  
    Saat ini migrasi berjalan di background (`Task.Run`) dan tidak dapat diinterupsi dari dashboard UI secara interaktif oleh user. Jika pengguna memproses tabel berukuran besar (jutaan baris) dan menyadari ada kesalahan pemetaan kolom di tengah jalan, mereka tidak dapat menghentikannya kecuali mematikan proses server IIS/Kestrel. Kita memerlukan fitur untuk membatalkan proses migrasi yang sedang berjalan secara dinamis dan aman.
*   **Expected Behavior / Acceptance Criteria**:
    1. **Backend Logic & API**:
       - Di `Program.cs`, kelola sebuah dictionary statis/singleton untuk melacak CancellationTokenSource yang aktif per JobId: `static readonly ConcurrentDictionary<int, CancellationTokenSource> ActiveJobTokens = new();`.
       - Pada endpoint `POST /api/jobs/{id:int}/run`, sebelum memulai Task.Run, buat instansi `CancellationTokenSource` baru, simpan ke dalam `ActiveJobTokens`, dan kirimkan `cts.Token` tersebut ke dalam method `engine.RunJobAsync(...)`.
       - Buat endpoint baru `POST /api/jobs/{id:int}/cancel` di `Program.cs`. Endpoint ini bertugas mencari `CancellationTokenSource` di `ActiveJobTokens` berdasarkan ID Job, lalu memanggil `.Cancel()` dan menghapusnya dari dictionary.
       - Engine migrasi (`MigrationEngine.cs`) harus mendeteksi token pembatalan (`cancellationToken.ThrowIfCancellationRequested()`) di setiap loop perpindahan tabel dan loop batching data (`reader.ReadAsync()`).
       - Ketika pembatalan terdeteksi, engine harus:
         - Me-rollback transaksi database SQL Server yang sedang berjalan di tabel tersebut agar integritas data tetap terjaga.
         - Memperbarui status log migrasi aktif di `dbo.MigrationLogs` menjadi `Failed` dengan pesan error: `Proses dibatalkan oleh pengguna.`.
         - Mengirimkan update status `Failed` / `Cancelled` via SignalR ke client.
    2. **Frontend UI**:
       - Di dashboard UI pada panel runner (`active-runner-panel`), tambahkan tombol merah **"Batalkan Migrasi" (Cancel Migration)** di samping status runner ketika berstatus `RUNNING`.
       - Ketika tombol diklik, panggil endpoint `POST /api/jobs/{id}/cancel` via fetch.
       - Nonaktifkan tombol segera setelah diklik dan tampilkan pesan transisi: `Sedang membatalkan proses migrasi secara aman...`.
*   **Status**: [x] Resolved

---

### 5. FEAT-002: Fitur Eksekusi Kueri SQL Pasca-Migrasi (Post-Migration SQL Script Execution)
*   **ID**: `FEAT-002`
*   **Judul & Komponen**: Eksekusi Script SQL Kustom Setelah Migrasi Selesai (Backend Engine Database & Frontend Job Form)
*   **Tipe**: `New Feature`
*   **Deskripsi**:  
    Setelah pemindahan seluruh tabel selesai, administrator sering kali perlu menjalankan query SQL optimasi kustom di database tujuan (seperti membangun ulang indeks/indeks spasial, memperbarui statistik, menghitung ulang total saldo agregat, atau mengaktifkan kembali foreign key constraint yang sempat dinonaktifkan). Kita membutuhkan kolom input skrip SQL pasca-migrasi pada konfigurasi Job yang akan dieksekusi secara otomatis oleh engine di akhir proses migrasi yang sukses.
*   **Expected Behavior / Acceptance Criteria**:
    1. **Database Schema & Model**:
       - Jalankan script migrasi/DDL untuk menambahkan kolom `PostMigrationScript NVARCHAR(MAX) NULL` pada tabel `dbo.MigrationJobs` di database `appims`.
       - Tambahkan properti `public string PostMigrationScript { get; set; }` pada kelas `MigrationJob` di `DbMigrator.Core/Models.cs`.
    2. **Backend API & Engine**:
       - Perbarui endpoint `POST /api/jobs` di `Program.cs` agar menyimpan/memperbarui data kolom `PostMigrationScript` baru ini ke database.
       - Perbarui `MigrationEngine.cs`: setelah loop pemindahan seluruh tabel yang terdaftar selesai dijalankan dengan sukses (tanpa error fatal), periksa apakah `PostMigrationScript` terisi.
       - Jika terisi, buka koneksi ke database target (`TargetConnectionString`), jalankan script SQL tersebut di dalam cakupan transaksi baru, dan catat log eksekusinya ke `dbo.MigrationLogs` dengan nama tabel virtual `[POST-MIGRATION-SCRIPT]`.
       - Jika script pasca-migrasi gagal dieksekusi, tandai status log-nya sebagai `Failed` dan kirim detail error-nya ke dashboard UI via SignalR.
    3. **Frontend UI**:
       - Di dalam form `job-form-box` di `index.html`, tambahkan elemen `textarea` dengan label **"Post-Migration SQL Script"** (dengan font monospaced Consolas) agar pengguna dapat menuliskan perintah SQL kustom mereka.
       - Pastikan frontend mengirimkan isi textarea tersebut dalam payload saat menyimpan Job di `saveJob()`.
*   **Status**: [x] Resolved

---

### 6. FEAT-003: Pencatatan Detail Statistik Histori Migrasi di UI (Migration History Tab & Stats)
*   **ID**: `FEAT-003`
*   **Judul & Komponen**: Panel Histori Eksekusi dan Visualisasi Statistik Migrasi (Frontend Dashboard UI & Backend Log API)
*   **Tipe**: `New Feature`
*   **Deskripsi**:  
    Saat ini, setelah halaman dashboard di-refresh, progres migrasi yang berjalan di layar runner akan hilang. Pengguna tidak memiliki cara untuk meninjau riwayat migrasi masa lalu, durasi eksekusi tabel, total baris yang telah sukses dipindahkan secara kumulatif, atau kegagalan yang terjadi kemarin. Kita membutuhkan tab/panel khusus "Histori Migrasi" untuk menampilkan data dari `MigrationLogs`.
*   **Expected Behavior / Acceptance Criteria**:
    1. **Backend REST API**:
       - Pastikan endpoint `GET /api/logs/{jobId:int}` di `Program.cs` mengambil data log eksekusi terbaru dari `dbo.MigrationLogs` diurutkan berdasarkan `StartTime DESC`.
    2. **Frontend UI**:
       - Buat tab navigasi baru di dashboard di samping judul pemetaan tabel: **"Konfigurasi Pemetaan"** dan **"Histori Migrasi"**.
       - Ketika tab "Histori Migrasi" diklik, sembunyikan daftar pemetaan tabel dan tampilkan panel histori.
       - Panel histori harus memuat:
         - **Cards Statistik Agregat**:
           - *Total Eksekusi Job*: Berapa kali job dijalankan.
           - *Kumulatif Baris Sukses*: Penjumlahan kolom `RowsMigrated` dari semua log berstatus `Completed`.
           - *Tingkat Keberhasilan*: Persentase eksekusi sukses dibanding total eksekusi.
         - **Tabel Log Riwayat**:
           - Tampilkan kolom: Nama Tabel, Waktu Mulai, Durasi (detik/menit), Total Baris, Baris Termigrasi, Status (dengan badge warna hijau/merah/kuning), dan kolom khusus "Pesan Error" yang dapat diekspansi jika berstatus `Failed`.
         - Tombol **"Refresh Logs"** untuk memuat ulang data log dari API secara real-time.
*   **Status**: [x] Resolved

---

### 7. FEAT-004: Ekspor dan Impor Konfigurasi Pemetaan Sebagai File JSON (Export/Import Mapping Config)
*   **ID**: `FEAT-004`
*   **Judul & Komponen**: Ekspor & Impor Konfigurasi Job dan Pemetaan Kolom (Backend REST API & Frontend Toolbar)
*   **Tipe**: `New Feature`
*   **Deskripsi**:  
    Melakukan konfigurasi pemetaan tabel dan puluhan kolom secara manual di UI sangat memakan waktu. Administrator membutuhkan kemampuan untuk mengekspor seluruh konfigurasi suatu Job (termasuk Table Mappings dan Column Mappings-nya) ke dalam sebuah file JSON lokal, dan mengimpornya kembali untuk menduplikasi job atau memindahkannya ke server development/production lain dengan cepat.
*   **Expected Behavior / Acceptance Criteria**:
    1. **Backend REST API**:
       - Buat endpoint `GET /api/jobs/{id:int}/export` di `Program.cs`. Endpoint ini mengambil detail Job, menyertakan relasi list `TableMappings` beserta list `ColumnMappings` di bawah masing-masing tabel mapping, lalu mengembalikannya sebagai payload JSON terstruktur.
       - Buat endpoint `POST /api/jobs/import` di `Program.cs` yang menerima payload JSON konfigurasi ekspor tersebut. Endpoint ini harus:
         - Membuat rekaman `MigrationJob` baru di database (dengan nama job yang otomatis diberi suffix ` - Imported` jika nama asli sudah ada).
         - Memasukkan seluruh `TableMappings` baru.
         - Memasukkan seluruh `ColumnMappings` baru di bawah tabel mapping yang sepadan.
         - Mengembalikan objek Job baru yang berhasil dibuat.
    2. **Frontend UI**:
       - Di samping nama Job yang aktif di dashboard, tambahkan tombol **"Ekspor JSON"** (icon `fa-solid fa-file-export`). Ketika diklik, panggil API ekspor dan trigger browser untuk mendownload file JSON (misal: `job_[nama_job]_config.json`).
       - Tambahkan tombol **"Impor JSON"** (icon `fa-solid fa-file-import`) di panel samping dekat tombol "Tambah Job Baru".
       - Ketika diklik, tampilkan modal/dialog pemilihan file JSON lokal. Setelah file dipilih, baca isinya menggunakan `FileReader` di Javascript dan kirimkan ke endpoint `/api/jobs/import`.
       - Setelah sukses mengimpor, muat ulang daftar job dan langsung aktifkan/pilih Job baru hasil impor tersebut.
*   **Status**: [x] Resolved

---

### 8. BUG-CRUD-004: Kegagalan Truncate Target Karena Foreign Key Constraint yang Merusak Transaksi Aktif (Transaction Aborting Error)
*   **ID**: `BUG-CRUD-004`
*   **Judul & Komponen**: Kegagalan TRUNCATE pada Tabel yang Direferensikan FK Menyebabkan Transaksi Doomed (Backend Engine)
*   **Tipe**: `CRUD Bug`
*   **Deskripsi**:  
    Pada `MigrationEngine.cs`, ketika pemetaan tabel memiliki opsi `TruncateTarget` aktif, engine akan mencoba menjalankan perintah `TRUNCATE TABLE`. Di SQL Server, perintah `TRUNCATE TABLE` akan selalu gagal secara instan jika tabel tersebut direferensikan oleh foreign key constraint di tabel lain (seperti `TargetCustomers` yang dirujuk oleh `TargetTransactions`), meskipun tabel anak tersebut kosong.  
    Kegagalan ini memicu *transaction-aborting error* di SQL Server, sehingga transaksi saat itu dinonaktifkan/doomed. Akibatnya, blok `catch` yang mencoba melakukan fallback ke perintah `DELETE FROM` gagal dengan exception `System.InvalidOperationException: The transaction is either not associated with the current connection or has been completed` dan merusak seluruh proses migrasi.
*   **Expected Behavior / Acceptance Criteria**:
    1. **Backend Engine (`DbMigrator.Core/MigrationEngine.cs`)**:
       - Sebelum mencoba menjalankan `TRUNCATE TABLE`, engine harus secara proaktif memeriksa apakah tabel target direferensikan oleh foreign key constraint dengan menanyakan metadata database SQL Server.
       - Gunakan kueri SQL berikut untuk mendeteksi jumlah foreign key yang merujuk ke tabel target:
         ```sql
         SELECT COUNT(*) FROM sys.foreign_keys WHERE referenced_object_id = OBJECT_ID(@TableName)
         ```
       - Jika jumlah foreign key lebih besar dari 0, engine harus langsung menjalankan kueri `DELETE FROM [NamaTabel]` secara aman.
       - Jika jumlah foreign key bernilai 0, engine dapat menggunakan perintah `TRUNCATE TABLE [NamaTabel]` untuk performa yang optimal.
       - Dengan cara ini, tidak akan ada error yang merusak status transaksi aktif, sehingga proses migrasi dapat berjalan lancar.
*   **Status**: [x] Resolved

