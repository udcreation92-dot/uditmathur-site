const express = require('express');
const axios = require('axios');
const crypto = require('crypto');

const app = express();
app.use(express.json());

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

const CAMERAS = {
  camera_01: { ip: '192.168.1.10', port: 8000, user: 'admin', pass: 'onlineudit' },
  camera_02: { ip: '192.168.1.26', port: 8000, user: 'admin', pass: 'onlineudit' },
};

const profileTokenCache = {};
const patrolTimers = {};

function wsseHeader(user, pass) {
  const nonce = crypto.randomBytes(16);
  const created = new Date().toISOString();
  const digest = crypto.createHash('sha1')
    .update(Buffer.concat([nonce, Buffer.from(created), Buffer.from(pass)]))
    .digest('base64');
  return `<wsse:Security xmlns:wsse="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd">
    <wsse:UsernameToken>
      <wsse:Username>${user}</wsse:Username>
      <wsse:Password Type="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordDigest">${digest}</wsse:Password>
      <wsse:Nonce EncodingType="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-soap-message-security-1.0#Base64Binary">${nonce.toString('base64')}</wsse:Nonce>
      <wsu:Created xmlns:wsu="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd">${created}</wsu:Created>
    </wsse:UsernameToken>
  </wsse:Security>`;
}

function soap(security, body) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope"
  xmlns:tptz="http://www.onvif.org/ver20/ptz/wsdl"
  xmlns:trt="http://www.onvif.org/ver10/media/wsdl"
  xmlns:tt="http://www.onvif.org/ver10/schema">
  <s:Header>${security}</s:Header>
  <s:Body>${body}</s:Body>
</s:Envelope>`;
}

async function onvif(cam, service, body) {
  const serviceMap = {
    device: 'device_service',
    media: 'media_service',
    ptz: 'ptz_service',
  };
  const url = `http://${cam.ip}:${cam.port}/onvif/${serviceMap[service]}`;
  const envelope = soap(wsseHeader(cam.user, cam.pass), body);
  const resp = await axios.post(url, envelope, {
    headers: { 'Content-Type': 'application/soap+xml; charset=utf-8' },
    timeout: 6000,
  });
  return resp.data;
}

async function getProfileToken(camId) {
  if (profileTokenCache[camId]) return profileTokenCache[camId];
  const cam = CAMERAS[camId];
  const resp = await onvif(cam, 'media', `<trt:GetProfiles/>`);
  const match = resp.match(/Profiles[^>]*token="([^"]+)"/);
  if (!match) throw new Error('No profile token found');
  profileTokenCache[camId] = match[1];
  return match[1];
}

// ── Move (continuous) ──────────────────────────────────────────────────────
app.post('/ptz/:camId/move', async (req, res) => {
  try {
    const cam = CAMERAS[req.params.camId];
    if (!cam) return res.status(404).json({ error: 'Camera not found' });
    const { pan = 0, tilt = 0, zoom = 0 } = req.body;
    const token = await getProfileToken(req.params.camId);
    await onvif(cam, 'ptz', `
      <tptz:ContinuousMove>
        <tptz:ProfileToken>${token}</tptz:ProfileToken>
        <tptz:Velocity>
          <tt:PanTilt x="${pan}" y="${tilt}"/>
          <tt:Zoom x="${zoom}"/>
        </tptz:Velocity>
      </tptz:ContinuousMove>`);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Stop ───────────────────────────────────────────────────────────────────
app.post('/ptz/:camId/stop', async (req, res) => {
  try {
    const cam = CAMERAS[req.params.camId];
    if (!cam) return res.status(404).json({ error: 'Camera not found' });
    const token = await getProfileToken(req.params.camId);
    await onvif(cam, 'ptz', `
      <tptz:Stop>
        <tptz:ProfileToken>${token}</tptz:ProfileToken>
        <tptz:PanTilt>true</tptz:PanTilt>
        <tptz:Zoom>true</tptz:Zoom>
      </tptz:Stop>`);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Get presets ────────────────────────────────────────────────────────────
app.get('/ptz/:camId/presets', async (req, res) => {
  try {
    const cam = CAMERAS[req.params.camId];
    if (!cam) return res.status(404).json({ error: 'Camera not found' });
    const token = await getProfileToken(req.params.camId);
    const resp = await onvif(cam, 'ptz', `
      <tptz:GetPresets>
        <tptz:ProfileToken>${token}</tptz:ProfileToken>
      </tptz:GetPresets>`);
    const presets = [];
    const re = /Preset[^>]*token="([^"]+)"[^]*?<tt:Name>([^<]+)<\/tt:Name>/g;
    let m;
    while ((m = re.exec(resp))) presets.push({ token: m[1], name: m[2] });
    res.json(presets);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Go to preset ───────────────────────────────────────────────────────────
app.post('/ptz/:camId/goto', async (req, res) => {
  try {
    const cam = CAMERAS[req.params.camId];
    if (!cam) return res.status(404).json({ error: 'Camera not found' });
    const { presetToken } = req.body;
    const token = await getProfileToken(req.params.camId);
    await onvif(cam, 'ptz', `
      <tptz:GotoPreset>
        <tptz:ProfileToken>${token}</tptz:ProfileToken>
        <tptz:PresetToken>${presetToken}</tptz:PresetToken>
      </tptz:GotoPreset>`);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Patrol start ───────────────────────────────────────────────────────────
app.post('/ptz/:camId/patrol/start', async (req, res) => {
  try {
    const { camId } = req.params;
    const cam = CAMERAS[camId];
    if (!cam) return res.status(404).json({ error: 'Camera not found' });
    const { interval = 10 } = req.body;

    if (patrolTimers[camId]) clearInterval(patrolTimers[camId]);

    const token = await getProfileToken(camId);
    const resp = await onvif(cam, 'ptz', `<tptz:GetPresets><tptz:ProfileToken>${token}</tptz:ProfileToken></tptz:GetPresets>`);
    const presets = [];
    const re = /Preset[^>]*token="([^"]+)"/g;
    let m;
    while ((m = re.exec(resp))) presets.push(m[1]);

    if (presets.length === 0) return res.status(400).json({ error: 'No presets saved on camera. Use camera app to save presets first.' });

    let idx = 0;
    const visit = async () => {
      const pt = presets[idx % presets.length];
      idx++;
      await onvif(cam, 'ptz', `<tptz:GotoPreset><tptz:ProfileToken>${token}</tptz:ProfileToken><tptz:PresetToken>${pt}</tptz:PresetToken></tptz:GotoPreset>`).catch(() => {});
    };

    await visit();
    patrolTimers[camId] = setInterval(visit, interval * 1000);
    res.json({ ok: true, presets: presets.length, interval });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Patrol stop ────────────────────────────────────────────────────────────
app.post('/ptz/:camId/patrol/stop', (req, res) => {
  const { camId } = req.params;
  if (patrolTimers[camId]) { clearInterval(patrolTimers[camId]); delete patrolTimers[camId]; }
  res.json({ ok: true });
});

app.get('/patrol/status', (req, res) => {
  const status = {};
  Object.keys(CAMERAS).forEach(id => { status[id] = !!patrolTimers[id]; });
  res.json(status);
});

app.get('/health', (_, res) => res.json({ ok: true }));

app.listen(8080, () => console.log('PTZ proxy running on :8080'));
