import { sessionTokenFromRequest } from './api.mjs'
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
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new StoreError('invalid-json', 'Некорректный JSON.', 400)
  }
}

function requireUser(store, request) {
  const user = store.authenticate(sessionTokenFromRequest(request))
  if (!user) throw new StoreError('unauthorized', 'Требуется вход в аккаунт.', 401)
  return user
}

export function createMarketApiHandler(store, market) {
  return async function handleMarketApi(request, response) {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`)
    if (!url.pathname.startsWith('/api/market')) return false

    try {
      const user = requireUser(store, request)
      if (request.method === 'GET' && url.pathname === '/api/market') {
        sendJson(response, 200, market.snapshot(user.id, {
          query: url.searchParams.get('q') ?? '',
          type: url.searchParams.get('type') ?? 'all',
          sort: url.searchParams.get('sort') ?? 'newest',
        }))
        return true
      }
      if (request.method === 'POST' && url.pathname === '/api/market/listings') {
        sendJson(response, 200, market.createListing(user.id, await readJson(request)))
        return true
      }
      const buyMatch = url.pathname.match(/^\/api\/market\/listings\/([^/]+)\/buy$/)
      if (request.method === 'POST' && buyMatch) {
        sendJson(response, 200, market.buyListing(user.id, decodeURIComponent(buyMatch[1]), await readJson(request)))
        return true
      }
      const cancelMatch = url.pathname.match(/^\/api\/market\/listings\/([^/]+)\/cancel$/)
      if (request.method === 'POST' && cancelMatch) {
        sendJson(response, 200, market.cancelListing(user.id, decodeURIComponent(cancelMatch[1]), await readJson(request)))
        return true
      }
      sendJson(response, 404, { error: { code: 'not-found', message: 'Маршрут не найден.' } })
      return true
    } catch (error) {
      if (error instanceof StoreError) {
        sendJson(response, error.status, { error: { code: error.code, message: error.message } })
        return true
      }
      console.error('Market API request failed:', error)
      sendJson(response, 500, { error: { code: 'internal-error', message: 'Внутренняя ошибка сервера.' } })
      return true
    }
  }
}
