import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createApiHandler } from './api.mjs'
import { CommissionStore } from './commission-store.mjs'
import { CraftingStore } from './crafting-store.mjs'
import { installCraftingMigrations } from './crafting-migrations.mjs'
import { MarketStore } from './market-store.mjs'
import { createPlayerApiHandler } from './player-api.mjs'
import { PlayerStore } from './player-store.mjs'
import { StoryStore } from './story-store.mjs'
import { installSurvivalRewards } from './survival-rewards.mjs'
import { SurvivalStore } from './survival-store.mjs'
import { GameStore } from './store.mjs'
import { createUniqueItemApiHandler } from './unique-item-api.mjs'
import { installUniqueItemFixes } from './unique-item-fixes.mjs'
import { UniqueItemStore } from './unique-item-store.mjs'

async function startApi() {
  const game = new GameStore(':memory:')
  const players = new PlayerStore(game)
  const stories = new StoryStore(game, players)
  const survival = new SurvivalStore(game, players)
  installSurvivalRewards(game.db)
  const crafting = new CraftingStore(game, players, survival)
  installCraftingMigrations(game.db)
  const market = new MarketStore(game, players)
  const artifacts = new UniqueItemStore(game, players, survival, market)
  installUniqueItemFixes(game.db, artifacts)
  artifacts.patchCrafting(crafting)
  new CommissionStore(game, players, market)
  const accountApi = createApiHandler(game)
  const playerApi = createPlayerApiHandler(game, players, stories)
  const artifactApi = createUniqueItemApiHandler(game, artifacts)
  const server = createServer(async (request, response) => {
    if (await artifactApi(request, response)) return
    if (await playerApi(request, response)) return
    if (await accountApi(request, response)) return
    response.writeHead(404).end()
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  return {
    game, players, stories, crafting, artifacts,
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

async function createCharacter(api, username, displayName, profession) {
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

test('artifact API requires session and never caches private snapshots', async () => {
  const api = await startApi()
  try {
    const guest = await request(api.base, '/api/artifacts')
    assert.equal(guest.status, 401)
    assert.equal(guest.cacheControl, 'no-store')
    const account = await createCharacter(api, 'artifact_api_user', 'Мастер', 'blacksmith')
    const snapshot = await request(api.base, '/api/artifacts', { cookie: account.cookie })
    assert.equal(snapshot.status, 200)
    assert.equal(snapshot.cacheControl, 'no-store')
    assert.equal(Array.isArray(snapshot.data.owned), true)
    assert.equal(snapshot.data.owned[0].unique, true)
  } finally { await api.close() }
})

test('HTTP forge, listing and purchase transfer one serial instance idempotently', async () => {
  const api = await startApi()
  try {
    const smith = await createCharacter(api, 'artifact_api_smith', 'Добрыня', 'blacksmith')
    const buyer = await createCharacter(api, 'artifact_api_buyer', 'Мирослав', 'hunter')
    api.game.db.prepare('UPDATE player_characters SET coins = 100 WHERE user_id IN (?, ?)').run(smith.userId, buyer.userId)
    api.crafting.addStack(smith.userId, 'scrap-iron', 'Лом железа', 6)
    api.crafting.addStack(smith.userId, 'charcoal', 'Древесный уголь', 3)
    api.crafting.addStack(smith.userId, 'cloth', 'Грубая ткань', 1)

    const forgeBody = { requestId: 'artifact-api-forge-0001' }
    const forged = await request(api.base, '/api/artifacts/blueprints/ash-cleaver/forge', { method: 'POST', cookie: smith.cookie, body: forgeBody })
    const repeatedForge = await request(api.base, '/api/artifacts/blueprints/ash-cleaver/forge', { method: 'POST', cookie: smith.cookie, body: forgeBody })
    assert.equal(forged.status, 200)
    assert.equal(repeatedForge.data.forged.id, forged.data.forged.id)

    const itemId = forged.data.forged.id
    const listBody = { requestId: 'artifact-api-list-0001', unitPrice: 20 }
    const listed = await request(api.base, `/api/artifacts/items/${itemId}/list`, { method: 'POST', cookie: smith.cookie, body: listBody })
    const listing = listed.data.ownListings.find((entry) => entry.status === 'active')
    const buyBody = { requestId: 'artifact-api-buy-0001' }
    const bought = await request(api.base, `/api/artifacts/listings/${listing.id}/buy`, { method: 'POST', cookie: buyer.cookie, body: buyBody })
    const repeatedBuy = await request(api.base, `/api/artifacts/listings/${listing.id}/buy`, { method: 'POST', cookie: buyer.cookie, body: buyBody })

    assert.equal(bought.status, 200)
    assert.deepEqual(repeatedBuy.data, bought.data)
    assert.equal(api.game.db.prepare('SELECT owner_user_id FROM unique_items WHERE id = ?').get(itemId).owner_user_id, buyer.userId)
    assert.equal(api.game.db.prepare('SELECT COUNT(*) AS count FROM unique_items WHERE id = ?').get(itemId).count, 1)
    assert.equal(api.game.db.prepare('SELECT COUNT(*) AS count FROM unique_item_trades WHERE item_id = ?').get(itemId).count, 1)
  } finally { await api.close() }
})
