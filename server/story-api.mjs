import { StoreError } from './store.mjs'
import { sessionTokenFromRequest } from './api.mjs'

const MAX_BODY = 16 * 1024

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

function requireUser(gameStore, request) {
  const user = gameStore.authenticate(sessionTokenFromRequest(request))
  if (!user) throw new StoreError('unauthorized', 'Требуется вход в аккаунт.', 401)
  return user
}

export function createStoryApiHandler(gameStore, playerStore, storyStore) {
  return async function handleStoryApi(request, response) {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`)
    if (!url.pathname.startsWith('/api/story')) return false

    try {
      if (request.method === 'GET' && url.pathname === '/api/story') {
        const user = requireUser(gameStore, request)
        sendJson(response, 200, {
          character: playerStore.getCharacter(user.id),
          story: storyStore.publicStory(user.id),
        })
        return true
      }

      if (request.method === 'POST' && url.pathname === '/api/story/choose') {
        const user = requireUser(gameStore, request)
        const body = await readJson(request)
        sendJson(response, 200, storyStore.choose(user.id, body))
        return true
      }

      sendJson(response, 404, { error: { code: 'not-found', message: 'Сюжетный маршрут не найден.' } })
      return true
    } catch (error) {
      if (error instanceof StoreError) {
        sendJson(response, error.status, { error: { code: error.code, message: error.message } })
        return true
      }
      console.error('Story API request failed:', error)
      sendJson(response, 500, { error: { code: 'internal-error', message: 'Внутренняя ошибка сюжетного сервера.' } })
      return true
    }
  }
}
