import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { resolve } from 'node:path'

export default defineConfig({
  root: 'src/renderer',
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@renderer': resolve('src/renderer/src'), '@shared': resolve('src/shared') } },
  server: { host: '127.0.0.1', port: 5179, strictPort: true },
  build: { outDir: resolve('out/frontend'), emptyOutDir: true, chunkSizeWarningLimit: 1000 }
})
