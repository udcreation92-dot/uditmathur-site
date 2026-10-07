// Cloudflare Worker — multi-SPA routing + site login (ID + password)
//
// Every app on the landing page except Fitness sits behind one shared login.
// Secrets (set in Cloudflare → Worker → Settings → Variables, as secrets):
//   SITE_USER, SITE_PASSWORD  — the login ID and password
//   CAMERA_TOKEN              — still injected into the cameras app for the recordings server
// Requires `run_worker_first = true` in wrangler.toml, otherwise static files
// are served straight from the asset store and never reach this gate.

const SESSION_COOKIE = 'site_session'

// Path prefixes that require login. Fitness (/fitness) and the landing page stay public.
const PROTECTED = ['/task', '/accounts', '/cameras', '/money-market', '/trading', '/go']

// Tiles that live off-site (PC over Tailscale) — reached via a gated redirect so
// the address isn't exposed on the public landing page.
const EXTERNAL = {
  '/go/trading': 'http://100.86.73.74:4173/task/trading.html',
  '/go/news':    'http://100.86.73.74:4173/task/news.html',
}

const APP_NAMES = {
  '/task': 'Tasks', '/accounts': 'Accounts', '/cameras': 'Cameras',
  '/money-market': 'Money Market', '/trading': 'Trading',
  '/go/trading': 'Trading', '/go/news': 'News Coverage',
}

function parseCookie(cookieHeader, name) {
  for (const part of (cookieHeader || '').split(';')) {
    const eq = part.indexOf('=')
    if (eq === -1) continue
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim()
  }
  return null
}

function isProtected(path) {
  return PROTECTED.some(p => path === p || path.startsWith(p + '/'))
}

function appName(path) {
  const key = Object.keys(APP_NAMES)
    .sort((a, b) => b.length - a.length)
    .find(p => path === p || path.startsWith(p + '/'))
  return key ? APP_NAMES[key] : 'uditmathur.uk'
}

// Only allow same-site relative redirects after login
function safeRedirect(r) {
  return typeof r === 'string' && r.startsWith('/') && !r.startsWith('//') ? r : '/'
}

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('')
}

// Session token derived from the credentials — changing the password logs everyone out.
function sessionToken(env) {
  return sha256Hex(`site-session:v1:${env.SITE_USER}:${env.SITE_PASSWORD}`)
}

async function safeEqual(a, b) {
  const [ha, hb] = await Promise.all([sha256Hex(a), sha256Hex(b)])
  let diff = 0
  for (let i = 0; i < ha.length; i++) diff |= ha.charCodeAt(i) ^ hb.charCodeAt(i)
  return diff === 0
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}

function htmlResponse(html, status = 200) {
  return new Response(html, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  })
}

