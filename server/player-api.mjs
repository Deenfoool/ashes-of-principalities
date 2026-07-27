import { sessionTokenFromRequest } from './api.mjs'
import { StoreError } from './store.mjs'
import { expeditionContracts } from './player-store.mjs'

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

function requireFreePlay(stories, userId) {
  if (!stories) return
  const story = stories.publicStory(userId)
  if (story && !story.chapterComplete) {
    throw new StoreError(
      'chapter-in-progress',
      'Вольные походы и отдых вне сцены откроются после завершения первой главы.',
      409,
    )
  }
}

export function createPlayerApiHandler(store, players, stories = null, regions = null) {
  return async function handlePlayerApi(request, response) {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`)
    const isPlayerRoute = url.pathname.startsWith('/api/player/')
      || url.pathname === '/api/player'
      || url.pathname === '/api/guilds/treasury/deposit'
      || url.pathname === '/api/guilds/progress'
    if (!isPlayerRoute) return false

    try {
      const user = requireUser(store, request)

      if (request.method === 'GET' && url.pathname === '/api/player/contracts') {
        requireFreePlay(stories, user.id)
        sendJson(response, 200, regions ? regions.snapshot(user.id) : { contracts: expeditionContracts, regions: [], rotationEndsAt: null })
        return true
      }

      if (request.method === 'GET' && url.pathname === '/api/player') {
        sendJson(response, 200, { character: players.getCharacter(user.id) })
        return true
      }

      if (request.method === 'POST' && url.pathname === '/api/player') {
        const body = await readJson(request)
        sendJson(response, 201, players.createCharacter(user.id, body))
        return true
      }

      if (request.method === 'POST' && url.pathname === '/api/player/expeditions') {
        requireFreePlay(stories, user.id)
        const body = await readJson(request)
        sendJson(response, 201, players.startExpedition(user.id, body))
        return true
      }

      if (request.method === 'POST' && url.pathname === '/api/player/expeditions/action') {
        const body = await readJson(request)
        sendJson(response, 200, players.actExpedition(user.id, body))
        return true
      }

      if (request.method === 'POST' && url.pathname === '/api/player/rest') {
        requireFreePlay(stories, user.id)
        const body = await readJson(request)
        sendJson(response, 200, players.rest(user.id, body))
        return true
      }

      if (request.method === 'POST' && url.pathname === '/api/player/heir') {
        const body = await readJson(request)
        sendJson(response, 200, players.createHeir(user.id, body))
        return true
      }

      if (request.method === 'POST' && url.pathname === '/api/guilds/treasury/deposit') {
        const body = await readJson(request)
        sendJson(response, 200, players.donateCoins(user.id, body))
        return true
      }

      if (request.method === 'POST' && url.pathname === '/api/guilds/progress') {
        throw new StoreError(
          'server-derived-progress',
          'Прогресс гильдии начисляется только за подтверждённые сервером победы и контракты.',
          403,
        )
      }

      sendJson(response, 404, { error: { code: 'not-found', message: 'Маршрут не найден.' } })
      return true
    } catch (error) {
      if (error instanceof StoreError) {
        sendJson(response, error.status, { error: { code: error.code, message: error.message } })
        return true
      }
      console.error('Player API request failed:', error)
      sendJson(response, 500, { error: { code: 'internal-error', message: 'Внутренняя ошибка сервера.' } })
      return true
    }
  }
}
