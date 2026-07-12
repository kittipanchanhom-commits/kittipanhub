@echo off
title KittipanHub - Upload Progress
cd /d "%~dp0\.."

echo ================================
echo   Uploading videos to Google Drive
echo   DO NOT CLOSE this window
echo ================================
echo.
python src/upload.py
echo.
echo Upload complete or interrupted.
pause
