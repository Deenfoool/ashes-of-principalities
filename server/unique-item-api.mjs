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
  if (!chunks.length) return {}
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) }
  catch { throw new StoreError('invalid-json', 'Некорректный JSON.', 400) }
}

function requireUser(store, request) {
  const user = store.authenticate(sessionTokenFromRequest(request))
  if (!user) throw new StoreError('unauthorized', 'Требуется вход в аккаунт.', 401)
  return user
}

export function createUniqueItemApiHandler(store, artifacts) {
  return async function handleUniqueItemApi(request, response) {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`)
    if (!url.pathname.startsWith('/api/artifacts')) return false
    try {
      const user = requireUser(store, request)
      if (request.method === 'GET' && url.pathname === '/api/artifacts') {
        sendJson(response, 200, artifacts.snapshot(user.id)); return true
      }
      const forge = url.pathname.match(/^\/api\/artifacts\/blueprints\/([^/]+)\/forge$/)
      if (request.method === 'POST' && forge) {
        sendJson(response, 200, artifacts.forge(user.id, decodeURIComponent(forge[1]), await readJson(request))); return true
      }
      const list = url.pathname.match(/^\/api\/artifacts\/items\/([^/]+)\/list$/)
      if (request.method === 'POST' && list) {
        sendJson(response, 200, artifacts.createListing(user.id, decodeURIComponent(list[1]), await readJson(request))); return true
      }
      const buy = url.pathname.match(/^\/api\/artifacts\/listings\/([^/]+)\/buy$/)
      if (request.method === 'POST' && buy) {
        sendJson(response, 200, artifacts.buyListing(user.id, decodeURIComponent(buy[1]), await readJson(request))); return true
      }
      const cancel = url.pathname.match(/^\/api\/artifacts\/listings\/([^/]+)\/cancel$/)
      if (request.method === 'POST' && cancel) {
        sendJson(response, 200, artifacts.cancelListing(user.id, decodeURIComponent(cancel[1]), await readJson(request))); return true
      }
      sendJson(response, 404, { error: { code: 'not-found', message: 'Маршрут не найден.' } }); return true
    } catch (error) {
      if (error instanceof StoreError) {
        sendJson(response, error.status, { error: { code: error.code, message: error.message } }); return true
      }
      console.error('Artifact API request failed:', error)
      sendJson(response, 500, { error: { code: 'internal-error', message: 'Внутренняя ошибка сервера.' } }); return true
    }
  }
}
