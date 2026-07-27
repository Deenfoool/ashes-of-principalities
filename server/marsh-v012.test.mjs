import test from 'node:test'
import assert from 'node:assert/strict'
import { CraftingStore } from './crafting-store.mjs'
import { installCraftingMigrations } from './crafting-migrations.mjs'
import { installMarshCrafting } from './marsh-crafting.mjs'
import { installMarshMigrations } from './marsh-migrations.mjs'
import { MarshStoryStore } from './marsh-story-store.mjs'
import { installMarshBalanceMigrations, MarshSystem } from './marsh-system.mjs'
import { MarketStore } from './market-store.mjs'
import { PlayerStore } from './player-store.mjs'
import { installRegionFixes } from './region-fixes.mjs'
import { RegionStore } from './region-store.mjs'
import { StoryStore } from './story-store.mjs'
import { installSurvivalRewards } from './survival-rewards.mjs'
import { SurvivalStore } from './survival-store.mjs'
import { installUniqueItemFixes } from './unique-item-fixes.mjs'
import { UniqueItemStore } from './unique-item-store.mjs'
import { GameStore } from './store.mjs'

let sequence = 0

function setup() {
  sequence += 1
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
  installMarshCrafting(game, players, crafting)
  const marshStories = new MarshStoryStore(game, players, stories, regions)
  const account = game.register({
    username: `marsh_v012_${sequence}`,
    password: '12345678',
    displayName: 'Испытатель топей',
  })
  const userId = account.user.id
  players.createCharacter(userId, {
    requestId: `marsh-create-${sequence}-0001`,
    name: 'Ратибор',
    profession: 'hunter',
  })
  stories.publicStory(userId)
  game.db.prepare("UPDATE player_story_state SET scene_id = 'chapter-end', chapter_complete = 1 WHERE user_id = ?").run(userId)
  game.db.prepare('UPDATE player_characters SET level = 3, stamina = 20, max_stamina = 20, coins = 50 WHERE user_id = ?').run(userId)
  game.db.prepare("INSERT OR IGNORE INTO player_region_progress(user_id, region_id, unlocked_at, victories) VALUES (?, 'ash-road', ?, 3)").run(userId, Date.now())
  regions.unlockRegions(userId)
  return { game, players, stories, crafting, regions, marshSystem, marshStories, userId }
}

test('Salt Marsh chapter unlocks, begins idempotently and preserves scene state', () => {
  const context = setup()
  try {
    const initial = context.marshStories.publicStory(context.userId)
    assert.equal(initial.available, true)
    assert.equal(initial.scene.id, 'marsh-threshold')
    assert.equal(initial.started, false)

    const input = { requestId: 'marsh-story-enter-0001', choiceId: 'marsh-enter' }
    const begun = context.marshStories.choose(context.userId, input)
    const repeated = context.marshStories.choose(context.userId, input)
    assert.deepEqual(repeated, begun)
    assert.equal(begun.marshStory.started, true)
    assert.equal(begun.marshStory.scene.id, 'salt-house')
    assert.equal(begun.marshStory.decisionCount, 1)
  } finally { context.game.close() }
})

test('second chapter creates positional story encounter and reconciles victory', () => {
  const context = setup()
  try {
    context.marshStories.choose(context.userId, { requestId: 'marsh-enter-bell-0001', choiceId: 'marsh-enter' })
    context.marshStories.choose(context.userId, { requestId: 'marsh-take-bell-0001', choiceId: 'take-bell-contract' })
    context.marshStories.choose(context.userId, { requestId: 'marsh-wade-bell-0001', choiceId: 'bell-wade' })
    const fight = context.marshStories.choose(context.userId, { requestId: 'marsh-fight-bell-0001', choiceId: 'bell-fight' })
    assert.equal(fight.character.activeExpedition.positional, true)
    assert.equal(fight.character.activeExpedition.regionId, 'salt-marsh')
    assert.equal(fight.character.activeExpedition.enemyId, 'bell-drowner')

    const runId = fight.character.activeExpedition.id
    context.game.db.prepare("UPDATE player_expeditions SET status = 'won', enemy_health = 0 WHERE id = ?").run(runId)
    const reconciled = context.marshStories.publicStory(context.userId)
    assert.equal(reconciled.scene.id, 'bell-verdict')
    assert.equal(reconciled.pendingEncounter, false)
    assert.equal(context.players.getCharacter(context.userId).injuries.some((injury) => injury.kind === 'salt-burn'), true)
  } finally { context.game.close() }
})

