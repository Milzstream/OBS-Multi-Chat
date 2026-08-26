import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': 'http://localhost:4173',
      '/events': 'http://localhost:4173',
      '/oauth': 'http://localhost:4173',
    },
  },
})
