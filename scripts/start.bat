@echo off
title KittipanHub
cd /d "%~dp0\.."

:menu
cls
echo ===============================================
echo   KittipanHub — Torrent Video Browser
echo ===============================================
echo.
echo   Catalog: https://kittipanhub-worker.yogajourney.workers.dev
echo.
echo   [1]  Open catalog in browser
echo   [2]  Upload videos to Drive (GUI)
echo   [3]  Auto-watch: upload new files automatically
echo   [4]  Deploy Worker (after code changes)
echo   [5]  Exit
echo.
set /p choice="Choose [1-5]: "

if "%choice%"=="1" start https://kittipanhub-worker.yogajourney.workers.dev & goto menu
if "%choice%"=="2" start "Upload GUI" python src/upload_gui.py & start http://127.0.0.1:5001 & goto menu
if "%choice%"=="3" start "Auto Upload Watcher" python src/auto_upload.py & goto menu
if "%choice%"=="4" call scripts/deploy.bat & goto menu
if "%choice%"=="5" exit /b
goto menu
