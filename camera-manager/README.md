# Camera Manager

One Node service that replaces the old **go2rtc + recorder/record.ps1 + ptz-server** trio.
Runs on the home PC (same box as the Trading Dashboard). Records straight from each camera
with ffmpeg (no go2rtc), serves the recordings to the website, and lets you **add / delete
cameras via ONVIF from the site's ⚙ Manage cameras panel**.

## What it does
- **cameras.json** — the single source of truth (was hard-coded in two files before).
- **ONVIF** — add a camera by IP + login; it auto-pulls the RTSP URL. "Scan LAN" does WS-Discovery.
- **Recorder** — one ffmpeg per enabled camera → `D:\recordings\<id>\<date>\%H-%M-%S.mp4`
  (3-min segments, kept `KEEP_DAYS`=7). Auto-restarts crashed recorders every 30s; rolls to the
  new day's folder automatically.
- **Recordings API** — same paths the website already used, so the player is unchanged.

## First-time setup (on the home PC)
1. Install Node (already present) and ffmpeg at `C:\ffmpeg\ffmpeg.exe` (or set `FFMPEG`).
2. In this folder: `npm install`
3. Create `token.txt` here containing the same value as the Cloudflare Worker's `CAMERA_TOKEN`
   (one line, no quotes). `.gitignore`d — never commit it.
4. Start it: `start-camera-manager.bat`
5. **Auto-start on boot:** put a *shortcut* to `start-camera-manager.bat` in
   `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup`.

## Cloudflare tunnel
Point `recordings.uditmathur.uk` at `http://localhost:8080` (the manager listens on :8080,
same port the old ptz-server used, so the existing tunnel keeps working). The old
`stream.uditmathur.uk` go2rtc tunnel is no longer needed.

## Environment variables (all optional, sensible defaults)
| Var | Default | Meaning |
|---|---|---|
| `CAMERA_TOKEN` | *(unset = open/dev)* | Shared token; must match the Worker |
| `RECORDINGS_DIR` | `D:\recordings` | Where footage is written |
| `FFMPEG` | `C:\ffmpeg\ffmpeg.exe` | ffmpeg path |
| `PORT` | `8080` | HTTP port |
| `KEEP_DAYS` | `7` | Retention |
| `SEGMENT_SECS` | `180` | Clip length |

## API (all require `X-Camera-Token` / `?token=` except `/health`)
- `GET /cameras` · `POST /cameras` (add) · `DELETE /cameras/:id`
- `POST /cameras/:id/toggle` (pause/resume) · `POST /cameras/:id/refresh` (re-detect after IP change)
- `POST /cameras/discover` (LAN scan)
- `GET /recordings` · `/recordings/:cam` · `/recordings/:cam/:date` · `/recordings/:cam/:date/:file`
- `GET /health`

## Deprecated (kept for reference, no longer used)
`../cameras/go2rtc.yaml`, `../recorder/record.ps1`, `../ptz-server/`. Live WebRTC viewing was
dropped by choice (recordings-only). To bring live back later, re-add go2rtc just for viewing.
