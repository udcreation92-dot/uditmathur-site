// Camera Manager — one service that does everything:
//   1. Owns cameras.json (single source of truth)
//   2. ONVIF discover / add / delete / refresh-RTSP from the website
//   3. Runs & supervises one ffmpeg recorder per enabled camera (direct from camera, no go2rtc)
//   4. Serves recordings to the website (absorbs the old ptz-server)
//
// Replaces: go2rtc + recorder/record.ps1 + ptz-server/server.js
//
// Env:
//   CAMERA_TOKEN   shared token (must match Cloudflare Worker's CAMERA_TOKEN). If unset → open (dev).
//   RECORDINGS_DIR default D:\recordings
//   FFMPEG         default C:\ffmpeg\ffmpeg.exe
//   PORT           default 8080
//   KEEP_DAYS      default 7
//   SEGMENT_SECS   default 180

const express = require('express');
const fs      = require('fs');
const path    = require('path');
const { spawn } = require('child_process');
let onvif;
try { onvif = require('onvif'); } catch { onvif = null; }

const RECORDINGS_DIR = process.env.RECORDINGS_DIR || 'D:\\recordings';
const FFMPEG         = process.env.FFMPEG || 'C:\\ffmpeg\\ffmpeg.exe';
const CAMERA_TOKEN   = process.env.CAMERA_TOKEN;
const PORT           = parseInt(process.env.PORT || '8080', 10);
const KEEP_DAYS      = parseInt(process.env.KEEP_DAYS || '7', 10);
const SEGMENT_SECS   = parseInt(process.env.SEGMENT_SECS || '180', 10);
const CONFIG_FILE    = path.join(__dirname, 'cameras.json');

// ── Config store ────────────────────────────────────────────────────────────
function loadCameras() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); }
  catch { return []; }
}
function saveCameras(list) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(list, null, 2));
}
let cameras = loadCameras();

// Slugify a name into a filesystem-safe camera id
function makeId(name) {
  const base = String(name || 'camera').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'camera';
  let id = base, n = 1;
  const used = new Set(cameras.map(c => c.id));
  while (used.has(id)) id = `${base}_${++n}`;
  return id;
}

// Inject credentials into an ONVIF-returned RTSP URI (which usually omits them)
function withCreds(rtspUri, user, pass) {
  if (!user) return rtspUri;
  try {
    const u = new URL(rtspUri);
    u.username = encodeURIComponent(user);
    u.password = encodeURIComponent(pass || '');
    return u.toString();
  } catch { return rtspUri; }
}

// ── ONVIF helpers ───────────────────────────────────────────────────────────
function onvifConnect({ host, onvifPort, username, password }) {
  return new Promise((resolve, reject) => {
    if (!onvif) return reject(new Error('onvif module not installed — run: npm install'));
    const cam = new onvif.Cam(
      { hostname: host, username, password, port: onvifPort || 80, timeout: 8000 },
      (err) => (err ? reject(err) : resolve(cam))
    );
  });
}
function getStreamUri(cam) {
  return new Promise((resolve, reject) => {
    cam.getStreamUri({ protocol: 'RTSP' }, (err, stream) =>
      err ? reject(err) : resolve(stream && stream.uri));
  });
}
async function resolveRtsp({ host, onvifPort, username, password }) {
  const cam = await onvifConnect({ host, onvifPort, username, password });
  const uri = await getStreamUri(cam);
  if (!uri) throw new Error('ONVIF returned no stream URI');
  return withCreds(uri, username, password);
}

// ── Recorder supervision ────────────────────────────────────────────────────
const procs = {}; // id -> { child, startedAt }

function segmentArgs(cam) {
  const dateDir = path.join(RECORDINGS_DIR, cam.id, new Date().toISOString().slice(0, 10));
  fs.mkdirSync(dateDir, { recursive: true });
  const outPattern = path.join(dateDir, '%H-%M-%S.mp4');
  return [
    '-rtsp_transport', 'tcp',
    '-i', cam.rtsp,
    '-c:v', 'copy',
    '-c:a', 'aac',
    '-f', 'segment',
    '-segment_time', String(SEGMENT_SECS),
    '-segment_atclocktime', '1',
    '-segment_format', 'mp4',
    '-reset_timestamps', '1',
    '-strftime', '1',
    '-y', outPattern,
  ];
}

function startRecorder(cam) {
  if (!cam.enabled || !cam.rtsp) return;
  if (procs[cam.id] && !procs[cam.id].child.killed) return;
  const child = spawn(FFMPEG, segmentArgs(cam), { windowsHide: true });
  child.on('error', (e) => { log(`recorder error ${cam.id}: ${e.message}`); if (procs[cam.id]) procs[cam.id].dead = true; });
  child.on('exit', () => { if (procs[cam.id]) procs[cam.id].dead = true; });
  child.stderr.on('data', () => {}); // drain
  procs[cam.id] = { child, startedAt: Date.now(), dead: false };
  log(`recorder start ${cam.id}`);
}

