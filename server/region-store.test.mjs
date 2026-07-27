import test from 'node:test'
import assert from 'node:assert/strict'
import { CraftingStore } from './crafting-store.mjs'
import { installCraftingMigrations } from './crafting-migrations.mjs'
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

function setup({ level = 1, completed = 0 } = {}) {
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
  installRegionFixes(game.db, regions, players)
  const account = game.register({ username: `region_user_${level}_${completed}`, password: '12345678', displayName: 'Ратибор' })
  players.createCharacter(account.user.id, { requestId: 'region-create-hero-0001', name: 'Ратибор', profession: 'hunter' })
  stories.publicStory(account.user.id)
  game.db.prepare("UPDATE player_story_state SET scene_id = 'tavern', chapter_complete = 1 WHERE user_id = ?").run(account.user.id)
  game.db.prepare('UPDATE player_characters SET level = ?, completed_contracts = ?, stamina = 12, max_stamina = 12 WHERE user_id = ?').run(level, completed, account.user.id)
  return { game, players, stories, regions, account }
}

test('daily authored offers are stable and second region remains locked early', () => {
  const context = setup()
  try {
    const first = context.regions.snapshot(context.account.user.id)
    const repeated = context.regions.snapshot(context.account.user.id)
    assert.equal(first.contracts.length, 3)
    assert.deepEqual(repeated.contracts.map((contract) => contract.id), first.contracts.map((contract) => contract.id))
    assert.equal(first.regions.find((region) => region.id === 'ash-road').unlocked, true)
    assert.equal(first.regions.find((region) => region.id === 'salt-marsh').unlocked, false)
    assert.equal(new Set(first.contracts.map((contract) => contract.id)).size, 3)
  } finally { context.game.close() }
})

test('salt marsh unlocks permanently at level three after three contracts', () => {
  const context = setup({ level: 3, completed: 3 })
  try {
    const snapshot = context.regions.snapshot(context.account.user.id)
    assert.equal(snapshot.regions.find((region) => region.id === 'salt-marsh').unlocked, true)
    assert.equal(snapshot.contracts.filter((contract) => contract.regionId === 'salt-marsh').length, 3)
    context.game.db.prepare('UPDATE player_characters SET level = 1, completed_contracts = 0 WHERE user_id = ?').run(context.account.user.id)
    assert.equal(context.regions.snapshot(context.account.user.id).regions.find((region) => region.id === 'salt-marsh').unlocked, true)
  } finally { context.game.close() }
})

test('regional start and movement are idempotent and expose distance', () => {
  const context = setup({ level: 3, completed: 3 })
  try {
    const offer = context.regions.snapshot(context.account.user.id).contracts[0]
    const startInput = { requestId: 'region-start-offer-0001', contractId: offer.id }
    const started = context.players.startExpedition(context.account.user.id, startInput)
    const repeatedStart = context.players.startExpedition(context.account.user.id, startInput)
    assert.deepEqual(repeatedStart, started)
    assert.equal(started.character.activeExpedition.positional, true)
    assert.equal(started.character.activeExpedition.regionId, offer.regionId)

    const runId = started.character.activeExpedition.id
    context.game.db.prepare('UPDATE player_expeditions SET distance = 1, max_distance = 2 WHERE id = ?').run(runId)
    const beforeStamina = context.players.getCharacter(context.account.user.id).stamina
    const moveInput = { requestId: 'region-retreat-action-0001', expeditionId: runId, action: 'retreat' }
    const moved = context.players.actExpedition(context.account.user.id, moveInput)
    const repeatedMove = context.players.actExpedition(context.account.user.id, moveInput)
    assert.deepEqual(repeatedMove, moved)
    assert.equal(context.players.getCharacter(context.account.user.id).activeExpedition.distance, 2)
    assert.equal(context.players.getCharacter(context.account.user.id).stamina, beforeStamina - 1)
  } finally { context.game.close() }
})

test('confirmed profession action replays after its final durability point breaks', () => {
  const context = setup({ level: 3, completed: 3 })
  try {
    const offer = context.regions.snapshot(context.account.user.id).contracts[0]
    const started = context.players.startExpedition(context.account.user.id, { requestId: 'region-break-start-0001', contractId: offer.id })
    const runId = started.character.activeExpedition.id
    context.game.db.prepare('UPDATE player_expeditions SET enemy_health = 100, enemy_max_health = 100, distance = 2, max_distance = 3 WHERE id = ?').run(runId)
    context.game.db.prepare('UPDATE unique_items SET durability = 1 WHERE owner_user_id = ? AND equipped = 1').run(context.account.user.id)
    const input = { requestId: 'region-break-profession-0001', expeditionId: runId, action: 'profession' }
    const first = context.players.actExpedition(context.account.user.id, input)
    assert.equal(context.game.db.prepare('SELECT durability FROM unique_items WHERE owner_user_id = ? AND equipped = 1').get(context.account.user.id).durability, 0)
    const repeated = context.players.actExpedition(context.account.user.id, input)
    assert.deepEqual(repeated, first)
  } finally { context.game.close() }
})

test('regional victory closes one offer and counts one victory only', () => {
  const context = setup({ level: 3, completed: 3 })
  try {
    const offer = context.regions.snapshot(context.account.user.id).contracts[0]
    const started = context.players.startExpedition(context.account.user.id, { requestId: 'region-win-start-0001', contractId: offer.id })
    const runId = started.character.activeExpedition.id
    context.game.db.prepare('UPDATE player_expeditions SET enemy_health = 1, distance = 0 WHERE id = ?').run(runId)
    const input = { requestId: 'region-win-action-0001', expeditionId: runId, action: 'attack' }
    const won = context.players.actExpedition(context.account.user.id, input)
    const repeated = context.players.actExpedition(context.account.user.id, input)
    assert.deepEqual(repeated, won)
    assert.equal(context.game.db.prepare('SELECT status FROM player_contract_offers WHERE id = ?').get(offer.id).status, 'won')
    assert.equal(context.game.db.prepare('SELECT victories FROM player_region_progress WHERE user_id = ? AND region_id = ?').get(context.account.user.id, offer.regionId).victories, 1)
    assert.equal(context.players.getCharacter(context.account.user.id).completedContracts, 4)
  } finally { context.game.close() }
})

test('legacy static expedition survives migration and keeps old combat rules', () => {
  const context = setup()
  try {
    const started = context.players.startExpedition(context.account.user.id, { requestId: 'legacy-start-0001', contractId: 'ash-wolf' })
    assert.equal(Boolean(started.character.activeExpedition.positional), false)
    const result = context.players.actExpedition(context.account.user.id, {
      requestId: 'legacy-attack-0001', expeditionId: started.character.activeExpedition.id, action: 'attack',
    })
    assert.equal(result.character.activeExpedition.enemyHealth < result.character.activeExpedition.enemyMaxHealth, true)
  } finally { context.game.close() }
})
