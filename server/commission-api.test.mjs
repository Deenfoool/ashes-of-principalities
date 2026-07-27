import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createApiHandler } from './api.mjs'
import { createCommissionApiHandler } from './commission-api.mjs'
import { CommissionStore } from './commission-store.mjs'
import { CraftingStore } from './crafting-store.mjs'
import { MarketStore } from './market-store.mjs'
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
  const market = new MarketStore(game, players)
  const commissions = new CommissionStore(game, players, market)
  const accountApi = createApiHandler(game)
  const playerApi = createPlayerApiHandler(game, players, stories)
  const commissionApi = createCommissionApiHandler(game, commissions)
  const server = createServer(async (request, response) => {
    if (await commissionApi(request, response)) return
    if (await playerApi(request, response)) return
    if (await accountApi(request, response)) return
    response.writeHead(404).end()
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  return {
    game, players, stories, crafting, commissions,
    base: `http://127.0.0.1:${address.port}`,
    close: async () => { await new Promise((resolve) => server.close(resolve)); game.close() },
  }
}

async function request(base, path, { method = 'GET', cookie, body } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })
  const data = await response.json()
  return { status: response.status, data, cookie: response.headers.get('set-cookie')?.split(';', 1)[0] ?? cookie ?? null, cacheControl: response.headers.get('cache-control') }
}

async function createCharacter(api, username, displayName, profession) {
  const account = await request(api.base, '/api/auth/register', { method: 'POST', body: { username, password: '12345678', displayName } })
  const created = await request(api.base, '/api/player', { method: 'POST', cookie: account.cookie, body: { requestId: `${username}-create-0001`, name: displayName, profession } })
  api.stories.publicStory(created.data.character.userId)
  api.game.db.prepare("UPDATE player_story_state SET scene_id = 'tavern' WHERE user_id = ?").run(created.data.character.userId)
  return { cookie: account.cookie, userId: created.data.character.userId }
}

test('commission API requires authentication and never caches private data', async () => {
  const api = await startApi()
  try {
    const guest = await request(api.base, '/api/commissions')
    assert.equal(guest.status, 401)
    assert.equal(guest.cacheControl, 'no-store')
    const account = await createCharacter(api, 'commission_api_user', 'Заказчик', 'hunter')
    const snapshot = await request(api.base, '/api/commissions', { cookie: account.cookie })
    assert.equal(snapshot.status, 200)
    assert.equal(snapshot.cacheControl, 'no-store')
    assert.equal(snapshot.data.catalog.length, 6)
  } finally { await api.close() }
})

test('HTTP commission create and fulfill are idempotent', async () => {
  const api = await startApi()
  try {
    const buyer = await createCharacter(api, 'commission_api_buyer', 'Заказчик', 'hunter')
    const smith = await createCharacter(api, 'commission_api_smith', 'Кузнец', 'blacksmith')
    api.game.db.prepare('UPDATE player_characters SET coins = 50 WHERE user_id = ?').run(buyer.userId)
    api.crafting.addStack(smith.userId, 'scrap-iron', 'Лом железа', 2)
    api.crafting.addStack(smith.userId, 'charcoal', 'Древесный уголь', 1)
    const createBody = { requestId: 'commission-api-create-0001', recipeId: 'field-repair-kit', batches: 1, rewardCoins: 10, targetUsername: 'commission_api_smith' }
    const created = await request(api.base, '/api/commissions', { method: 'POST', cookie: buyer.cookie, body: createBody })
    const repeatedCreate = await request(api.base, '/api/commissions', { method: 'POST', cookie: buyer.cookie, body: createBody })
    const orderId = created.data.mine[0].id
    const fulfillBody = { requestId: 'commission-api-fulfill-0001' }
    const fulfilled = await request(api.base, `/api/commissions/${orderId}/fulfill`, { method: 'POST', cookie: smith.cookie, body: fulfillBody })
    const repeatedFulfill = await request(api.base, `/api/commissions/${orderId}/fulfill`, { method: 'POST', cookie: smith.cookie, body: fulfillBody })
    assert.equal(created.status, 200)
    assert.deepEqual(repeatedCreate.data, created.data)
    assert.equal(fulfilled.status, 200)
    assert.deepEqual(repeatedFulfill.data, fulfilled.data)
    assert.equal(api.game.db.prepare("SELECT quantity FROM player_inventory WHERE user_id = ? AND item_id = 'repair-kit'").get(buyer.userId).quantity, 2)
    assert.equal(api.game.db.prepare("SELECT COUNT(*) AS count FROM craft_commissions WHERE status = 'fulfilled'").get().count, 1)
  } finally { await api.close() }
})
