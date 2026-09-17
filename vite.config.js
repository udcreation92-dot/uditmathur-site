import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'
import { existsSync } from 'fs'

// The Trading and News apps are LOCAL-ONLY: `src/trading/` and `src/news/` are gitignored (see
// .gitignore) and live only on the box. On CI those sources are absent, so Vite/Rollup would fail
// trying to bundle their entry modules. Include those entries ONLY when their source is present —
// the box builds all three (task + trading + news); CI builds just `task`, and the landing page +
// static apps deploy as before. (This is why CI had been failing since src/trading was gitignored.)
const input = { task: resolve(__dirname, 'task.html') }
if (existsSync(resolve(__dirname, 'src/trading/main.jsx'))) {
  input.trading = resolve(__dirname, 'trading.html')
}
if (existsSync(resolve(__dirname, 'src/news/main.jsx'))) {
  input.news = resolve(__dirname, 'news.html')
}

export default defineConfig({
  plugins: [react()],
  base: '/task/',
  build: {
    rollupOptions: { input },
  },
})
