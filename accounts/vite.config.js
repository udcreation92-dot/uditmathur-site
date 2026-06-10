import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  base: '/accounts/',
  server: {
    host: true,   // listen on 0.0.0.0 so mobile on same WiFi can connect
    port: 5173,
  },
})
