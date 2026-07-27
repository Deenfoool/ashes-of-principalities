import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createApiHandler } from './api.mjs'
import { CraftingStore } from './crafting-store.mjs'
import { installCraftingMigrations } from './crafting-migrations.mjs'
import { MarketStore } from './market-store.mjs'
import { createPlayerApiHandler } from './player-api.mjs'
import { PlayerStore } from './player-store.mjs'
import { installRegionFixes } from './region-fixes.mjs'
import { RegionStore } from './region-store.mjs'
import { StoryStore } from './story-store.mjs'
import { installSurvivalRewards } from './survival-rewards.mjs'
import { SurvivalStore } from './survival-store.mjs'
import { installUniqueItemFixes } from './unique-item-fixes.mjs'
import { UniqueItemStore } from './unique-item-store.mjs'
import { GameStore } from './store.mjs'

async function startApi() {
  const store = new GameStore(':memory:')
  const players = new PlayerStore(store)
  const stories = new StoryStore(store, players)
  const survival = new SurvivalStore(store, players)
  installSurvivalRewards(store.db)
  const crafting = new CraftingStore(store, players, survival)
  installCraftingMigrations(store.db)
  const market = new MarketStore(store, players)
  const artifacts = new UniqueItemStore(store, players, survival, market)
  installUniqueItemFixes(store.db, artifacts)
  artifacts.patchCrafting(crafting)
  const regions = new RegionStore(store, players)
  installRegionFixes(store.db, regions)
  const playerApi = createPlayerApiHandler(store, players, stories, regions)
  const accountApi = createApiHandler(store)
  const server = createServer(async (request, response) => {
    if (await playerApi(request, response)) return
    if (await accountApi(request, response)) return
    response.writeHead(404).end()
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  return {
    store, players, stories, regions,
    base: `http://127.0.0.1:${address.port}`,
    close: async () => {
      await new Promise((resolve) => server.close(resolve))
      store.close()
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

const rid = () => crypto.randomUUID().replaceAll('-', '')

test('regional contracts require auth but remain readable during chapter', async () => {
  const api = await startApi()
  try {
    const guest = await request(api.base, '/api/player/contracts')
    assert.equal(guest.status, 401)
    assert.equal(guest.cacheControl, 'no-store')

    const account = await request(api.base, '/api/auth/register', {
      method: 'POST', body: { username: 'region_api_user', password: '12345678', displayName: 'Путник' },
    })
    await request(api.base, '/api/player', {
      method: 'POST', cookie: account.cookie,
      body: { requestId: rid(), name: 'Путник', profession: 'hunter' },
    })
    api.stories.publicStory(api.store.db.prepare("SELECT id FROM users WHERE username = 'region_api_user'").get().id)

    const duringChapter = await request(api.base, '/api/player/contracts', { cookie: account.cookie })
    assert.equal(duringChapter.status, 200)
    assert.equal(duringChapter.cacheControl, 'no-store')
    assert.equal(duringChapter.data.contracts.length, 0)
    assert.equal(duringChapter.data.regions.every((region) => region.unlocked === false), true)
  } finally { await api.close() }
})

test('regional offer starts through HTTP and broken tool blocks profession action', async () => {
  const api = await startApi()
  try {
    const account = await request(api.base, '/api/auth/register', {
      method: 'POST', body: { username: 'region_api_fighter', password: '12345678', displayName: 'Охотник' },
    })
    const created = await request(api.base, '/api/player', {
      method: 'POST', cookie: account.cookie,
      body: { requestId: rid(), name: 'Охотник', profession: 'hunter' },
    })
    const userId = created.data.character.userId
    api.stories.publicStory(userId)
    api.store.db.prepare("UPDATE player_story_state SET scene_id = 'tavern', chapter_complete = 1 WHERE user_id = ?").run(userId)
    api.store.db.prepare('UPDATE player_characters SET stamina = 12, max_stamina = 12 WHERE user_id = ?').run(userId)

    const legacyBypass = await request(api.base, '/api/player/expeditions', {
      method: 'POST', cookie: account.cookie,
      body: { requestId: rid(), contractId: 'ash-wolf' },
    })
    assert.equal(legacyBypass.status, 404)
    assert.equal(legacyBypass.data.error.code, 'contract-not-found')

    const rotation = await request(api.base, '/api/player/contracts', { cookie: account.cookie })
    assert.equal(rotation.data.contracts.length, 3)
    const offer = rotation.data.contracts[0]
    const started = await request(api.base, '/api/player/expeditions', {
      method: 'POST', cookie: account.cookie,
      body: { requestId: rid(), contractId: offer.id },
    })
    assert.equal(started.status, 201)
    assert.equal(started.data.character.activeExpedition.positional, true)

    api.store.db.prepare('UPDATE unique_items SET durability = 0 WHERE owner_user_id = ? AND equipped = 1').run(userId)
    const blocked = await request(api.base, '/api/player/expeditions/action', {
      method: 'POST', cookie: account.cookie,
      body: { requestId: rid(), expeditionId: started.data.character.activeExpedition.id, action: 'profession' },
    })
    assert.equal(blocked.status, 409)
    assert.equal(blocked.data.error.code, 'tool-broken')
  } finally { await api.close() }
})
