import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createApiHandler } from './api.mjs'
import { createPlayerApiHandler } from './player-api.mjs'
import { createStoryApiHandler } from './story-api.mjs'
import { createSurvivalApiHandler } from './survival-api.mjs'
import { GameStore } from './store.mjs'
import { PlayerStore } from './player-store.mjs'
import { StoryStore } from './story-store.mjs'
import { SurvivalStore } from './survival-store.mjs'

async function startApi() {
  const game = new GameStore(':memory:')
  const players = new PlayerStore(game)
  const stories = new StoryStore(game, players)
  const survival = new SurvivalStore(game, players)
  const handlers = [
    createSurvivalApiHandler(game, survival),
    createStoryApiHandler(game, players, stories),
    createPlayerApiHandler(game, players, stories),
    createApiHandler(game),
  ]
  const server = createServer(async (request, response) => {
    for (const handler of handlers) if (await handler(request, response)) return
    response.writeHead(404).end()
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  return {
    game,
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

async function accountWithHero(api, username = 'survival_api') {
  const account = await request(api.base, '/api/auth/register', {
    method: 'POST', body: { username, password: '12345678', displayName: 'Испытатель' },
  })
  await request(api.base, '/api/player', {
    method: 'POST', cookie: account.cookie,
    body: { requestId: `${username}-create-0001`, name: 'Добрын', profession: 'blacksmith' },
  })
  await request(api.base, '/api/story', { cookie: account.cookie })
  return account
}

test('survival routes require a session and never cache private state', async () => {
  const api = await startApi()
  try {
    const guest = await request(api.base, '/api/player/items/smith-hammer/repair', {
      method: 'POST', body: { requestId: 'guest-repair-0001' },
    })
    assert.equal(guest.status, 401)
    assert.equal(guest.cacheControl, 'no-store')

    const account = await accountWithHero(api)
    api.game.db.prepare("UPDATE player_story_state SET scene_id = 'tavern' WHERE user_id = (SELECT id FROM users WHERE username = 'survival_api')").run()
    api.game.db.prepare("UPDATE player_inventory SET durability = 20 WHERE user_id = (SELECT id FROM users WHERE username = 'survival_api') AND item_id = 'smith-hammer'").run()
    const repair = await request(api.base, '/api/player/items/smith-hammer/repair', {
      method: 'POST', cookie: account.cookie, body: { requestId: 'api-repair-0001' },
    })
    assert.equal(repair.status, 200)
    assert.equal(repair.data.character.equippedItem.durability, 40)
    assert.equal(repair.cacheControl, 'no-store')
  } finally {
    await api.close()
  }
})

test('guild API rejects the old free request and charges the valid request once', async () => {
  const api = await startApi()
  try {
    const account = await accountWithHero(api, 'guild_api')
    const user = api.game.db.prepare("SELECT id FROM users WHERE username = 'guild_api'").get()
    const now = Date.now()
    api.game.db.prepare(`
      INSERT INTO player_story_quests(user_id, quest_id, status, outcome, contract_counted, started_at)
      VALUES (?, 'taxman', 'active', NULL, 0, ?)
    `).run(user.id, now)
    api.game.db.prepare("UPDATE player_story_quests SET status = 'completed', completed_at = ? WHERE user_id = ? AND quest_id = 'taxman'").run(now, user.id)
    api.game.db.prepare('UPDATE player_characters SET coins = 20 WHERE user_id = ?').run(user.id)

    const oldRequest = await request(api.base, '/api/guilds', {
      method: 'POST', cookie: account.cookie, body: { name: 'Старая лазейка', tag: 'СТ' },
    })
    assert.equal(oldRequest.status, 400)
    assert.equal(oldRequest.data.error.code, 'invalid-request-id')

    const body = { requestId: 'api-guild-0001', name: 'Новая дружина', tag: 'НД' }
    const created = await request(api.base, '/api/guilds', { method: 'POST', cookie: account.cookie, body })
    const repeated = await request(api.base, '/api/guilds', { method: 'POST', cookie: account.cookie, body })
    assert.equal(created.status, 201)
    assert.equal(created.data.character.coins, 8)
    assert.deepEqual(repeated.data, created.data)
    assert.equal(api.game.getGuildForUser(user.id).memberCount, 1)
  } finally {
    await api.close()
  }
})