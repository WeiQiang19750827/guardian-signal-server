@echo off
title Guardian Deploy Setup v1.99
color 0F
setlocal enabledelayedexpansion

set "ROOT=%~dp0"
cd /d "%ROOT%"

echo =============================================
echo   Guardian Deploy Setup v1.99
echo   One-time configuration tool
echo =============================================
echo.
echo This setup will configure automatic Railway deployment.
echo.
echo =============================================
echo  Step 1: Check Railway CLI
echo =============================================
echo.

where railway >nul 2>&1
if errorlevel 1 (
    echo [INSTALL] Installing Railway CLI...
    npm install -g @railway/cli
    if errorlevel 1 (
        echo [ERROR] Install failed. Install manually:
        echo   npm install -g @railway/cli
        pause
        exit /b 1
    )
    echo [OK] Railway CLI installed
) else (
    echo [OK] Railway CLI already installed
)

echo.
echo =============================================
echo  Step 2: Get Railway Token
echo =============================================
echo.
echo A Railway API token is needed for automatic login.
echo.
echo How to get a token:
echo   1. Open https://railway.app/account/tokens in your browser
echo   2. Click "Generate New Token"
echo   3. Copy the token value
echo.
echo Paste your Railway token below and press Enter:
echo.

set /p "USER_TOKEN=Token: "

if "!USER_TOKEN!"=="" (
    echo [ERROR] Token cannot be empty
    pause
    exit /b 1
)

echo !USER_TOKEN!>".railway_token"
echo [OK] Token saved to .railway_token

echo.
echo =============================================
echo  Step 3: Verify Token
echo =============================================
echo.

set "RAILWAY_TOKEN=%USER_TOKEN%"
railway whoami >nul 2>&1
if errorlevel 1 (
    echo [WARN] Token verification failed.
    echo   The token may be invalid or expired.
    echo   Check https://railway.app/account/tokens
) else (
    for /f "tokens=*" %%a in ('railway whoami 2^>nul') do set "WHOAMI=%%a"
    echo [OK] Authenticated as: !WHOAMI!
)

echo.
echo =============================================
echo  Step 4: Link Project (one-time)
echo =============================================
echo.
echo Linking to Railway project. Select your project:
echo.

railway link
if errorlevel 1 (
    echo [WARN] Link skipped. You can run 'railway link' later.
)

echo.
echo =============================================
echo  Setup Complete!
echo =============================================
echo.
echo  What to do next:
echo  - Deploy: run deploy-railway.bat (fully automatic)
echo  - Git deploy: run deploy-git.bat
echo  - Check server: run check-server.bat
echo.
echo  Token saved in .railway_token (DO NOT share this file)
echo.
pause