import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  base: '/fitness/',
  server: {
    host: true,
    port: 5176,
  },
})
