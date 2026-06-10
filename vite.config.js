import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'

export default defineConfig({
  plugins: [react()],
  base: '/task/',
  build: {
    rollupOptions: {
      input: resolve(__dirname, 'task.html'),
    }
  }
})
