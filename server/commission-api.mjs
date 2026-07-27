import { sessionTokenFromRequest } from './api.mjs'
import { StoreError } from './store.mjs'

const MAX_BODY = 32 * 1024
function sendJson(response, status, payload) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' })
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

export function createCommissionApiHandler(store, commissions) {
  return async function handleCommissionApi(request, response) {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`)
    if (!url.pathname.startsWith('/api/commissions')) return false
    try {
      const user = requireUser(store, request)
      if (request.method === 'GET' && url.pathname === '/api/commissions') {
        sendJson(response, 200, commissions.snapshot(user.id, {
          query: url.searchParams.get('q') ?? '',
          profession: url.searchParams.get('profession') ?? 'all',
        }))
        return true
      }
      if (request.method === 'POST' && url.pathname === '/api/commissions') {
        sendJson(response, 200, commissions.createOrder(user.id, await readJson(request)))
        return true
      }
      const fulfillMatch = url.pathname.match(/^\/api\/commissions\/([^/]+)\/fulfill$/)
      if (request.method === 'POST' && fulfillMatch) {
        sendJson(response, 200, commissions.fulfillOrder(user.id, decodeURIComponent(fulfillMatch[1]), await readJson(request)))
        return true
      }
      const cancelMatch = url.pathname.match(/^\/api\/commissions\/([^/]+)\/cancel$/)
      if (request.method === 'POST' && cancelMatch) {
        sendJson(response, 200, commissions.cancelOrder(user.id, decodeURIComponent(cancelMatch[1]), await readJson(request)))
        return true
      }
      sendJson(response, 404, { error: { code: 'not-found', message: 'Маршрут не найден.' } })
      return true
    } catch (error) {
      if (error instanceof StoreError) {
        sendJson(response, error.status, { error: { code: error.code, message: error.message } })
        return true
      }
      console.error('Commission API request failed:', error)
      sendJson(response, 500, { error: { code: 'internal-error', message: 'Внутренняя ошибка сервера.' } })
      return true
    }
  }
}
