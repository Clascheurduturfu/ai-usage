import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import tailwind from '@tailwindcss/vite'

const server = await createServer({ configFile: false, root: 'src/renderer', plugins: [react(), tailwind()],
  server: { host: '127.0.0.1', port: 5179, strictPort: true } })
await server.listen()
console.log('UI preview: http://127.0.0.1:5179/?demo (fictional data, no provider requests)')
const stop = async () => { await server.close(); process.exit(0) }
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
