import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createApiHandler } from './api.mjs'
import { createMarketApiHandler } from './market-api.mjs'
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
  const market = new MarketStore(game, players)
  const accountApi = createApiHandler(game)
  const playerApi = createPlayerApiHandler(game, players, stories)
  const marketApi = createMarketApiHandler(game, market)
  const server = createServer(async (request, response) => {
    if (await marketApi(request, response)) return
    if (await playerApi(request, response)) return
    if (await accountApi(request, response)) return
    response.writeHead(404).end()
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  return {
    game, players, stories, market,
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
  const data = await response.json()
  return {
    status: response.status,
    data,
    cookie: response.headers.get('set-cookie')?.split(';', 1)[0] ?? cookie ?? null,
    cacheControl: response.headers.get('cache-control'),
  }
}

async function createCharacter(api, username, displayName, profession = 'hunter') {
  const account = await request(api.base, '/api/auth/register', {
    method: 'POST', body: { username, password: '12345678', displayName },
  })
  const created = await request(api.base, '/api/player', {
    method: 'POST', cookie: account.cookie,
    body: { requestId: `${username}-create-0001`, name: displayName, profession },
  })
  api.stories.publicStory(created.data.character.userId)
  api.game.db.prepare("UPDATE player_story_state SET scene_id = 'tavern' WHERE user_id = ?").run(created.data.character.userId)
  return { cookie: account.cookie, userId: created.data.character.userId }
}

test('market API requires authentication and uses no-store', async () => {
  const api = await startApi()
  try {
    const guest = await request(api.base, '/api/market')
    assert.equal(guest.status, 401)
    assert.equal(guest.cacheControl, 'no-store')

    const account = await createCharacter(api, 'market_api_user', 'Купец')
    const snapshot = await request(api.base, '/api/market', { cookie: account.cookie })
    assert.equal(snapshot.status, 200)
    assert.equal(snapshot.cacheControl, 'no-store')
    assert.equal(Array.isArray(snapshot.data.listings), true)
  } finally {
    await api.close()
  }
})

test('HTTP listing and purchase remain idempotent', async () => {
  const api = await startApi()
  try {
    const seller = await createCharacter(api, 'market_api_seller', 'Продавец', 'blacksmith')
    const buyer = await createCharacter(api, 'market_api_buyer', 'Покупатель')
    api.market.addStack(seller.userId, {
      id: 'scrap-iron', name: 'Лом железа', type: 'material', quality: 'common', quantity: 3,
    })
    api.game.db.prepare('UPDATE player_characters SET coins = 30 WHERE user_id = ?').run(buyer.userId)

    const createBody = { requestId: 'market-api-create-0001', itemId: 'scrap-iron', quantity: 3, unitPrice: 5 }
    const created = await request(api.base, '/api/market/listings', { method: 'POST', cookie: seller.cookie, body: createBody })
    const repeatedCreate = await request(api.base, '/api/market/listings', { method: 'POST', cookie: seller.cookie, body: createBody })
    const listingId = created.data.ownListings[0].id

    const buyBody = { requestId: 'market-api-buy-0001', quantity: 2 }
    const bought = await request(api.base, `/api/market/listings/${listingId}/buy`, { method: 'POST', cookie: buyer.cookie, body: buyBody })
    const repeatedBuy = await request(api.base, `/api/market/listings/${listingId}/buy`, { method: 'POST', cookie: buyer.cookie, body: buyBody })

    assert.equal(created.status, 200)
    assert.deepEqual(repeatedCreate.data, created.data)
    assert.equal(bought.status, 200)
    assert.deepEqual(repeatedBuy.data, bought.data)
    assert.equal(bought.data.purchase.gross, 10)
    assert.equal(api.game.db.prepare('SELECT COUNT(*) AS count FROM market_listings').get().count, 1)
    assert.equal(api.game.db.prepare('SELECT COUNT(*) AS count FROM market_trades').get().count, 1)
  } finally {
    await api.close()
  }
})
