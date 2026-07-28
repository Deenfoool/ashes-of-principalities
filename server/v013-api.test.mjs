import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createApiHandler } from './api.mjs'
import { CraftingStore } from './crafting-store.mjs'
import { installCraftingMigrations } from './crafting-migrations.mjs'
import { EquipmentStore } from './equipment-store.mjs'
import { installMarshCrafting } from './marsh-crafting.mjs'
import { installMarshMigrations } from './marsh-migrations.mjs'
import { installMarshBalanceMigrations, MarshSystem } from './marsh-system.mjs'
import { MarketStore } from './market-store.mjs'
import { createPlayerApiHandler } from './player-api.mjs'
import { PlayerStore } from './player-store.mjs'
import { installRegionFixes } from './region-fixes.mjs'
import { RegionStore } from './region-store.mjs'
import { SquadCombatStore } from './squad-combat-store.mjs'
import { StoryStore } from './story-store.mjs'
import { installSurvivalRewards } from './survival-rewards.mjs'
import { SurvivalStore } from './survival-store.mjs'
import { installUniqueItemFixes } from './unique-item-fixes.mjs'
import { UniqueItemStore } from './unique-item-store.mjs'
import { createV013ApiHandler } from './v013-api.mjs'
import { installV013CombatFixes } from './v013-fixes.mjs'
import { installV013Migrations } from './v013-migrations.mjs'
import { GameStore } from './store.mjs'

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
  const regions = new RegionStore(game, players)
  installRegionFixes(game.db, regions)
  installMarshMigrations(game.db)
  installMarshBalanceMigrations(game.db)
  const marshSystem = new MarshSystem(game, players)
  const marshCrafting = installMarshCrafting(game, players, crafting)
  installV013Migrations(game.db)
  const equipment = new EquipmentStore(game, players, survival, artifacts, crafting)
  const combat = new SquadCombatStore(game, players, regions, equipment, marshSystem, marshCrafting)
  installV013CombatFixes(combat)

  const bossApi = createV013ApiHandler(game, combat)
  const playerApi = createPlayerApiHandler(game, players, stories, regions)
  const accountApi = createApiHandler(game)
  const server = createServer(async (request, response) => {
    if (await bossApi(request, response)) return
    if (await playerApi(request, response)) return
    if (await accountApi(request, response)) return
    response.writeHead(404).end()
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  return {
    game, players, stories, regions, combat,
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

async function createBossReadyHero(api) {
  const account = await request(api.base, '/api/auth/register', {
    method: 'POST',
    body: { username: 'v013_boss_api', password: '12345678', displayName: 'Звонобор' },
  })
  const created = await request(api.base, '/api/player', {
    method: 'POST',
    cookie: account.cookie,
    body: { requestId: 'v013-api-create-0001', name: 'Звонобор', profession: 'blacksmith' },
  })
  const userId = created.data.character.userId
  api.stories.publicStory(userId)
  api.game.db.prepare("UPDATE player_story_state SET chapter_complete = 1, scene_id = 'chapter-end' WHERE user_id = ?").run(userId)
  api.game.db.prepare('UPDATE player_characters SET level = 5, stamina = 20, max_stamina = 20 WHERE user_id = ?').run(userId)
  api.game.db.prepare("INSERT OR IGNORE INTO player_region_progress(user_id, region_id, unlocked_at, victories) VALUES (?, 'ash-road', ?, 3)").run(userId, Date.now())
  api.regions.unlockRegions(userId)
  api.game.db.prepare(`
    INSERT INTO player_marsh_story_state(
      user_id, generation, scene_id, flags_json, history_json, decision_count,
      started, chapter_complete, ending, updated_at
    ) VALUES (?, 1, 'marsh-afterword', '[]', '[]', 12, 1, 1, 'free-marsh', ?)
  `).run(userId, Date.now())
  return { cookie: account.cookie, userId }
}

test('boss API requires session and private responses are never cached', async () => {
  const api = await startApi()
  try {
    const guest = await request(api.base, '/api/bosses')
    assert.equal(guest.status, 401)
    assert.equal(guest.cacheControl, 'no-store')

    const account = await request(api.base, '/api/auth/register', {
      method: 'POST', body: { username: 'v013_locked_api', password: '12345678', displayName: 'Безымянный' },
    })
    const snapshot = await request(api.base, '/api/bosses', { cookie: account.cookie })
    assert.equal(snapshot.status, 200)
    assert.equal(snapshot.cacheControl, 'no-store')
    assert.equal(snapshot.data.bosses[0].available, false)
  } finally { await api.close() }
})

test('boss start is idempotent and creates one attempt with one three-enemy encounter', async () => {
  const api = await startApi()
  try {
    const hero = await createBossReadyHero(api)
    const before = await request(api.base, '/api/bosses', { cookie: hero.cookie })
    assert.equal(before.data.bosses[0].available, true)

    const body = { requestId: 'v013-api-boss-start-0001' }
    const started = await request(api.base, '/api/bosses/salt-bell-warden/start', {
      method: 'POST', cookie: hero.cookie, body,
    })
    const repeated = await request(api.base, '/api/bosses/salt-bell-warden/start', {
      method: 'POST', cookie: hero.cookie, body,
    })
    assert.equal(started.status, 200)
    assert.deepEqual(repeated.data, started.data)
    assert.equal(started.data.character.activeExpedition.encounterType, 'boss')
    assert.equal(started.data.character.activeExpedition.enemies.length, 3)

    const attempts = api.game.db.prepare('SELECT attempts FROM player_boss_progress WHERE user_id = ? AND boss_id = ?').get(hero.userId, 'salt-bell-warden')
    const runs = api.game.db.prepare("SELECT COUNT(*) AS count FROM player_expeditions WHERE user_id = ? AND boss_id = 'salt-bell-warden'").get(hero.userId)
    const stamina = api.game.db.prepare('SELECT stamina FROM player_characters WHERE user_id = ?').get(hero.userId)
    assert.equal(Number(attempts.attempts), 1)
    assert.equal(Number(runs.count), 1)
    assert.equal(Number(stamina.stamina), 16)
  } finally { await api.close() }
})
