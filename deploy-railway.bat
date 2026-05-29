@echo off
title Guardian Railway Deploy v1.100
color 0F
setlocal enabledelayedexpansion

set "ROOT=%~dp0"
cd /d "%ROOT%"

echo =============================================
echo   Guardian Railway Deploy v1.99
echo   Zero-interaction automatic deployment
echo =============================================
echo.

where railway >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Railway CLI not found
    echo Install: npm install -g @railway/cli
    pause
    exit /b 1
)
railway --version 2>&1 | find "4." >nul
if errorlevel 1 (
    echo [WARN] Railway CLI version may not be compatible
) else (
    echo [OK] Railway CLI
)

:: --- Step 1: Read Token ---
echo.
echo =============================================
echo  Step 1/5: Load Railway Token
echo =============================================
echo.

if not exist ".railway_token" (
    echo [INFO] Token file not found.
    echo   First-time setup required.
    echo   Run setup-deploy.bat to configure once.
    echo.
    pause
    exit /b 1
)

set /p RAILWAY_TOKEN=<.railway_token
if "!RAILWAY_TOKEN!"=="" (
    echo [ERROR] Token file is empty.
    echo   Run setup-deploy.bat to configure.
    pause
    exit /b 1
)
echo [OK] Token loaded

:: --- Step 2: Authenticate ---
echo.
echo =============================================
echo  Step 2/5: Authenticate
echo =============================================
echo.

railway whoami >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Authentication failed.
    echo   Token may be expired. Run setup-deploy.bat to renew.
    pause
    exit /b 1
)
for /f "tokens=*" %%a in ('railway whoami 2^>nul') do set "WHOAMI=%%a"
echo [OK] Authenticated as: %WHOAMI%

:: --- Step 3: Link Project ---
echo.
echo =============================================
echo  Step 3/5: Link Project
echo =============================================
echo.

railway status >nul 2>&1
if errorlevel 1 (
    echo [INFO] Project not linked. Linking now...
    echo   Select your project from the list.
    railway link
    if errorlevel 1 (
        echo [ERROR] Link failed
        pause
        exit /b 1
    )
) else (
    echo [OK] Project linked
)

:: --- Step 4: Deploy ---
echo.
echo =============================================
echo  Step 4/5: Deploy to Railway
echo =============================================
echo.
echo Deploying: signaling-server.js (v1.100, PeerJS+Relay)
echo.

railway up --detach
if errorlevel 1 (
    echo [ERROR] Deploy command failed
    pause
    exit /b 1
)
echo [OK] Deploy command sent

:: --- Step 5: Verify ---
echo.
echo =============================================
echo  Step 5/5: Verify Deployment
echo =============================================
echo.
echo Waiting 15 seconds for server startup...
ping -n 15 127.0.0.1 >nul 2>&1

echo.
echo Checking /health endpoint...
echo.
powershell -Command "try { $r = Invoke-WebRequest -Uri 'https://guardian-signal-server-production.up.railway.app/health' -TimeoutSec 10 -UseBasicParsing; Write-Host 'SERVER RESPONSE:' -ForegroundColor Green; Write-Host $r.Content } catch { Write-Host '[WARN] Health check not ready yet' }"

echo.
echo =============================================
echo  Deployment Complete!
echo =============================================
echo.
echo  Version: v1.99
echo  Server: wss://guardian-signal-server-production.up.railway.app
echo  Health: https://guardian-signal-server-production.up.railway.app/health
echo.
echo  To check status anytime: run check-server.bat
echo.
pause