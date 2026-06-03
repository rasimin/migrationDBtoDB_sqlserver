@echo off
:: ==========================================
:: SCRIPT OTOMASI PUBLISH .NET CORE KE IIS
:: ==========================================

:: 1. Atur lokasi path project dan folder tujuan publish baru
set PROJECT_PATH=D:\Rasimin\Learn\HiBankQNB\DbMigrator.Web\DbMigrator.Web.csproj
set OUTPUT_PATH=D:\Rasimin\Learn\publish\HIbankQNB

echo [1/3] Membersihkan folder publish lama...
if exist "%OUTPUT_PATH%" rd /s /q "%OUTPUT_PATH%"

echo.
echo [2/3] Memulai proses dotnet publish...
:: Perintah untuk build dan publish dengan konfigurasi Release
dotnet publish "%PROJECT_PATH%" -c Release -o "%OUTPUT_PATH%" --no-self-contained

if %ERRORLEVEL% NEQ 0 (
    echo.
    echo --------------------------------------------------
    echo [ERROR] Proses publish GAGAL! Silakan cek error di atas.
    echo --------------------------------------------------
    pause
    exit /b %ERRORLEVEL%
)

echo.
echo [3/3] Proses publish BERHASIL!
echo Lokasi hasil publish: %OUTPUT_PATH%
echo.

:: 2. Membuka folder hasil publish secara otomatis di Windows Explorer
explorer "%OUTPUT_PATH%"

pause