// Cloudflare Worker — multi-SPA routing + camera authentication

const CAM_COOKIE = 'cam_session'

function parseCookie(cookieHeader, name) {
  for (const part of (cookieHeader || '').split(';')) {
    const eq = part.indexOf('=')
    if (eq === -1) continue
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim()
  }
  return null
}

function loginPage(redirectTo, showError) {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Camera Recordings — Sign in</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: system-ui, sans-serif; background: #0a0a0f; color: #e2e8f0;
           display: flex; align-items: center; justify-content: center; min-height: 100vh; }
    .box { background: #12121a; border: 1px solid #1e1e2e; border-radius: 12px;
           padding: 2rem; width: 320px; }
    h1 { font-size: 1rem; font-weight: 600; letter-spacing: 0.05em; text-transform: uppercase;
         color: #5b8dee; margin-bottom: 1.5rem; }
    label { font-size: 0.75rem; color: #64748b; display: block; margin-bottom: 4px; }
    input[type=password] { width: 100%; padding: 8px 12px; border-radius: 6px;
                           border: 1px solid #1e1e2e; background: #0a0a0f; color: #e2e8f0;
                           font-size: 0.9rem; margin-bottom: 1rem; outline: none; }
    input[type=password]:focus { border-color: #5b8dee; }
    button { width: 100%; padding: 10px; border-radius: 6px; border: none;
             background: #5b8dee; color: #fff; font-size: 0.9rem; cursor: pointer; font-weight: 500; }
    button:hover { background: #4a7de0; }
    .error { color: #ef4444; font-size: 0.8rem; margin-bottom: 1rem;
             background: #1a0000; border: 1px solid #3d0000; border-radius: 6px; padding: 8px 10px; }
  </style>
</head>
<body>
  <div class="box">
    <h1>&#9679; Camera Recordings</h1>
    ${showError ? '<p class="error">Incorrect password — try again.</p>' : ''}
    <form method="POST" action="/cameras/login">
      <input type="hidden" name="redirect" value="${redirectTo}">
      <label>Password</label>
      <input type="password" name="password" autofocus autocomplete="current-password">
      <button type="submit">Sign in</button>
    </form>
  </div>
</body>
</html>`
  return new Response(html, {
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  })
}

async function handleCameras(request, url, env) {
  const path     = url.pathname
  const password = env.CAMERA_PASSWORD
  const token    = env.CAMERA_TOKEN

  // No password configured — serve without auth gate (useful during local dev)
  if (!password || !token) {
    const r = await env.ASSETS.fetch(request)
    if (r.status !== 404) return r
    return env.ASSETS.fetch(new Request(new URL('/cameras/index.html', url).href))
  }

  // Handle login form POST
  if (path === '/cameras/login' && request.method === 'POST') {
    const body      = await request.formData()
    const submitted = body.get('password') || ''
    const redirect  = body.get('redirect') || '/cameras/'
    if (submitted === password) {
      return new Response(null, {
        status: 302,
        headers: {
          Location: redirect,
          'Set-Cookie': `${CAM_COOKIE}=${token}; Path=/cameras; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000`,
        },
      })
    }
    return loginPage(redirect, true)
  }

  // Validate session cookie
  const sessionToken = parseCookie(request.headers.get('Cookie'), CAM_COOKIE)
  if (sessionToken !== token) {
    return loginPage(path + url.search, false)
  }

  // Authenticated — fetch the camera asset
  const assetResp = await env.ASSETS.fetch(request)
  const served    = assetResp.status !== 404
    ? assetResp
    : await env.ASSETS.fetch(new Request(new URL('/cameras/index.html', url).href))

  // Inject the shared token into HTML so the app can auth to the recordings server
  const ct = served.headers.get('Content-Type') || ''
  if (!ct.includes('text/html')) return served

  const html     = await served.text()
  const injected = html.replace(
    '</head>',
    `<script>window.__CAMERA_TOKEN__=${JSON.stringify(token)}</script>\n</head>`,
  )
  const headers = new Headers(served.headers)
  headers.set('Content-Type', 'text/html; charset=utf-8')
  headers.set('Cache-Control', 'no-store')
  headers.delete('Content-Length')
  return new Response(injected, { status: served.status, headers })
}

export default {
  async fetch(request, env) {
    const url  = new URL(request.url)
    const path = url.pathname

    // Camera auth gate — must run before generic asset serving
    if (path === '/cameras' || path.startsWith('/cameras/')) {
      return handleCameras(request, url, env)
    }

    // Try to serve the request as an exact static asset (JS, CSS, images …)
    const assetResp = await env.ASSETS.fetch(request)
    if (assetResp.status !== 404) return assetResp

    // Task app SPA shell
    if (path === '/task' || path.startsWith('/task/')) {
      return env.ASSETS.fetch(new Request(new URL('/task/index.html', url).href))
    }

    // Accounts app SPA shell
    if (path === '/accounts' || path.startsWith('/accounts/')) {
      return env.ASSETS.fetch(new Request(new URL('/accounts/index.html', url).href))
    }

    // Everything else → landing page
    return env.ASSETS.fetch(new Request(new URL('/index.html', url).href))
  },
}
