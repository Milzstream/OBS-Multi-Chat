@echo off
setlocal
cd /d "%~dp0"
echo Building Relay Chat Dock into deploy\
call npm run package:win
if errorlevel 1 goto fail
echo.
echo Ready. Run deploy\relay-chat-dock.exe
pause
exit /b 0
:fail
echo.
echo Build failed.
pause
exit /b 1
