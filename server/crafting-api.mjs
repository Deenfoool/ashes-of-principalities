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

function presentWorkshop(workshop) {
  if (!workshop?.character || !Array.isArray(workshop.recipes)) return workshop
  if (workshop.character.profession !== 'blacksmith') return workshop
  return {
    ...workshop,
    recipes: workshop.recipes.map((recipe) => recipe.id === 'field-repair-kit'
      ? { ...recipe, result: 'Полевой ремкомплект ×2' }
      : recipe),
  }
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

export function createCraftingApiHandler(store, crafting) {
  return async function handleCraftingApi(request, response) {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`)
    if (!url.pathname.startsWith('/api/crafting')) return false

    try {
      const user = requireUser(store, request)
      if (request.method === 'GET' && url.pathname === '/api/crafting') {
        sendJson(response, 200, presentWorkshop(crafting.workshop(user.id)))
        return true
      }

      const match = url.pathname.match(/^\/api\/crafting\/([^/]+)$/)
      if (request.method === 'POST' && match) {
        const body = await readJson(request)
        sendJson(response, 200, presentWorkshop(crafting.craft(user.id, decodeURIComponent(match[1]), body)))
        return true
      }

      sendJson(response, 404, { error: { code: 'not-found', message: 'Маршрут не найден.' } })
      return true
    } catch (error) {
      if (error instanceof StoreError) {
        sendJson(response, error.status, { error: { code: error.code, message: error.message } })
        return true
      }
      console.error('Crafting API request failed:', error)
      sendJson(response, 500, { error: { code: 'internal-error', message: 'Внутренняя ошибка сервера.' } })
      return true
    }
  }
}
