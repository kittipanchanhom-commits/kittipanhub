@echo off
title KittipanHub Deploy
cd /d "%~dp0\.."

echo ====================================
echo   KittipanHub - Deploy to Cloudflare
echo ====================================
echo.
echo   Deploying Worker...
call npx wrangler deploy

echo.
echo   Done!
echo   URL: https://kittipanhub-worker.workers.dev
pause
