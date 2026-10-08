@echo off
REM -- News digest + calendar routine (runs every ~30 min) -----------------------
REM Thin wrapper around news_digest_run.ps1, which:
REM   - runs headless Claude (Haiku) to dedupe/categorize news and push to Telegram + calendar,
REM   - logs to %TEMP%\news_digest.log (NOT OneDrive, so a sync lock can't hang the run),
REM   - uses a lock file so a double-click and Task Scheduler can't run two copies at once.
REM
REM Schedule this .bat in Task Scheduler every 30 min, "Run whether user is logged on or not".
REM View the log at:  %TEMP%\news_digest.log
REM Requires: trading backend on localhost:8000, and Claude Code logged in on this box.

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0news_digest_run.ps1"
