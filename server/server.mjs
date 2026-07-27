import { createServer } from 'node:http'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocketServer, WebSocket } from 'ws'
import { canReceive, createChatMessage, parsePacket, visibleHistory } from './protocol.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const serveDist = process.argv.includes('--serve-dist')
const port = Number(process.env.PORT || (serveDist ? 3000 : 3001))
const dataDirectory = join(root, 'data')
const chatFile = join(dataDirectory, 'chat.json')
const messages = []
const sessions = new WeakMap()
let persistQueue = Promise.resolve()

const systemMessage = (channel, text, guildId = null) => createChatMessage({
  channel,
  author: 'Летописец',
  text,
  guildId,
  system: true,
})

async function loadChatHistory() {
  try {
    const raw = JSON.parse(await readFile(chatFile, 'utf8'))
    if (Array.isArray(raw)) {
      for (const message of raw.slice(-300)) {
        if (message && typeof message.id === 'string' && typeof message.text === 'string') messages.push(message)
      }
    }
  } catch {
    // A missing or damaged history file starts a new server chronicle.
  }

  if (messages.length === 0) {
    messages.push(
      systemMessage('general', 'Серверный костёр разожжён. Путники могут говорить.'),
      systemMessage('trade', 'Торговый канал открыт. Не подтверждённые системой сделки совершаются на свой риск.'),
    )
  }
}

function persistChatHistory() {
  const snapshot = JSON.stringify(messages.slice(-300), null, 2)
  persistQueue = persistQueue
    .then(() => mkdir(dataDirectory, { recursive: true }))
    .then(() => writeFile(chatFile, snapshot, 'utf8'))
    .catch((error) => console.error('Failed to persist chat history:', error))
}

await loadChatHistory()

const contentTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
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
    response.end(JSON.stringify({ ok: true, service: 'ashes-of-principalities', clients: wss.clients.size, messages: messages.length }))
    return
  }
  await serveStatic(request, response)
})

const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 })

server.on('upgrade', (request, socket, head) => {
  const url = new URL(request.url ?? '/', `http://${request.headers.host}`)
  if (url.pathname !== '/ws') {
    socket.destroy()
    return
  }
  wss.handleUpgrade(request, socket, head, (client) => wss.emit('connection', client, request))
})

wss.on('connection', (socket) => {
  sessions.set(socket, { initialized: false, playerId: null, author: 'Странник', guildId: null, lastMessageAt: 0 })
  socket.send(JSON.stringify({ type: 'ready' }))

  socket.on('message', (raw) => {
    const parsed = parsePacket(raw.toString())
    if (!parsed.ok) return
    const session = sessions.get(socket)
    if (!session) return

    if (parsed.packet.type === 'hello') {
      session.initialized = true
      session.playerId = parsed.packet.playerId
      session.author = parsed.packet.author
      session.guildId = parsed.packet.guildId
      socket.send(JSON.stringify({ type: 'history', messages: visibleHistory(messages, session) }))
      return
    }

    if (!session.initialized) return
    const now = Date.now()
    if (now - session.lastMessageAt < 700) return
    if (parsed.packet.channel === 'guild' && !session.guildId) return
    session.lastMessageAt = now

    const message = createChatMessage({
      channel: parsed.packet.channel,
      author: session.author,
      text: parsed.packet.text,
      guildId: session.guildId,
    })
    messages.push(message)
    if (messages.length > 300) messages.splice(0, messages.length - 300)
    persistChatHistory()

    const packet = JSON.stringify({ type: 'message', message })
    for (const client of wss.clients) {
      const targetSession = sessions.get(client)
      if (client.readyState === WebSocket.OPEN && targetSession?.initialized && canReceive(message, targetSession)) client.send(packet)
    }
  })
})

server.listen(port, '0.0.0.0', () => {
  console.log(`Ashes server listening on http://0.0.0.0:${port}`)
})
