import { sessionTokenFromRequest } from './api.mjs'
import { installGuildExpansionFixes } from './guild-expansion-fixes.mjs'
import { StoreError } from './store.mjs'

const MAX_BODY = 32 * 1024

function sendJson(response, status, payload) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  })
  response.end(JSON.stringify(payload))
}

async function readJson(request) {
  const chunks = []
  let length = 0
  for await (const chunk of request) {
    length += chunk.length
    if (length > MAX_BODY) throw new StoreError('body-too-large', 'Запрос слишком большой.', 413)
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) }
  catch { throw new StoreError('invalid-json', 'Некорректный JSON.', 400) }
}

function requireUser(store, request) {
  const user = store.authenticate(sessionTokenFromRequest(request))
  if (!user) throw new StoreError('unauthorized', 'Требуется вход в аккаунт.', 401)
  return user
}

export function createGuildExpansionApiHandler(store, expansion) {
  installGuildExpansionFixes(expansion)
  return async function handleGuildExpansionApi(request, response) {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`)
    if (!url.pathname.startsWith('/api/guilds/expansion')
      && !url.pathname.startsWith('/api/guilds/resources')
      && !url.pathname.startsWith('/api/guilds/leadership')
      && !url.pathname.startsWith('/api/guilds/raid')) return false

    try {
      const user = requireUser(store, request)

      if (request.method === 'GET' && url.pathname === '/api/guilds/expansion') {
        sendJson(response, 200, expansion.expansionSnapshot(user.id))
        return true
      }

      if (request.method === 'POST' && url.pathname === '/api/guilds/resources/deposit') {
        sendJson(response, 200, expansion.depositResource(user.id, await readJson(request)))
        return true
      }

      if (request.method === 'POST' && url.pathname === '/api/guilds/resources/withdraw') {
        sendJson(response, 200, expansion.withdrawResource(user.id, await readJson(request)))
        return true
      }

      if (request.method === 'POST' && url.pathname === '/api/guilds/leadership/transfer') {
        sendJson(response, 200, expansion.transferLeadership(user.id, await readJson(request)))
        return true
      }

      if (request.method === 'POST' && url.pathname === '/api/guilds/raid/prepare') {
        sendJson(response, 200, expansion.prepareRaid(user.id, await readJson(request)))
        return true
      }

      if (request.method === 'POST' && url.pathname === '/api/guilds/raid/cancel') {
        sendJson(response, 200, expansion.cancelRaid(user.id, await readJson(request)))
        return true
      }

      if (request.method === 'POST' && url.pathname === '/api/guilds/raid/join') {
        sendJson(response, 200, expansion.joinRaid(user.id, await readJson(request)))
        return true
      }

      if (request.method === 'POST' && url.pathname === '/api/guilds/raid/start') {
        sendJson(response, 200, expansion.startRaid(user.id, await readJson(request)))
        return true
      }

      if (request.method === 'POST' && url.pathname === '/api/guilds/raid/action') {
        sendJson(response, 200, expansion.actRaid(user.id, await readJson(request)))
        return true
      }

      sendJson(response, 404, { error: { code: 'not-found', message: 'Маршрут не найден.' } })
      return true
    } catch (error) {
      if (error instanceof StoreError) {
        sendJson(response, error.status, { error: { code: error.code, message: error.message } })
        return true
      }
      console.error('Guild expansion API request failed:', error)
      sendJson(response, 500, { error: { code: 'internal-error', message: 'Внутренняя ошибка сервера.' } })
      return true
    }
  }
}