function stopRecorder(id) {
  const p = procs[id];
  if (p && p.child && !p.child.killed) { try { p.child.kill('SIGTERM'); } catch {} }
  delete procs[id];
}

// Supervisor: (re)start any enabled camera whose ffmpeg is not running.
// Also rolls each recorder into the new day's folder (ffmpeg output pattern is fixed at spawn).
function supervise() {
  const today = new Date().toISOString().slice(0, 10);
  for (const cam of cameras) {
    if (!cam.enabled) { if (procs[cam.id]) stopRecorder(cam.id); continue; }
    const p = procs[cam.id];
    const needsRestart = !p || p.dead || p.child.killed;
    const dayRolled    = p && p.day && p.day !== today;
    if (needsRestart || dayRolled) {
      if (p) stopRecorder(cam.id);
      startRecorder(cam);
      if (procs[cam.id]) procs[cam.id].day = today;
    }
  }
}

function cleanup() {
  const cutoff = Date.now() - KEEP_DAYS * 86400000;
  for (const cam of cameras) {
    const camDir = path.join(RECORDINGS_DIR, cam.id);
    if (!fs.existsSync(camDir)) continue;
    for (const date of fs.readdirSync(camDir)) {
      const dDir = path.join(camDir, date);
      let stat; try { stat = fs.statSync(dDir); } catch { continue; }
      if (!stat.isDirectory()) continue;
      for (const f of fs.readdirSync(dDir)) {
        const fp = path.join(dDir, f);
        try { if (fs.statSync(fp).mtimeMs < cutoff) fs.unlinkSync(fp); } catch {}
      }
      try { if (fs.readdirSync(dDir).length === 0) fs.rmdirSync(dDir); } catch {}
    }
  }
}

function log(msg) { console.log(`${new Date().toISOString()} ${msg}`); }

// ── HTTP API ────────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Range, X-Camera-Token');
  res.header('Access-Control-Expose-Headers', 'Content-Range, Accept-Ranges, Content-Length');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});
// Token auth for everything except /health
app.use((req, res, next) => {
  if (req.path === '/health') return next();
  if (!CAMERA_TOKEN) return next(); // dev mode
  const provided = req.headers['x-camera-token'] || req.query.token;
  if (provided !== CAMERA_TOKEN) return res.status(403).json({ error: 'Forbidden' });
  next();
});

app.get('/health', (_, res) => res.json({ ok: true }));

// ---- Camera management ----
function publicCam(c) {
  const p = procs[c.id];
  return {
    id: c.id, name: c.name, host: c.host, onvifPort: c.onvifPort,
    enabled: c.enabled, hasRtsp: !!c.rtsp,
    recording: !!(p && !p.dead && p.child && !p.child.killed),
  };
}

app.get('/cameras', (_, res) => res.json(cameras.map(publicCam)));

