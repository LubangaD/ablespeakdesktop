import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// The gateway the dev server talks to; ABLESPEAK_API points it at another
// one (for example a copy running on a test database).
const gateway = process.env.ABLESPEAK_API || 'http://localhost:3001'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': gateway,
      '/ws': {
        target: gateway.replace(/^http/, 'ws'),
        ws: true
      }
    }
  }
})
