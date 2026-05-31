@echo off
title Guardian Build APK v1.1008
color 0F
setlocal enabledelayedexpansion

set "ROOT=%~dp0"
cd /d "%ROOT%guardian-app"

set ANDROID_HOME=%ROOT%android-sdk
set ANDROID_SDK_ROOT=%ROOT%android-sdk

echo =============================================
echo   Guardian Build APK v1.100
echo =============================================
echo.

:: Step 1: Prepare
echo [1/4] Running cordova prepare...
call cordova prepare android 2>nul
if errorlevel 1 (
    echo [ERROR] cordova prepare failed
    pause
    exit /b 1
)
echo [OK] cordova prepare complete

:: Step 2: Set SDK version
echo [2/4] Setting COMPILE_SDK_VERSION to 36...
powershell -Command "$json = Get-Content 'platforms\android\cdv-gradle-config.json' -Raw | ConvertFrom-Json; $json.COMPILE_SDK_VERSION = 36; $json | ConvertTo-Json | Set-Content 'platforms\android\cdv-gradle-config.json' -Encoding UTF8"
echo [OK] SDK version set

:: Step 3: Build
echo [3/4] Building APK...
cd /d "%ROOT%guardian-app\platforms\android"
call gradlew.bat assembleDebug 2>nul
if errorlevel 1 (
    echo [ERROR] Build failed
    cd /d "%ROOT%"
    pause
    exit /b 1
)
echo [OK] Build successful

:: Step 4: Copy APK
echo [4/4] Copying APK to project root...
cd /d "%ROOT%"
copy /Y "%ROOT%guardian-app\platforms\android\app\build\outputs\apk\debug\app-debug.apk" "%ROOT%guardian-v3.0.0.apk"
echo [OK] APK: guardian-v3.0.0.apk

echo.
echo =============================================
echo  Build Complete!
echo =============================================
echo  APK: guardian-v2.0.14.apk (%ROOT%)
echo.
pause