test('regional victory grants marsh materials exactly once', () => {
  const context = setup()
  try {
    const offer = context.regions.snapshot(context.userId).contracts.find((item) => item.regionId === 'salt-marsh')
    assert.ok(offer)
    const started = context.players.startExpedition(context.userId, {
      requestId: 'marsh-material-start-0001', contractId: offer.id,
    })
    const runId = started.character.activeExpedition.id
    context.game.db.prepare("UPDATE player_expeditions SET enemy_id = 'brine-wight', enemy_health = 1, distance = 0 WHERE id = ?").run(runId)
    const action = { requestId: 'marsh-material-win-0001', expeditionId: runId, action: 'attack' }
    context.players.actExpedition(context.userId, action)
    context.players.actExpedition(context.userId, action)

    const crystal = context.game.db.prepare("SELECT quantity FROM player_inventory WHERE user_id = ? AND item_id = 'brine-crystal'").get(context.userId)
    const claims = context.game.db.prepare("SELECT COUNT(*) AS count FROM player_material_claims WHERE expedition_id = ? AND item_id = 'brine-crystal:region'").get(runId)
    assert.equal(Number(crystal.quantity) >= 2, true)
    assert.equal(Number(claims.count), 1)
  } finally { context.game.close() }
})

test('trap tactic consumes one snare and repeated request cannot repeat damage', () => {
  const context = setup()
  try {
    const offer = context.regions.snapshot(context.userId).contracts.find((item) => item.regionId === 'salt-marsh')
    const started = context.players.startExpedition(context.userId, {
      requestId: 'marsh-trap-start-0001', contractId: offer.id,
    })
    const runId = started.character.activeExpedition.id
    context.crafting.addStack(context.userId, 'reed-snare', 'Тростниковая петля', 2, 'consumable')
    const before = context.game.db.prepare('SELECT enemy_health FROM player_expeditions WHERE id = ?').get(runId)
    const input = { requestId: 'marsh-trap-action-0001', expeditionId: runId, tactic: 'trap' }
    const first = context.marshSystem.tactic(context.userId, input)
    const repeated = context.marshSystem.tactic(context.userId, input)
    assert.deepEqual(repeated, first)
    const after = context.game.db.prepare('SELECT enemy_health FROM player_expeditions WHERE id = ?').get(runId)
    const snares = context.game.db.prepare("SELECT quantity FROM player_inventory WHERE user_id = ? AND item_id = 'reed-snare'").get(context.userId)
    assert.equal(Number(before.enemy_health) - Number(after.enemy_health), 4)
    assert.equal(Number(snares.quantity), 1)
  } finally { context.game.close() }
})

test('natural recovery lowers injury severity and paid rest accelerates it', () => {
  const context = setup()
  try {
    const now = Date.now()
    context.game.db.prepare(`
      INSERT INTO player_injuries(
        id, user_id, kind, title, severity, status, source, created_at,
        natural_heal_at, recovery_interval, recovery_note
      ) VALUES ('recovery-test', ?, 'deep-cut', 'Глубокий порез', 3, 'active', 'Тест', ?, ?, ?, '')
    `).run(context.userId, now - 1000, now - 1000, 24 * 60 * 60 * 1000)
    const first = context.players.getCharacter(context.userId)
    assert.equal(first.injuries.find((injury) => injury.id === 'recovery-test').severity, 2)

    context.game.db.prepare('UPDATE player_injuries SET natural_heal_at = ? WHERE id = ?').run(Date.now() + 6 * 60 * 60 * 1000, 'recovery-test')
    context.players.rest(context.userId, { requestId: 'marsh-rest-recovery-0001' })
    const afterRest = context.players.getCharacter(context.userId)
    assert.equal(afterRest.injuries.find((injury) => injury.id === 'recovery-test')?.severity ?? 0, 1)
  } finally { context.game.close() }
})
