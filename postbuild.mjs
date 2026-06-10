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

// ── 5. Write _redirects ───────────────────────────────────────────────────────
// No wildcard SPA rewrites — the actual index.html files exist at their paths,
// so Cloudflare serves them directly. Wildcard rules caused infinite-loop errors.
fs.writeFileSync(path.resolve('dist/_redirects'), '')
console.log('✓ dist/_redirects written (empty)')

console.log('\n✅ Combined build complete → dist/')
