// Cloudflare Worker — multi-SPA routing
// Serves exact assets first; falls back to the correct SPA index.html
// so that React Router deep links and direct URL loads work correctly.

export default {
  async fetch(request, env) {
    const url  = new URL(request.url)
    const path = url.pathname

    // 1. Try to serve the request as an exact static asset (JS, CSS, images …).
    //    Pass the original request so that Accept-Encoding and other headers are preserved.
    const assetResp = await env.STATIC.fetch(request)
    if (assetResp.status !== 404) return assetResp

    // 2. Task app — serve its SPA shell for all paths under /task
    if (path === '/task' || path.startsWith('/task/')) {
      return env.STATIC.fetch(new Request(new URL('/task/index.html', url).href))
    }

    // 3. Accounts app — serve its SPA shell for all paths under /accounts
    if (path === '/accounts' || path.startsWith('/accounts/')) {
      return env.STATIC.fetch(new Request(new URL('/accounts/index.html', url).href))
    }

    // 4. Everything else (including /cameras/) → landing page
    return env.STATIC.fetch(new Request(new URL('/index.html', url).href))
  },
}
