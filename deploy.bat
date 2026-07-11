@echo off
title KittipanHub Deploy
cd /d "%~dp0"

echo ====================================
echo   KittipanHub - Deploy to Cloudflare
echo ====================================
echo.

echo   Setting secrets (3 prompts)...
echo   API_TOKEN = your static password
echo   GOOGLE_SA_EMAIL = xxx@xxx.iam.gserviceaccount.com
echo   GOOGLE_SA_KEY = -----BEGIN PRIVATE KEY-----...
echo.

echo   Step 1/3: API_TOKEN
call npx wrangler secret put API_TOKEN
echo   Step 2/3: GOOGLE_SA_EMAIL
call npx wrangler secret put GOOGLE_SA_EMAIL
echo   Step 3/3: GOOGLE_SA_KEY
call npx wrangler secret put GOOGLE_SA_KEY

echo.
echo   Deploying Worker...
call npx wrangler deploy

echo.
echo   Done!
echo   URL: https://kittipanhub-worker.workers.dev
pause
