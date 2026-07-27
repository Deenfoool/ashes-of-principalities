import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createApiHandler } from './api.mjs'
import { CraftingStore } from './crafting-store.mjs'
import { installCraftingMigrations } from './crafting-migrations.mjs'
import { installMarshCrafting } from './marsh-crafting.mjs'
import { installMarshMigrations } from './marsh-migrations.mjs'
import { createMarshStoryApiHandler } from './marsh-story-api.mjs'
import { MarshStoryStore } from './marsh-story-store.mjs'
import { createMarshSystemApiHandler } from './marsh-system-api.mjs'
import { installMarshBalanceMigrations, MarshSystem } from './marsh-system.mjs'
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
  installMarshMigrations(store.db)
  installMarshBalanceMigrations(store.db)
  const marshSystem = new MarshSystem(store, players)
  installMarshCrafting(store, players, crafting)
  const marshStories = new MarshStoryStore(store, players, stories, regions)
  const marshStoryApi = createMarshStoryApiHandler(store, marshStories)
  const marshSystemApi = createMarshSystemApiHandler(store, marshSystem)
  const playerApi = createPlayerApiHandler(store, players, stories, regions)
  const accountApi = createApiHandler(store)
  const server = createServer(async (request, response) => {
    if (await marshSystemApi(request, response)) return
    if (await marshStoryApi(request, response)) return
    if (await playerApi(request, response)) return
    if (await accountApi(request, response)) return
    response.writeHead(404).end()
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  return {
    store, players, stories, crafting, regions,
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
  return {
    status: response.status,
    data: await response.json(),
    cookie: response.headers.get('set-cookie')?.split(';', 1)[0] ?? cookie ?? null,
    cacheControl: response.headers.get('cache-control'),
  }
}

const rid = () => crypto.randomUUID().replaceAll('-', '')

async function createUnlockedHero(api, username) {
  const account = await request(api.base, '/api/auth/register', {
    method: 'POST', body: { username, password: '12345678', displayName: 'Путник топей' },
  })
  const created = await request(api.base, '/api/player', {
    method: 'POST', cookie: account.cookie,
    body: { requestId: rid(), name: 'Ратибор', profession: 'hunter' },
  })
  const userId = created.data.character.userId
  api.stories.publicStory(userId)
  api.store.db.prepare('UPDATE player_characters SET level = 3, stamina = 20, max_stamina = 20 WHERE user_id = ?').run(userId)
  api.store.db.prepare("INSERT OR IGNORE INTO player_region_progress(user_id, region_id, unlocked_at, victories) VALUES (?, 'ash-road', ?, 3)").run(userId, Date.now())
  api.regions.unlockRegions(userId)
  return { account, userId }
}

test('marsh story API is private and current heir must finish first chapter', async () => {
  const api = await startApi()
  try {
    const guest = await request(api.base, '/api/marsh-story')
    assert.equal(guest.status, 401)
    assert.equal(guest.cacheControl, 'no-store')

    const { account, userId } = await createUnlockedHero(api, 'marsh_locked_heir')
    const locked = await request(api.base, '/api/marsh-story', { cookie: account.cookie })
    assert.equal(locked.status, 200)
    assert.equal(locked.data.marshStory.available, false)

    const blocked = await request(api.base, '/api/marsh-story', {
      method: 'POST', cookie: account.cookie,
      body: { requestId: rid(), choiceId: 'marsh-enter' },
    })
    assert.equal(blocked.status, 409)
    assert.equal(blocked.data.error.code, 'marsh-story-locked')

    api.store.db.prepare("UPDATE player_story_state SET scene_id = 'chapter-end', chapter_complete = 1 WHERE user_id = ?").run(userId)
    const available = await request(api.base, '/api/marsh-story', { cookie: account.cookie })
    assert.equal(available.data.marshStory.available, true)
    assert.equal(available.data.marshStory.scene.id, 'marsh-threshold')
  } finally { await api.close() }
})

test('marsh ending cannot be chosen twice with a new request id', async () => {
  const api = await startApi()
  try {
    const { account, userId } = await createUnlockedHero(api, 'marsh_final_guard')
    api.store.db.prepare("UPDATE player_story_state SET scene_id = 'chapter-end', chapter_complete = 1 WHERE user_id = ?").run(userId)
    await request(api.base, '/api/marsh-story', { cookie: account.cookie })
    api.store.db.prepare(`
      UPDATE player_marsh_story_state SET scene_id = 'salt-house', started = 1,
        chapter_complete = 1, ending = 'free-marsh' WHERE user_id = ?
    `).run(userId)

    const blocked = await request(api.base, '/api/marsh-story', {
      method: 'POST', cookie: account.cookie,
      body: { requestId: rid(), choiceId: 'marsh-council' },
    })
    assert.equal(blocked.status, 409)
    assert.equal(blocked.data.error.code, 'marsh-ending-locked')
    const snapshot = await request(api.base, '/api/marsh-story', { cookie: account.cookie })
    const council = snapshot.data.marshStory.scene.choices.find((choice) => choice.id === 'marsh-council')
    assert.equal(council.available, false)
  } finally { await api.close() }
})

test('tactic HTTP request consumes one trap and is idempotent', async () => {
  const api = await startApi()
  try {
    const { account, userId } = await createUnlockedHero(api, 'marsh_tactic_http')
    api.store.db.prepare("UPDATE player_story_state SET scene_id = 'chapter-end', chapter_complete = 1 WHERE user_id = ?").run(userId)
    api.regions.unlockRegions(userId)
    const rotation = await request(api.base, '/api/player/contracts', { cookie: account.cookie })
    const offer = rotation.data.contracts.find((item) => item.regionId === 'salt-marsh')
    const started = await request(api.base, '/api/player/expeditions', {
      method: 'POST', cookie: account.cookie,
      body: { requestId: rid(), contractId: offer.id },
    })
    api.crafting.addStack(userId, 'reed-snare', 'Тростниковая петля', 2, 'consumable')
    const requestId = rid()
    const body = { requestId, expeditionId: started.data.character.activeExpedition.id, tactic: 'trap' }
    const first = await request(api.base, '/api/player/expeditions/tactic', { method: 'POST', cookie: account.cookie, body })
    const repeated = await request(api.base, '/api/player/expeditions/tactic', { method: 'POST', cookie: account.cookie, body })
    assert.equal(first.status, 200)
    assert.deepEqual(repeated.data, first.data)
    assert.equal(first.cacheControl, 'no-store')
    const remaining = api.store.db.prepare("SELECT quantity FROM player_inventory WHERE user_id = ? AND item_id = 'reed-snare'").get(userId)
    assert.equal(Number(remaining.quantity), 1)
  } finally { await api.close() }
})
