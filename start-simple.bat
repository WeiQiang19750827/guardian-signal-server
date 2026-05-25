
@echo off
title Guardian Server

echo.
echo Starting Guardian Server...
echo.

cd /d "%~dp0"

:: Try to find node.exe - use quoted set to handle spaces
set NODE_EXE=
if exist "D:\Program Files\nodejs\node.exe" (
    set "NODE_EXE=D:\Program Files\nodejs\node.exe"
)
if exist "%ProgramFiles%\nodejs\node.exe" (
    set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
)
if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" (
    set "NODE_EXE=%LOCALAPPDATA%\Programs\nodejs\node.exe"
)

:: Try path search if still not found
if not defined NODE_EXE (
    where node.exe >nul 2>&1
    if not errorlevel 1 (
        set "NODE_EXE=node.exe"
    )
)

if not defined NODE_EXE (
    echo ERROR: Node.js not found!
    echo Please install Node.js from https://nodejs.org/
    pause
    exit /b 1
)

echo Using Node.js: "%NODE_EXE%"
"%NODE_EXE%" --version
echo.

if not exist node_modules (
    echo Installing dependencies...
    call npm install
    echo.
)

echo Starting server...
"%NODE_EXE%" start.js

pause
