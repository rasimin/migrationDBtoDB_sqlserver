# 🤖 Alur Kerja CRUD & Fitur Baru - Multi-Agent Loop

Dokumen ini menjelaskan alur kerja **Multi-Agent Loop** terbaru yang dikonfigurasi khusus untuk melakukan pengujian fungsional CRUD (Create, Read, Update, Delete) secara mendalam, serta penambahan fitur-fitur baru (*new features*) pada aplikasi DbMigrator.

---

## 👥 Profil & Peran Agen Baru

Siklus ini digerakkan secara berpasangan oleh dua agen spesialis:

### 1. 🔍 CRUDTesterAgent (Ahli Penguji CRUD & Fungsional / Fitur Baru)
*   **Tugas**: Menguji secara kritis seluruh fungsi CRUD pada antarmuka web dan API (membuat, membaca, mengupdate, dan menghapus Job, Table Mappings, dan Column Mappings). Mengidentifikasi celah fungsi atau merancang fitur baru yang diperlukan.
*   **Output**: Menyusun dan memperbarui berkas `crud_feature_list.md` di folder utama berisi temuan bug CRUD atau spesifikasi fitur baru.
*   **Aturan**: Melakukan pengujian fungsional yang sangat teliti, merinci kriteria penerimaan (*acceptance criteria*), dan menugaskannya ke agen Coder untuk dikerjakan.

### 2. 💻 CRUDCoderAgent (Ahli Coding .NET Core & Web Developer)
*   **Tugas**: Membaca berkas `crud_feature_list.md` yang diserahkan oleh Tester, menuliskan perbaikan bug CRUD, membuat repositori database, API endpoints, serta mendesain antarmuka UI baru pada frontend web.
*   **Output**: Mengimplementasikan kode program, melakukan verifikasi build compile (`dotnet build`), dan menandai status tugas menjadi `[x] Resolved`.
*   **Aturan**: Menjaga kualitas dan kerapian penulisan kode program C# (.NET Core 8) dan HTML/CSS/JS, lalu memberi tahu Tester untuk melakukan pengujian ulang setelah selesai.

---

## 🔄 Siklus Kerja Tertutup Pengujian CRUD & Fitur Baru (Closed-Loop CRUD Cycle)

```mermaid
graph TD
    Start([Mulai Pengujian CRUD]) --> Audit[CRUDTester Menguji CRUD & Merancang Fitur Baru]
    Audit --> WriteList[CRUDTester Membuat crud_feature_list.md]
    WriteList --> Assign[CRUDTester Menyerahkan ke CRUDCoder]
    
    Assign --> Code[CRUDCoder Mengimplementasikan Kode & Centang [x] Resolved]
    Code --> Compile[CRUDCoder Memverifikasi Build Compile]
    Compile --> Notify[CRUDCoder Memberi Tahu CRUDTester]
    
    Notify --> ReTest[CRUDTester Menguji Ulang Semua Fungsi]
    ReTest --> CheckRemaining{Apakah List Selesai & Bebas Bug?}
    
    CheckRemaining -- Belum --> UpdateList[CRUDTester Update crud_feature_list.md]
    UpdateList --> Assign
    
    CheckRemaining -- Ya --> Finish([CRUD Selesai Sempurna & Rilis])
```

### Kategori CRUD & Fitur Baru yang Diuji:
1.  **CRUD Jobs**: Membuat Job baru, melihat daftar job, memperbarui connection string, dan menghapus job.
2.  **CRUD Table Mappings**: Menambah pemetaan tabel, mengatur urutan eksekusi, mengaktifkan/menonaktifkan, dan menghapus pemetaan.
3.  **CRUD Column Mappings**: Menentukan kolom target, memilih tipe mapping (*Direct, Constant, Lookup, Expression, Ignore*), menyimpan hasil secara bulk, dan membersihkan pemetaan lama.
4.  **Fitur Baru Tambahan**: Fitur-fitur opsional pendukung migrasi (seperti log detail histori, pembatalan migrasi, scheduling kueri, atau eksekusi *post-migration*).
