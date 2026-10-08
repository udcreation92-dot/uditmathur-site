@echo off
REM ── Reliable backend restart ─────────────────────────────────────────────────
REM Fixes the two Windows/OneDrive traps that made restarts silently fail:
REM   1) kills the REAL uvicorn worker holding port 8000 (not just the parent), and
REM   2) clears stale __pycache__ so OneDrive mtime quirks can't load old bytecode.
REM Run this whenever you change backend code and want it live.

cd /d "%~dp0"

echo Stopping any running backend (uvicorn parent + worker children)...
powershell -NoProfile -Command ^
  "Get-CimInstance Win32_Process -Filter \"name='python.exe'\" | Where-Object { $_.CommandLine -like '*uvicorn*main:app*' -or $_.CommandLine -like '*multiprocessing-fork*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"
timeout /t 3 >nul

echo Clearing stale bytecode...
for /d /r %%d in (__pycache__) do @if exist "%%d" rd /s /q "%%d" 2>nul

echo Starting backend on http://localhost:8000  (leave this window open; close it to stop)
python -m uvicorn main:app --host 0.0.0.0 --port 8000
