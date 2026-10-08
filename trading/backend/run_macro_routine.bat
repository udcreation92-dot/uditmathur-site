@echo off
REM -- Macro/geopolitical CALENDAR routine (the one AI touch kept after news went code-only) -------
REM Thin wrapper around run_macro_routine.ps1, which runs headless Claude (Haiku) to detect
REM scheduled, dated events in recent news and file them as pending Calendar suggestions.
REM Scheduled TWICE A DAY (task "MacroCalendar") to keep Claude Pro usage minimal.
REM Log: %TEMP%\macro_routine.log   Requires: backend on :8000 + Claude Code logged in.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0run_macro_routine.ps1"
