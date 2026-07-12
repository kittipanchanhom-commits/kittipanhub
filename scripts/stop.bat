@echo off
title Torrent Video Browser - Stop
cd /d "%~dp0"

echo Stopping Torrent Video Browser...
echo.

echo * Stopping server...
taskkill /f /im python.exe >nul 2>&1

echo * Stopping Cloudflare Tunnel...
taskkill /f /im cloudflared.exe >nul 2>&1

echo.
echo Done.
timeout /t 2 /nobreak >nul