function loginPage(redirectTo, { error = '', user = '' } = {}) {
  const name = appName(redirectTo)
  return htmlResponse(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(name)} — Sign in</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0f172a;
           color: #f1f5f9; display: flex; align-items: center; justify-content: center;
           min-height: 100dvh; padding: 1rem; }
    .box { background: #1e293b; border-radius: 1.25rem; padding: 2rem; width: 100%; max-width: 340px; }
    h1 { font-size: 1.25rem; font-weight: 600; margin-bottom: 0.25rem; }
    .sub { font-size: 0.8rem; color: #64748b; margin-bottom: 1.5rem; }
    label { font-size: 0.75rem; color: #94a3b8; display: block; margin-bottom: 4px; }
    input { width: 100%; padding: 10px 12px; border-radius: 8px; border: 1px solid #334155;
            background: #0f172a; color: #f1f5f9; font-size: 1rem; margin-bottom: 1rem; outline: none; }
    input:focus { border-color: #818cf8; }
    button { width: 100%; padding: 11px; border-radius: 8px; border: none; background: #6366f1;
             color: #fff; font-size: 0.95rem; cursor: pointer; font-weight: 600; }
    button:hover { background: #4f46e5; }
    .error { color: #fca5a5; font-size: 0.8rem; margin-bottom: 1rem; background: #450a0a;
             border: 1px solid #7f1d1d; border-radius: 8px; padding: 8px 10px; }
    a { display: block; text-align: center; margin-top: 1.25rem; font-size: 0.8rem; color: #64748b; text-decoration: none; }
  </style>
</head>
<body>
  <div class="box">
    <h1>🔒 ${escapeHtml(name)}</h1>
    <p class="sub">Sign in to continue</p>
    ${error ? `<p class="error">${escapeHtml(error)}</p>` : ''}
    <form method="POST" action="/login">
      <input type="hidden" name="redirect" value="${escapeHtml(redirectTo)}">
      <label for="u">ID</label>
      <input id="u" name="username" value="${escapeHtml(user)}" autocomplete="username" autocapitalize="none" ${user ? '' : 'autofocus'} required>
      <label for="p">Password</label>
      <input id="p" type="password" name="password" autocomplete="current-password" ${user ? 'autofocus' : ''} required>
      <button type="submit">Sign in</button>
    </form>
    <a href="/">← Back to home</a>
  </div>
</body>
</html>`, error ? 401 : 200)
}

function notConfigured() {
  return htmlResponse('<!DOCTYPE html><meta charset="utf-8"><body style="font-family:sans-serif;background:#0f172a;color:#f1f5f9;padding:2rem">Login is not configured (SITE_USER / SITE_PASSWORD secrets missing).</body>', 503)
}

async function handleLogin(request, env) {
  const body     = await request.formData()
  const user     = String(body.get('username') || '')
  const password = String(body.get('password') || '')
  const redirect = safeRedirect(String(body.get('redirect') || '/'))

  const ok = (await safeEqual(user, env.SITE_USER)) & (await safeEqual(password, env.SITE_PASSWORD))
  if (!ok) return loginPage(redirect, { error: 'Incorrect ID or password — try again.', user })

  return new Response(null, {
    status: 302,
    headers: {
      Location: redirect,
      'Set-Cookie': `${SESSION_COOKIE}=${await sessionToken(env)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000`,
      'Cache-Control': 'no-store',
    },
  })
}

function handleLogout() {
  return new Response(null, {
    status: 302,
    headers: {
      Location: '/',
      'Set-Cookie': `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`,
      'Cache-Control': 'no-store',
    },
  })
}

// Serve an asset, falling back to the app's SPA shell on 404
async function serveApp(request, url, env, shell) {
  const r = await env.ASSETS.fetch(request)
  if (r.status !== 404 || !shell) return r
  return env.ASSETS.fetch(new Request(new URL(shell, url).href))
}

// Inject the camera recordings-server token into the cameras app HTML
async function injectCameraToken(resp, token) {
  const ct = resp.headers.get('Content-Type') || ''
  if (!token || !ct.includes('text/html')) return resp
  const html     = await resp.text()
  const injected = html.replace(
    '</head>',
    `<script>window.__CAMERA_TOKEN__=${JSON.stringify(token)}</script>\n</head>`,
  )
  const headers = new Headers(resp.headers)
  headers.set('Content-Type', 'text/html; charset=utf-8')
  headers.set('Cache-Control', 'no-store')
  headers.delete('Content-Length')
  return new Response(injected, { status: resp.status, headers })
}

const SHELLS = [
  ['/task', '/task/index.html'],
  ['/accounts', '/accounts/index.html'],
  ['/money-market', '/money-market/index.html'],
  ['/cameras', '/cameras/index.html'],
  ['/fitness', '/fitness/index.html'],
]

export default {
  async fetch(request, env) {
    const url  = new URL(request.url)
    const path = url.pathname

    if (path === '/login') {
      if (!env.SITE_USER || !env.SITE_PASSWORD) return notConfigured()
      if (request.method === 'POST') return handleLogin(request, env)
      return loginPage(safeRedirect(url.searchParams.get('next') || '/'))
    }
    if (path === '/logout') return handleLogout()

    // Login gate for every tile except Fitness
    if (isProtected(path)) {
      if (!env.SITE_USER || !env.SITE_PASSWORD) return notConfigured()
      const cookie = parseCookie(request.headers.get('Cookie'), SESSION_COOKIE)
      if (!cookie || !(await safeEqual(cookie, await sessionToken(env)))) {
        // Sub-resources (JS/CSS/API) get a plain 401; page loads get the login form
        const wantsHtml = (request.headers.get('Accept') || '').includes('text/html')
        return wantsHtml
          ? loginPage(path + url.search)
          : new Response('Unauthorized', { status: 401, headers: { 'Cache-Control': 'no-store' } })
      }
      if (EXTERNAL[path]) return Response.redirect(EXTERNAL[path], 302)
    }

    for (const [prefix, shell] of SHELLS) {
      if (path === prefix || path.startsWith(prefix + '/')) {
        const resp = await serveApp(request, url, env, shell)
        if (prefix === '/cameras') return injectCameraToken(resp, env.CAMERA_TOKEN)
        if (prefix === '/fitness') return resp
        // Logged-in app pages must not be cached by shared caches
        const headers = new Headers(resp.headers)
        headers.set('Cache-Control', (headers.get('Content-Type') || '').includes('text/html')
          ? 'private, no-store' : 'private, max-age=0, must-revalidate')
        return new Response(resp.body, { status: resp.status, headers })
      }
    }

    // Other exact static assets (landing page files, root sw.js, manifest …)
    const assetResp = await env.ASSETS.fetch(request)
    if (assetResp.status !== 404) return assetResp

    // Everything else → landing page
    return env.ASSETS.fetch(new Request(new URL('/index.html', url).href))
  },
}
