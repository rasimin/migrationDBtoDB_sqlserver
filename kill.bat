@echo off
title DbMigrator - Kill Process
color 0C

echo ============================================
echo   DbMigrator.Web - Kill All Instances
echo ============================================
echo.

echo [INFO] Mencari proses dotnet yang berjalan...
echo.

:: Tampilkan proses dotnet yang aktif sebelum kill
tasklist /fi "imagename eq dotnet.exe" /fo table

echo.
echo [WARN] Semua proses dotnet.exe akan dihentikan!
echo        Tekan CTRL+C untuk batal, atau...
timeout /t 5 /nobreak >nul

echo.
echo [INFO] Menghentikan semua proses dotnet.exe...
taskkill /f /im dotnet.exe >nul 2>&1

if %errorlevel% equ 0 (
    echo [OK]   Semua proses dotnet.exe berhasil dihentikan.
) else (
    echo [INFO] Tidak ada proses dotnet.exe yang berjalan.
)

:: Pastikan port 5000/5001 bebas juga
echo.
echo [INFO] Memeriksa port 5000 dan 5001...

for %%P in (5000 5001) do (
    for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":%%P " ^| findstr "LISTENING" 2^>nul') do (
        echo [WARN] Port %%P masih digunakan oleh PID %%a, menghentikan...
        taskkill /f /pid %%a >nul 2>&1
        echo [OK]   PID %%a dihentikan.
    )
)

echo.
echo ============================================
echo   Selesai. Aman untuk menjalankan start.bat
echo ============================================
echo.
pause
