import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createApiHandler } from './api.mjs'
import { createCraftingApiHandler } from './crafting-api.mjs'
import { CraftingStore } from './crafting-store.mjs'
import { createPlayerApiHandler } from './player-api.mjs'
import { PlayerStore } from './player-store.mjs'
import { StoryStore } from './story-store.mjs'
import { installSurvivalRewards } from './survival-rewards.mjs'
import { SurvivalStore } from './survival-store.mjs'
import { GameStore } from './store.mjs'

async function startApi() {
  const game = new GameStore(':memory:')
  const players = new PlayerStore(game)
  const stories = new StoryStore(game, players)
  const survival = new SurvivalStore(game, players)
  installSurvivalRewards(game.db)
  const crafting = new CraftingStore(game, players, survival)
  const accountApi = createApiHandler(game)
  const playerApi = createPlayerApiHandler(game, players, stories)
  const craftingApi = createCraftingApiHandler(game, crafting)
  const server = createServer(async (request, response) => {
    if (await craftingApi(request, response)) return
    if (await playerApi(request, response)) return
    if (await accountApi(request, response)) return
    response.writeHead(404).end()
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  return {
    game, players, stories, crafting,
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
  const payload = await response.json()
  return {
    status: response.status,
    data: payload,
    cookie: response.headers.get('set-cookie')?.split(';', 1)[0] ?? cookie ?? null,
    cacheControl: response.headers.get('cache-control'),
  }
}

async function createCharacter(api, profession = 'blacksmith') {
  const account = await request(api.base, '/api/auth/register', {
    method: 'POST',
    body: { username: `api_${profession}`, password: '12345678', displayName: 'Ремесленник' },
  })
  const created = await request(api.base, '/api/player', {
    method: 'POST', cookie: account.cookie,
    body: { requestId: `api-${profession}-create-0001`, name: 'Мирослав', profession },
  })
  api.stories.publicStory(created.data.character.userId)
  api.game.db.prepare("UPDATE player_story_state SET scene_id = 'tavern' WHERE user_id = ?").run(created.data.character.userId)
  return { cookie: account.cookie, userId: created.data.character.userId }
}

test('crafting API requires a private session and never caches workshop data', async () => {
  const api = await startApi()
  try {
    const guest = await request(api.base, '/api/crafting')
    assert.equal(guest.status, 401)
    assert.equal(guest.cacheControl, 'no-store')

    const account = await createCharacter(api)
    const workshop = await request(api.base, '/api/crafting', { cookie: account.cookie })
    assert.equal(workshop.status, 200)
    assert.equal(workshop.cacheControl, 'no-store')
    assert.equal(Array.isArray(workshop.data.recipes), true)
  } finally {
    await api.close()
  }
})

test('crafting endpoint is idempotent and returns the refreshed character', async () => {
  const api = await startApi()
  try {
    const account = await createCharacter(api)
    api.crafting.addStack(account.userId, 'scrap-iron', 'Лом железа', 2)
    api.crafting.addStack(account.userId, 'charcoal', 'Древесный уголь', 1)

    const body = { requestId: 'api-craft-kit-0001' }
    const first = await request(api.base, '/api/crafting/field-repair-kit', {
      method: 'POST', cookie: account.cookie, body,
    })
    const repeated = await request(api.base, '/api/crafting/field-repair-kit', {
      method: 'POST', cookie: account.cookie, body,
    })

    assert.equal(first.status, 200)
    assert.equal(first.data.crafted.result, 'Полевой ремкомплект ×2')
    assert.deepEqual(repeated.data, first.data)
    assert.equal(first.data.character.inventory.find((item) => item.id === 'repair-kit').quantity, 2)
  } finally {
    await api.close()
  }
})
