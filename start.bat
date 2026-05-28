@echo off
title DbMigrator - Running
color 0A

echo ============================================
echo   DbMigrator.Web - Starting...
echo ============================================
echo.

cd /d "%~dp0DbMigrator.Web"

echo [INFO] Working directory: %CD%
echo [INFO] Starting dotnet run...
echo.

dotnet run --project DbMigrator.Web.csproj

echo.
echo [INFO] Server stopped.
pause
