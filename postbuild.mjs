import fs   from 'fs'
import path from 'path'
import { execSync } from 'child_process'

const root = path.resolve('.')

// ── 1. Move dist/task.html → dist/task/index.html ────────────────────────────
//    Also move dist/assets/* → dist/task/assets/* so the /task/ base path works
const taskDir = path.resolve('dist/task')
if (!fs.existsSync(taskDir)) fs.mkdirSync(taskDir, { recursive: true })
if (fs.existsSync(path.resolve('dist/task.html'))) {
  fs.renameSync(path.resolve('dist/task.html'), path.resolve('dist/task/index.html'))
  console.log('✓ dist/task.html → dist/task/index.html')
}
// Move assets into dist/task/assets so /task/assets/... paths resolve
const srcAssets  = path.resolve('dist/assets')
const destAssets = path.resolve('dist/task/assets')
if (fs.existsSync(srcAssets)) {
  fs.mkdirSync(destAssets, { recursive: true })
  for (const f of fs.readdirSync(srcAssets)) {
    fs.renameSync(path.join(srcAssets, f), path.join(destAssets, f))
  }
  fs.rmdirSync(srcAssets)
  console.log('✓ dist/assets → dist/task/assets')
}

// ── 2. Copy landing page → dist/index.html ───────────────────────────────────
fs.copyFileSync(path.resolve('landing.html'), path.resolve('dist/index.html'))
console.log('✓ Landing page → dist/index.html')

// ── 3. Build accounts app ─────────────────────────────────────────────────────
console.log('\nInstalling accounts dependencies…')
execSync('npm install', {
  cwd: path.resolve('accounts'),
  stdio: 'inherit',
})
console.log('\nBuilding accounts app…')
execSync('npm run build', {
  cwd: path.resolve('accounts'),
  stdio: 'inherit',
})

// ── 4. Copy accounts/dist → dist/accounts ────────────────────────────────────
function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true })
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name)
    const d = path.join(dest, entry.name)
    if (entry.isDirectory()) copyDir(s, d)
    else fs.copyFileSync(s, d)
  }
}
copyDir(path.resolve('accounts/dist'), path.resolve('dist/accounts'))
console.log('✓ accounts/dist → dist/accounts')

// ── 5. Copy _worker.js into dist/ for Cloudflare Pages advanced mode ─────────
// Pages looks for _worker.js inside the output directory, not the repo root.
// It automatically provides env.ASSETS to the worker (no wrangler.toml binding needed).
fs.copyFileSync(path.resolve('_worker.js'), path.resolve('dist/_worker.js'))
console.log('✓ _worker.js → dist/_worker.js')

// ── 6. Remove ALL _redirects files anywhere in dist/ ─────────────────────────
// Custom worker handles all routing so _redirects rules are not needed.
function deleteRedirectsFiles(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) deleteRedirectsFiles(fullPath)
    else if (entry.name === '_redirects') { fs.unlinkSync(fullPath); console.log(`✓ Removed ${fullPath}`) }
  }
}
deleteRedirectsFiles(path.resolve('dist'))

// Debug: list all files in dist so we can verify in CI logs
function listFiles(dir, indent = '') {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) listFiles(fullPath, indent + '  ')
    else console.log(indent + fullPath.replace(path.resolve('dist'), 'dist'))
  }
}
console.log('\n📦 Final dist contents:')
listFiles(path.resolve('dist'))
console.log('\n✅ Combined build complete → dist/')
