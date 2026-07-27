import { sessionTokenFromRequest } from './api.mjs'
import { installMarshStoryFixes } from './marsh-story-fixes.mjs'
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

export function createMarshStoryApiHandler(store, marshStories) {
  installMarshStoryFixes(store.db, marshStories)
  return async function handleMarshStoryApi(request, response) {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`)
    if (url.pathname !== '/api/marsh-story') return false

    try {
      const user = requireUser(store, request)
      if (request.method === 'GET') {
        sendJson(response, 200, { marshStory: marshStories.publicStory(user.id) })
        return true
      }
      if (request.method === 'POST') {
        const body = await readJson(request)
        sendJson(response, 200, marshStories.choose(user.id, body))
        return true
      }
      sendJson(response, 405, { error: { code: 'method-not-allowed', message: 'Метод не поддерживается.' } })
      return true
    } catch (error) {
      if (error instanceof StoreError) {
        sendJson(response, error.status, { error: { code: error.code, message: error.message } })
        return true
      }
      console.error('Marsh story API request failed:', error)
      sendJson(response, 500, { error: { code: 'internal-error', message: 'Внутренняя ошибка сервера.' } })
      return true
    }
  }
}
