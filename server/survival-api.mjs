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

export function createSurvivalApiHandler(store, survival) {
  return async function handleSurvivalApi(request, response) {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`)
    const isRoute = url.pathname.startsWith('/api/player/items/')
      || url.pathname.startsWith('/api/player/equipment/')
      || url.pathname.startsWith('/api/player/injuries/')
      || (request.method === 'POST' && url.pathname === '/api/guilds')
    if (!isRoute) return false

    try {
      const user = requireUser(store, request)

      const repairMatch = url.pathname.match(/^\/api\/player\/items\/([^/]+)\/repair$/)
      if (request.method === 'POST' && repairMatch) {
        const body = await readJson(request)
        sendJson(response, 200, survival.repairItem(user.id, decodeURIComponent(repairMatch[1]), body))
        return true
      }

      const equipMatch = url.pathname.match(/^\/api\/player\/items\/([^/]+)\/equip$/)
      if (request.method === 'POST' && equipMatch) {
        const body = await readJson(request)
        sendJson(response, 200, survival.equipItem(user.id, decodeURIComponent(equipMatch[1]), body))
        return true
      }

      const unequipMatch = url.pathname.match(/^\/api\/player\/equipment\/([^/]+)\/unequip$/)
      if (request.method === 'POST' && unequipMatch) {
        const body = await readJson(request)
        sendJson(response, 200, survival.unequipSlot(user.id, decodeURIComponent(unequipMatch[1]), body))
        return true
      }

      const injuryMatch = url.pathname.match(/^\/api\/player\/injuries\/([^/]+)\/treat$/)
      if (request.method === 'POST' && injuryMatch) {
        const body = await readJson(request)
        sendJson(response, 200, survival.treatInjury(user.id, decodeURIComponent(injuryMatch[1]), body))
        return true
      }

      if (request.method === 'POST' && url.pathname === '/api/guilds') {
        const body = await readJson(request)
        sendJson(response, 201, survival.createPaidGuild(user.id, body))
        return true
      }

      sendJson(response, 404, { error: { code: 'not-found', message: 'Маршрут не найден.' } })
      return true
    } catch (error) {
      if (error instanceof StoreError) {
        sendJson(response, error.status, { error: { code: error.code, message: error.message } })
        return true
      }
      console.error('Survival API request failed:', error)
      sendJson(response, 500, { error: { code: 'internal-error', message: 'Внутренняя ошибка сервера.' } })
      return true
    }
  }
}