// Discover cameras on the LAN via ONVIF WS-Discovery
app.post('/cameras/discover', (_, res) => {
  if (!onvif) return res.status(500).json({ error: 'onvif module not installed' });
  const found = [];
  const done = () => res.json(found);
  try {
    onvif.Discovery.on('device', (cam) => {
      const h = (cam && (cam.hostname || (cam.xaddrs && cam.xaddrs[0] && cam.xaddrs[0].hostname)));
      if (h && !found.some(f => f.host === h)) found.push({ host: h, onvifPort: cam.port || 80 });
    });
    onvif.Discovery.probe({ timeout: 5000 }, () => {});
    setTimeout(done, 5200);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Add a camera. Two ways:
//   A) direct RTSP  — body.rtsp given → used as-is (no ONVIF needed; best for CP Plus/Dahua/Hik)
//   B) ONVIF        — body.host + creds → RTSP auto-pulled via ONVIF
app.post('/cameras', async (req, res) => {
  const { name, host, onvifPort, username, password, rtsp: rtspIn } = req.body || {};
  if (!host && !rtspIn) return res.status(400).json({ error: 'Provide an RTSP URL or a camera IP.' });

  let rtsp = (rtspIn || '').trim();
  if (rtsp) {
    if (!/^rtsp:\/\//i.test(rtsp)) return res.status(400).json({ error: 'RTSP URL must start with rtsp://' });
  } else {
    try {
      rtsp = await resolveRtsp({ host, onvifPort: onvifPort || 80, username, password });
    } catch (e) {
      return res.status(502).json({ error: `ONVIF connect failed: ${e.message}. Tip: add by RTSP URL instead.` });
    }
  }

  // Derive host for display if only an RTSP URL was given
  let displayHost = host;
  if (!displayHost) { try { displayHost = new URL(rtsp).hostname; } catch { displayHost = 'rtsp'; } }

  const cam = {
    id: makeId(name || displayHost), name: name || displayHost, host: displayHost,
    onvifPort: onvifPort || 80, username: username || '', password: password || '',
    rtsp, enabled: true,
  };
  cameras.push(cam);
  saveCameras(cameras);
  startRecorder(cam);
  res.json({ ok: true, camera: publicCam(cam) });
});

// Re-fetch RTSP via ONVIF (use after an IP change)
app.post('/cameras/:id/refresh', async (req, res) => {
  const cam = cameras.find(c => c.id === req.params.id);
  if (!cam) return res.status(404).json({ error: 'not found' });
  try {
    cam.rtsp = await resolveRtsp(cam);
    saveCameras(cameras);
    stopRecorder(cam.id); startRecorder(cam);
    res.json({ ok: true, camera: publicCam(cam) });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// Enable/disable recording without deleting
app.post('/cameras/:id/toggle', (req, res) => {
  const cam = cameras.find(c => c.id === req.params.id);
  if (!cam) return res.status(404).json({ error: 'not found' });
  cam.enabled = !cam.enabled;
  saveCameras(cameras);
  if (cam.enabled) startRecorder(cam); else stopRecorder(cam.id);
  res.json({ ok: true, camera: publicCam(cam) });
});

// Delete a camera from config (keeps its recorded footage on disk)
app.delete('/cameras/:id', (req, res) => {
  const idx = cameras.findIndex(c => c.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'not found' });
  stopRecorder(req.params.id);
  const [removed] = cameras.splice(idx, 1);
  saveCameras(cameras);
  res.json({ ok: true, removed: removed.id, note: 'Recorded footage kept on disk.' });
});

// ---- Recordings browser (unchanged API — frontend-compatible) ----
app.get('/recordings', (_, res) => {
  if (!fs.existsSync(RECORDINGS_DIR)) return res.json([]);
  res.json(fs.readdirSync(RECORDINGS_DIR)
    .filter(f => { try { return fs.statSync(path.join(RECORDINGS_DIR, f)).isDirectory(); } catch { return false; } }));
});
app.get('/recordings/:camera', (req, res) => {
  const dir = path.join(RECORDINGS_DIR, req.params.camera);
  if (!fs.existsSync(dir)) return res.json([]);
  res.json(fs.readdirSync(dir)
    .filter(f => { try { return fs.statSync(path.join(dir, f)).isDirectory(); } catch { return false; } })
    .sort().reverse());
});
app.get('/recordings/:camera/:date', (req, res) => {
  const dir = path.join(RECORDINGS_DIR, req.params.camera, req.params.date);
  if (!fs.existsSync(dir)) return res.json([]);
  res.json(fs.readdirSync(dir).filter(f => f.endsWith('.mp4')).sort().map(f => {
    const stat = fs.statSync(path.join(dir, f));
    return { name: f, size: stat.size, time: f.replace('.mp4', '').replace(/-/g, ':') };
  }));
});
app.get('/recordings/:camera/:date/:file', (req, res) => {
  const filePath = path.join(RECORDINGS_DIR, req.params.camera, req.params.date, req.params.file);
  if (!filePath.startsWith(RECORDINGS_DIR)) return res.status(400).send('Bad path');
  if (!fs.existsSync(filePath)) return res.status(404).send('Not found');
  const fileSize = fs.statSync(filePath).size;
  const range = req.headers.range;
  if (range) {
    const [s, e] = range.replace(/bytes=/, '').split('-');
    const start = parseInt(s, 10), end = e ? parseInt(e, 10) : fileSize - 1;
    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1, 'Content-Type': 'video/mp4',
    });
    fs.createReadStream(filePath, { start, end }).pipe(res);
  } else {
    res.writeHead(200, { 'Content-Length': fileSize, 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes' });
    fs.createReadStream(filePath).pipe(res);
  }
});

// Best-effort: re-pull each camera's RTSP via ONVIF (self-heals IP / URL changes).
// Never throws — on failure we keep whatever RTSP is already stored.
async function refreshAllViaOnvif() {
  for (const cam of cameras) {
    if (!cam.enabled || !cam.host || !cam.username) continue;
    try {
      const uri = await resolveRtsp(cam);
      if (uri && uri !== cam.rtsp) { cam.rtsp = uri; log(`onvif refreshed ${cam.id} -> ${uri.replace(/:[^:@/]*@/, ':***@')}`); }
    } catch (e) { log(`onvif refresh skipped ${cam.id}: ${e.message}`); }
  }
  saveCameras(cameras);
}

// ── Boot ────────────────────────────────────────────────────────────────────
fs.mkdirSync(RECORDINGS_DIR, { recursive: true });
cleanup();
refreshAllViaOnvif().finally(supervise); // refresh URLs first, then start recorders
setInterval(supervise, 30000);      // restart crashed recorders + daily folder roll
setInterval(cleanup, 6 * 3600000);  // prune old footage every 6h

app.listen(PORT, () => log(`Camera Manager on :${PORT} (recordings: ${RECORDINGS_DIR}, ffmpeg: ${FFMPEG})`));

process.on('SIGINT',  () => { Object.keys(procs).forEach(stopRecorder); process.exit(0); });
process.on('SIGTERM', () => { Object.keys(procs).forEach(stopRecorder); process.exit(0); });
