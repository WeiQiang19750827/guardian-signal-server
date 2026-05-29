@echo off
title Guardian Git Deploy v1.100
color 0F
setlocal enabledelayedexpansion

set "ROOT=%~dp0"
cd /d "%ROOT%"

echo =============================================
echo   Guardian Git Deploy v1.99
echo   Push to GitHub, Railway auto-deploys
echo =============================================
echo.
echo This script pushes changes to GitHub.
echo Railway will automatically deploy from the main branch.
echo.

where git >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Git not found. Install from https://git-scm.com
    pause
    exit /b 1
)
echo [OK] Git found

:: Check for changes
git status --porcelain | findstr . >nul 2>&1
if errorlevel 1 (
    echo [INFO] No changes to commit.
    echo   Run deploy-railway.bat to force a redeploy.
    pause
    exit /b 0
)

:: Stage all
git add -A
if errorlevel 1 (
    echo [ERROR] Git add failed
    pause
    exit /b 1
)
echo [OK] Files staged

:: Commit
git commit -m "auto deploy v1.100"
if errorlevel 1 (
    echo [ERROR] Commit failed
    pause
    exit /b 1
)
echo [OK] Changes committed

:: Push
git push
if errorlevel 1 (
    echo [ERROR] Push failed. Check your git remote.
    echo   Remote: 
    git remote -v
    pause
    exit /b 1
)
echo [OK] Push successful, Railway auto-deploy triggered

echo.
echo =============================================
echo  Deploy triggered!
echo =============================================
echo.
echo  Railway will automatically build and deploy.
echo  Check status: https://railway.app/dashboard
echo.
echo  To verify: run check-server.bat after 2-3 minutes
echo.
pause