import { sessionTokenFromRequest } from './api.mjs'
import { installMarshSystemFixes } from './marsh-system-fixes.mjs'
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

export function createMarshSystemApiHandler(store, marshSystem) {
  installMarshSystemFixes(store.db, marshSystem)
  return async function handleMarshSystemApi(request, response) {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`)
    if (url.pathname !== '/api/player/expeditions/tactic') return false
    try {
      const user = store.authenticate(sessionTokenFromRequest(request))
      if (!user) throw new StoreError('unauthorized', 'Требуется вход в аккаунт.', 401)
      if (request.method !== 'POST') {
        sendJson(response, 405, { error: { code: 'method-not-allowed', message: 'Метод не поддерживается.' } })
        return true
      }
      const body = await readJson(request)
      sendJson(response, 200, marshSystem.tactic(user.id, body))
      return true
    } catch (error) {
      if (error instanceof StoreError) {
        sendJson(response, error.status, { error: { code: error.code, message: error.message } })
        return true
      }
      console.error('Marsh tactic API request failed:', error)
      sendJson(response, 500, { error: { code: 'internal-error', message: 'Внутренняя ошибка сервера.' } })
      return true
    }
  }
}
