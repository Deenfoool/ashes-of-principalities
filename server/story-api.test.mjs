import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createApiHandler } from './api.mjs'
import { createPlayerApiHandler } from './player-api.mjs'
import { createStoryApiHandler } from './story-api.mjs'
import { GameStore } from './store.mjs'
import { PlayerStore } from './player-store.mjs'
import { StoryStore } from './story-store.mjs'

async function startApi() {
  const game = new GameStore(':memory:')
  const players = new PlayerStore(game)
  const stories = new StoryStore(game, players)
  const accountApi = createApiHandler(game)
  const playerApi = createPlayerApiHandler(game, players, stories)
  const storyApi = createStoryApiHandler(game, players, stories)
  const server = createServer(async (request, response) => {
    if (await storyApi(request, response)) return
    if (await playerApi(request, response)) return
    if (await accountApi(request, response)) return
    response.writeHead(404).end()
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  return {
    base: `http://127.0.0.1:${address.port}`,
    close: async () => {
      await new Promise((resolve) => server.close(resolve))
      game.close()
    },
  }
}

async function request(base, path, { method = 'GET', cookie, body } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(cookie ? { Cookie: cookie } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  const setCookie = response.headers.get('set-cookie')
  return {
    status: response.status,
    data: await response.json(),
    cookie: setCookie?.split(';', 1)[0] ?? cookie ?? null,
    cacheControl: response.headers.get('cache-control'),
  }
}

test('story API requires an account and never caches private state', async () => {
  const api = await startApi()
  try {
    const guest = await request(api.base, '/api/story')
    assert.equal(guest.status, 401)
    const account = await request(api.base, '/api/auth/register', {
      method: 'POST',
      body: { username: 'story_api', password: '12345678', displayName: 'Сказитель' },
    })
    await request(api.base, '/api/player', {
      method: 'POST', cookie: account.cookie,
      body: { requestId: 'api-create-0001', name: 'Мирослав', profession: 'hunter' },
    })
    const snapshot = await request(api.base, '/api/story', { cookie: account.cookie })
    assert.equal(snapshot.status, 200)
    assert.equal(snapshot.data.story.scene.id, 'crossroads')
    assert.equal(snapshot.cacheControl, 'no-store')
  } finally {
    await api.close()
  }
})

test('story choice endpoint returns one combined character and story snapshot', async () => {
  const api = await startApi()
  try {
    const account = await request(api.base, '/api/auth/register', {
      method: 'POST',
      body: { username: 'story_choice', password: '12345678', displayName: 'Путник' },
    })
    await request(api.base, '/api/player', {
      method: 'POST', cookie: account.cookie,
      body: { requestId: 'choice-create-0001', name: 'Ратибор', profession: 'blacksmith' },
    })
    const choice = await request(api.base, '/api/story/choose', {
      method: 'POST', cookie: account.cookie,
      body: { requestId: 'choice-story-0001', choiceId: 'inspect-cart' },
    })
    assert.equal(choice.status, 200)
    assert.equal(choice.data.story.scene.id, 'cart')
    assert.equal(choice.data.character.coins, 5)
  } finally {
    await api.close()
  }
})

test('free contracts and out-of-scene rest stay locked until the chapter ends', async () => {
  const api = await startApi()
  try {
    const account = await request(api.base, '/api/auth/register', {
      method: 'POST',
      body: { username: 'story_gate', password: '12345678', displayName: 'Закрытый путь' },
    })
    await request(api.base, '/api/player', {
      method: 'POST', cookie: account.cookie,
      body: { requestId: 'gate-create-0001', name: 'Всеволод', profession: 'carter' },
    })
    const expedition = await request(api.base, '/api/player/expeditions', {
      method: 'POST', cookie: account.cookie,
      body: { requestId: 'gate-expedition-0001', contractId: 'ash-wolf' },
    })
    assert.equal(expedition.status, 409)
    assert.equal(expedition.data.error.code, 'chapter-in-progress')

    const rest = await request(api.base, '/api/player/rest', {
      method: 'POST', cookie: account.cookie,
      body: { requestId: 'gate-rest-0001' },
    })
    assert.equal(rest.status, 409)
    assert.equal(rest.data.error.code, 'chapter-in-progress')
  } finally {
    await api.close()
  }
})
