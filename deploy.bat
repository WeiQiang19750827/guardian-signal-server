@echo off
title Guardian Deploy v1.100
color 0F
setlocal enabledelayedexpansion

set "ROOT=%~dp0"
cd /d "%ROOT%"

echo =============================================
echo   Guardian Deploy v1.100 - One-click deploy
echo =============================================
echo.

:: ----- Step 1: Check Railway CLI -----
where railway >nul 2>&1
if errorlevel 1 (
    echo [STEP 1/5] Installing Railway CLI...
    call npm install -g @railway/cli
    if errorlevel 1 (
        echo [ERROR] Install failed. Manual: npm install -g @railway/cli
        pause
        exit /b 1
    )
) else (
    echo [STEP 1/5] Railway CLI OK
)

:: ----- Step 2: Auth -----
echo.
echo [STEP 2/5] Authentication...

:: Check env var first, then file
if not "%RAILWAY_TOKEN%"=="" (
    echo [OK] Using env RAILWAY_TOKEN
    goto :check_auth
)

if exist ".railway_token" (
    set /p RAILWAY_TOKEN=<.railway_token
    if not "!RAILWAY_TOKEN!"=="" (
        echo [OK] Token loaded from .railway_token
        goto :check_auth
    )
)

:: No token - prompt user
echo [SETUP] No Railway token found.
echo.
echo Get a permanent token (never expires):
echo   1. Open https://railway.app/account/tokens
echo   2. Click "Generate New Token"
echo   3. Copy the token value
echo.
set /p "USER_TOKEN=Enter token: "
if "!USER_TOKEN!"=="" (
    echo [ERROR] Token required
    pause
    exit /b 1
)
set "RAILWAY_TOKEN=!USER_TOKEN!"
echo !USER_TOKEN!>".railway_token"
attrib +h .railway_token >nul 2>&1
echo [OK] Token saved to .railway_token (hidden)

:check_auth
railway whoami >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Token invalid. Get a new one from Railway Dashboard.
    del .railway_token >nul 2>&1
    pause
    exit /b 1
)
for /f "tokens=*" %%a in ('railway whoami 2^>nul') do set "WHOAMI=%%a"
echo [OK] Authenticated as: %WHOAMI%

:: ----- Step 3: Link Project -----
echo.
echo [STEP 3/5] Project link...

railway status >nul 2>&1
if errorlevel 1 (
    echo [INFO] Linking project (select Guardian from list)...
    railway link
    if errorlevel 1 (
        echo [ERROR] Link failed
        pause
        exit /b 1
    )
)
echo [OK] Project linked

:: ----- Step 4: Deploy -----
echo.
echo [STEP 4/5] Deploying to Railway...
echo.

railway up --detach
if errorlevel 1 (
    echo [ERROR] Deploy failed
    pause
    exit /b 1
)
echo [OK] Deploy triggered

:: ----- Step 5: Verify -----
echo.
echo [STEP 5/5] Verifying deployment...
echo Waiting 20 seconds for server startup...
ping -n 20 127.0.0.1 >nul 2>&1

echo.
echo Checking server version...
powershell -Command "try { $r = Invoke-WebRequest -Uri 'https://guardian-signal-server-production.up.railway.app/health' -TimeoutSec 10 -UseBasicParsing; $j = $r.Content | ConvertFrom-Json; if ($j.version -eq '1.100') { Write-Host 'VERSION: v1.100 [OK]' -ForegroundColor Green } else { Write-Host 'VERSION: v'$j.version' [check dashboard]' -ForegroundColor Yellow } } catch { Write-Host 'Health check: still starting...' }"

echo.
echo =============================================
echo  Done! 
echo =============================================
echo.
echo  Next time: just double-click this file again.
echo  Check status: %ROOT%check-server.bat
echo.
pause