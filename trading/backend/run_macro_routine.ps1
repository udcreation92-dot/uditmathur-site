# Macro/geopolitical CALENDAR routine launcher (the one AI touch we kept).
# Runs headless Claude (Haiku) to detect scheduled, dated market/geopolitical events in recent news
# and file them as pending Calendar suggestions. Runs INFREQUENTLY (twice a day) since calendar
# events change slowly — keeps Claude Pro usage minimal. Logs to %TEMP% (not OneDrive); single lock.
$ErrorActionPreference = 'SilentlyContinue'
$log  = Join-Path $env:TEMP 'macro_routine.log'
$lock = Join-Path $env:TEMP 'macro_routine.lock'

if (Test-Path $lock) {
    $age = (New-TimeSpan -Start (Get-Item $lock).LastWriteTime).TotalMinutes
    if ($age -lt 15) { "$(Get-Date -Format o)  skipped — another run active" | Add-Content $log; exit }
}
New-Item -ItemType File -Path $lock -Force | Out-Null
try {
    Set-Location $PSScriptRoot   # so Claude reads macro_routine_prompt.txt from the backend folder
    "$(Get-Date -Format o)  --- macro run start ---" | Add-Content $log
    & claude -p 'Read the file macro_routine_prompt.txt in the current directory and follow its instructions exactly.' --model haiku --allowedTools 'Read' 'Bash' *>> $log
    "$(Get-Date -Format o)  --- macro run end ---" | Add-Content $log
} finally {
    Remove-Item $lock -Force -ErrorAction SilentlyContinue
}
