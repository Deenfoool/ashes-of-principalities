import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocketServer, WebSocket } from 'ws'

const root = fileURLToPath(new URL('..', import.meta.url))
const serveDist = process.argv.includes('--serve-dist')
const port = Number(process.env.PORT || (serveDist ? 3000 : 3001))
const allowedChannels = new Set(['general', 'trade', 'guild'])
const messages = []

const seed = (channel, author, text) => ({
  id: crypto.randomUUID(),
  channel,
  author,
  text,
  timestamp: Date.now(),
  system: author === 'Летописец',
})

messages.push(
  seed('general', 'Летописец', 'Серверный костёр разожжён. Путники могут говорить.'),
  seed('trade', 'Летописец', 'Торговый канал открыт. Сделки пока не защищены системой.'),
  seed('guild', 'Летописец', 'Гильдейский канал станет закрытым после появления авторизации.'),
)

const contentTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json',
}

async function serveStatic(request, response) {
  if (!serveDist) {
    response.writeHead(404).end('Not found')
    return
  }

  const url = new URL(request.url ?? '/', `http://${request.headers.host}`)
  const requested = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '')
  const safePath = normalize(requested)
  if (safePath.startsWith('..') || safePath.includes('\u0000')) {
    response.writeHead(400).end('Bad request')
    return
  }
  let filePath = join(root, 'dist', safePath)

  try {
    const info = await stat(filePath)
    if (info.isDirectory()) filePath = join(filePath, 'index.html')
    const body = await readFile(filePath)
    const shouldRevalidate = filePath.endsWith('index.html') || filePath.endsWith('sw.js') || filePath.endsWith('manifest.webmanifest')
    response.writeHead(200, {
      'Content-Type': contentTypes[extname(filePath)] ?? 'application/octet-stream',
      'Cache-Control': shouldRevalidate ? 'no-cache' : 'public, max-age=31536000, immutable',
    })
    response.end(body)
  } catch {
    try {
      const body = await readFile(join(root, 'dist', 'index.html'))
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' })
      response.end(body)
    } catch {
      response.writeHead(503).end('Build the client first: npm run build')
    }
  }
}

const server = createServer(async (request, response) => {
  if (request.url === '/api/health') {
    response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
    response.end(JSON.stringify({ ok: true, service: 'ashes-of-principalities', clients: wss.clients.size }))
    return
  }
  await serveStatic(request, response)
})

const wss = new WebSocketServer({ noServer: true })

server.on('upgrade', (request, socket, head) => {
  const url = new URL(request.url ?? '/', `http://${request.headers.host}`)
  if (url.pathname !== '/ws') {
    socket.destroy()
    return
  }
  wss.handleUpgrade(request, socket, head, (client) => wss.emit('connection', client, request))
})

wss.on('connection', (socket) => {
  socket.send(JSON.stringify({ type: 'history', messages: messages.slice(-80) }))

  socket.on('message', (raw) => {
    try {
      const payload = JSON.parse(raw.toString())
      const channel = String(payload.channel ?? '')
      const author = String(payload.author ?? 'Странник').trim().slice(0, 24) || 'Странник'
      const text = String(payload.text ?? '').trim().slice(0, 280)
      if (payload.type !== 'message' || !allowedChannels.has(channel) || !text) return

      const message = { id: crypto.randomUUID(), channel, author, text, timestamp: Date.now() }
      messages.push(message)
      if (messages.length > 200) messages.splice(0, messages.length - 200)

      const packet = JSON.stringify({ type: 'message', message })
      for (const client of wss.clients) {
        if (client.readyState === WebSocket.OPEN) client.send(packet)
      }
    } catch {
      // Invalid messages are ignored; the connection remains alive.
    }
  })
})

server.listen(port, '0.0.0.0', () => {
  console.log(`Ashes server listening on http://0.0.0.0:${port}`)
})
