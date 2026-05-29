@echo off
title Guardian Server Check v1.99
color 0F
echo =============================================
echo   Guardian Server Status Check v1.99
echo =============================================
echo.
echo Checking server: wss://guardian-signal-server-production.up.railway.app
echo.
powershell -Command "try { $r = Invoke-WebRequest -Uri 'https://guardian-signal-server-production.up.railway.app/health' -TimeoutSec 10 -UseBasicParsing; Write-Host 'STATUS: ONLINE' -ForegroundColor Green; Write-Host 'Response:' $r.Content } catch { Write-Host 'STATUS: OFFLINE' -ForegroundColor Red; Write-Host 'Error:' $_.Exception.Message }"
echo.
echo If it shows status: ok with a version number, the server is working.
echo.
pause