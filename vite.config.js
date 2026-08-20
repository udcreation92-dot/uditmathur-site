import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'

export default defineConfig({
  plugins: [react()],
  base: '/task/',
  build: {
    rollupOptions: {
      input: {
        task: resolve(__dirname, 'task.html'),
        trading: resolve(__dirname, 'trading.html'),
      },
    }
  }
})
