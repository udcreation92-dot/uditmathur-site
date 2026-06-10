# Camera Continuous Recorder
# Records all cameras to D:\recordings, keeps 7 days, splits into 1-hour files

$FFMPEG     = "C:\ffmpeg\ffmpeg.exe"
$OUTPUT_DIR = "D:\recordings"
$KEEP_DAYS  = 7

$CAMERAS = @(
    @{ id = "camera_01"; rtsp = "rtsp://localhost:8554/camera_01" },
    @{ id = "camera_02"; rtsp = "rtsp://localhost:8554/camera_02" },
    @{ id = "camera_03"; rtsp = "rtsp://localhost:8554/camera_03" }
)

# Create output folders
foreach ($cam in $CAMERAS) {
    New-Item -ItemType Directory -Force "$OUTPUT_DIR\$($cam.id)" | Out-Null
}

# Delete footage older than 7 days
function Cleanup {
    $cutoff = (Get-Date).AddDays(-$KEEP_DAYS)
    foreach ($cam in $CAMERAS) {
        Get-ChildItem "$OUTPUT_DIR\$($cam.id)" -Recurse -File |
            Where-Object { $_.LastWriteTime -lt $cutoff } |
            Remove-Item -Force
        # Remove empty date folders
        Get-ChildItem "$OUTPUT_DIR\$($cam.id)" -Directory |
            Where-Object { (Get-ChildItem $_.FullName).Count -eq 0 } |
            Remove-Item -Force
    }
    Write-Host "$(Get-Date -Format 'HH:mm:ss') Cleanup done"
}

# Start ffmpeg for one camera — records in 1-hour segments
function Start-Camera($cam) {
    $dateDir = "$OUTPUT_DIR\$($cam.id)\$(Get-Date -Format 'yyyy-MM-dd')"
    New-Item -ItemType Directory -Force $dateDir | Out-Null

    $outPattern = "$dateDir\%H-%M-%S.mp4"

    $args = @(
        "-rtsp_transport", "tcp",
        "-i", $cam.rtsp,
        "-c:v", "copy",
        "-c:a", "aac",
        "-f", "segment",
        "-segment_time", "180",
        "-segment_atclocktime", "1",
        "-segment_format", "mp4",
        "-reset_timestamps", "1",
        "-strftime", "1",
        "-y",
        $outPattern
    )

    Write-Host "$(Get-Date -Format 'HH:mm:ss') Starting $($cam.id)"
    return Start-Process -FilePath $FFMPEG -ArgumentList $args -PassThru -WindowStyle Hidden
}

# Main loop — restarts any crashed camera process
$processes = @{}
Cleanup

while ($true) {
    # Daily cleanup at midnight
    if ((Get-Date -Format 'HH:mm') -eq '00:01') { Cleanup }

    foreach ($cam in $CAMERAS) {
        $proc = $processes[$cam.id]
        if (-not $proc -or $proc.HasExited) {
            if ($proc) { Write-Host "$(Get-Date -Format 'HH:mm:ss') $($cam.id) crashed, restarting..." }
            $processes[$cam.id] = Start-Camera $cam
        }
    }

    Start-Sleep -Seconds 30
}
