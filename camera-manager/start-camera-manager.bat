@echo off
REM ── Camera Manager auto-start ───────────────────────────────────────────────
REM Put a SHORTCUT to this file in:
REM   %APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup
REM so recording survives every reboot (this was the reason recording stopped).

cd /d "%~dp0"

REM RECORDINGS_DIR / FFMPEG — change if yours differ
set "RECORDINGS_DIR=D:\recordings"
set "FFMPEG=C:\ffmpeg\ffmpeg.exe"
set "PORT=8080"
set "KEEP_DAYS=7"

REM CAMERA_TOKEN must match the Cloudflare Worker's CAMERA_TOKEN.
REM Store it in token.txt (one line) next to this file — kept out of the app.
if exist "%~dp0token.txt" (
  set /p CAMERA_TOKEN=<"%~dp0token.txt"
)

echo Starting Camera Manager on port %PORT% ...
node "%~dp0server.js"
pause
