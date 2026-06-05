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

:: Step 3: Inject native permissions plugin
echo [3/4] Injecting native permissions plugin...
if not exist "%ROOT%guardian-app\platforms\android\app\src\main\java\com\android\plugins" mkdir "%ROOT%guardian-app\platforms\android\app\src\main\java\com\android\plugins"
copy /Y "%ROOT%plugin-files\Permissions.java" "%ROOT%guardian-app\platforms\android\app\src\main\java\com\android\plugins\Permissions.java" >nul 2>&1
:: Inject Permissions feature into config.xml
powershell -Command "$f='%ROOT%guardian-app\platforms\android\app\src\main\res\xml\config.xml';$x=Get-Content $f -Raw;if($x -notmatch 'Permissions'){$x=$x-replace '</widget>','<feature name=\"Permissions\"><param name=\"android-package\" value=\"com.android.plugins.Permissions\" /></feature></widget>';[System.IO.File]::WriteAllText($f,$x,[System.Text.UTF8Encoding]::new($false))}"
:: Create plugin JS directory
if not exist "%ROOT%guardian-app\platforms\android\app\src\main\assets\www\plugins\cordova-plugin-android-permissions\www" mkdir "%ROOT%guardian-app\platforms\android\app\src\main\assets\www\plugins\cordova-plugin-android-permissions\www"
copy /Y "%ROOT%plugin-files\permissions.js" "%ROOT%guardian-app\platforms\android\app\src\main\assets\www\plugins\cordova-plugin-android-permissions\www\permissions.js" >nul 2>&1
copy /Y "%ROOT%plugin-files\cordova_plugins.js" "%ROOT%guardian-app\platforms\android\app\src\main\assets\www\cordova_plugins.js" >nul 2>&1
echo [OK] Permissions plugin injected

:: Step 4: Build
echo [4/4] Building APK...
cd /d "%ROOT%guardian-app\platforms\android"

:: Fix: Windows 11 24H2+ UCRT API Sets compat
set AAPT2_NO_DAEMON=1

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
copy /Y "%ROOT%guardian-app\platforms\android\app\build\outputs\apk\debug\app-debug.apk" "%ROOT%guardian-v4.3.5.apk"
echo [OK] APK: guardian-v4.3.5.apk

echo.
echo =============================================
echo  Build Complete!
echo =============================================
echo  APK: guardian-v4.3.5.apk (%ROOT%)
echo.
pause