# 🤖 Alur Kerja Multi-Agent QA & Coding (Dynamic Cycle)

Dokumen ini menjelaskan rancangan sistem **Multi-Agent** otomatis yang bekerja dalam siklus tertutup (*closed-loop cycle*) untuk melakukan pengujian UI/UX, perbaikan kode (*coding/debugging*), dan penjaminan kualitas (*quality assurance*).

---

## 👥 Profil & Peran Agen

Sistem ini digerakkan oleh tiga Agen khusus yang didefinisikan secara khusus dengan keahlian masing-masing:

### 1. 🔍 UITesterAgent (Ahli Pengujian UI/UX & Fungsional)
*   **Tugas**: Menganalisis antarmuka (Glassmorphism, responsivitas layout, transisi, animasi) dan kode logika backend (skema DB, penanganan query, edge cases).
*   **Output**: Menulis dan memperbarui berkas `bug_tasklist.md` di folder utama jika mendeteksi adanya bug/error tampilan maupun fungsi.
*   **Aturan**: Agen ini hanya mencari dan mendokumentasikan bug secara detail tanpa mengubah kode program sama sekali.

### 2. 💻 ExpertCoderAgent (Ahli Coding & Debugging)
*   **Tugas**: Menerima daftar tugas dari `bug_tasklist.md`, menganalisis kode sumber, dan mengimplementasikan perbaikan (*bug fixing*) yang bersih, cepat, dan aman pada C# (.NET Core), HTML, CSS, atau Javascript.
*   **Output**: Mengubah kode program dan memperbarui status bug dari belum dikerjakan `[ ]` menjadi selesai `[x] Resolved` pada berkas `bug_tasklist.md`.

### 3. 🛡️ QAMonitorAgent (Koordinator Progress & QA Lead)
*   **Tugas**: Mengatur, memantau, dan memastikan siklus pengujian-debugging berjalan tertib dan tuntas hingga tidak ada lagi bug yang tersisa.
*   **Output**: Mengorkestrasi jalannya pengujian ulang, memeriksa keberhasilan kompilasi program (`dotnet build`), dan melaporkan hasil akhir keberhasilan proyek kepada Anda.

---

## 🔄 Siklus Kerja Agen (Agent Cycle Loop)

Siklus ini berjalan secara otomatis dan berulang sampai aplikasi benar-benar bersih dari masalah:

```mermaid
graph TD
    Start([Mulai Siklus QA]) --> TriggerTest[QAMonitor memicu UITester]
    TriggerTest --> Audit[UITester mengaudit UI & Fungsional]
    Audit --> CheckBugs{Apakah ada Bug?}
    
    CheckBugs -- Ya --> WriteList[UITester membuat/update bug_tasklist.md]
    WriteList --> Assign[QAMonitor menugaskan ExpertCoder]
    Assign --> FixCode[ExpertCoder memperbaiki Kode & centang [x] Resolved]
    FixCode --> VerifyBuild[QAMonitor memverifikasi build compile]
    VerifyBuild --> TriggerTest
    
    CheckBugs -- Tidak --> Complete[Aplikasi 100% Bersih & Siap Rilis]
    Complete --> Report[QAMonitor melapor ke User]
```

### Penjelasan Tahapan Siklus:
1.  **Langkah 1: Audit Awal**  
    `QAMonitorAgent` memicu `UITesterAgent` untuk mulai mengaudit seluruh aplikasi.
2.  **Langkah 2: Pencatatan Bug**  
    Jika `UITesterAgent` menemukan masalah (misal: tombol kurang presisi, CSS tidak responsif, atau error koneksi DB), ia akan mencatatnya di `bug_tasklist.md` dengan status `[ ]`.
3.  **Langkah 3: Perbaikan Kode**  
    `QAMonitorAgent` melihat adanya daftar bug, lalu langsung mengirimkan perintah kerja ke `ExpertCoderAgent`. Agen Coder akan menelusuri kode, memperbaikinya, memastikan program bisa di-compile, lalu mengubah statusnya menjadi `[x] Resolved`.
4.  **Langkah 4: Tes Ulang (Re-testing)**  
    Setelah Coder selesai, `QAMonitorAgent` meminta `UITesterAgent` untuk melakukan pengujian menyeluruh sekali lagi dari awal untuk memastikan perbaikan tidak merusak fitur lain (*regression testing*).
5.  **Langkah 5: Penyelesaian**  
    Siklus 2-4 akan terus berputar secara otomatis sampai `UITesterAgent` menyatakan **0 Bug Found**. `QAMonitorAgent` kemudian menutup siklus dan memberikan laporan final kepada Anda bahwa proyek siap rilis dengan kualitas terbaik!
