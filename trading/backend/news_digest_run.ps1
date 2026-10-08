# News-digest routine launcher — CODE-ONLY mode (no Claude / no AI, to save the Pro limit).
# Just calls the backend's /news/digest-run-plain endpoint, which dedupes by code, tags a keyword
# category, and pushes fresh headlines to Telegram. Fast (no claude spin-up). Logs to %TEMP%.
$ErrorActionPreference = 'SilentlyContinue'
$log  = Join-Path $env:TEMP 'news_digest.log'
$lock = Join-Path $env:TEMP 'news_digest.lock'

# Single-instance guard (endpoint isn't safe to run concurrently).
if (Test-Path $lock) {
    $age = (New-TimeSpan -Start (Get-Item $lock).LastWriteTime).TotalMinutes
    if ($age -lt 10) { "$(Get-Date -Format o)  skipped — another run active" | Add-Content $log; exit }
}
New-Item -ItemType File -Path $lock -Force | Out-Null
try {
    "$(Get-Date -Format o)  --- plain run start ---" | Add-Content $log
    try {
        $r = Invoke-RestMethod -Uri 'http://localhost:8000/news/digest-run-plain' -Method Post -TimeoutSec 120
        "posted=$($r.posted) clusters=$($r.clusters) dropped_dupes=$($r.dropped_window_dupes) more_pending=$($r.more_pending)" | Add-Content $log
    } catch {
        $msg = $_.Exception.Message
        "ERROR calling digest-run-plain: $msg" | Add-Content $log
        # Best-effort throttled Telegram alert (only works if the backend itself is up).
        $stamp = Join-Path $env:TEMP 'news_digest_alert.stamp'
        $recent = (Test-Path $stamp) -and ((New-TimeSpan -Start (Get-Item $stamp).LastWriteTime).TotalHours -lt 3)
        if (-not $recent) {
            $body = @{ text = "&#9888;&#65039; <b>News digest run failed.</b> Check the trading box backend (:8000)." } | ConvertTo-Json -Compress
            try { Invoke-RestMethod -Uri 'http://localhost:8000/news/alert' -Method Post -Body $body -ContentType 'application/json' -TimeoutSec 15 | Out-Null
                  Set-Content -Path $stamp -Value (Get-Date -Format o) } catch {}
        }
    }
    "$(Get-Date -Format o)  --- plain run end ---" | Add-Content $log
} finally {
    Remove-Item $lock -Force -ErrorAction SilentlyContinue
}
