import test from 'node:test'
import assert from 'node:assert/strict'
import { CraftingStore } from './crafting-store.mjs'
import { installCraftingMigrations } from './crafting-migrations.mjs'
import { EquipmentStore } from './equipment-store.mjs'
import { installMarshCrafting } from './marsh-crafting.mjs'
import { installMarshMigrations } from './marsh-migrations.mjs'
import { installMarshBalanceMigrations, MarshSystem } from './marsh-system.mjs'
import { MarketStore } from './market-store.mjs'
import { PlayerStore } from './player-store.mjs'
import { installRegionFixes } from './region-fixes.mjs'
import { RegionStore } from './region-store.mjs'
import { SquadCombatStore } from './squad-combat-store.mjs'
import { StoryStore } from './story-store.mjs'
import { installSurvivalRewards } from './survival-rewards.mjs'
import { SurvivalStore } from './survival-store.mjs'
import { installUniqueItemFixes } from './unique-item-fixes.mjs'
import { UniqueItemStore } from './unique-item-store.mjs'
import { installV013CombatFixes } from './v013-fixes.mjs'
import { installV013Migrations } from './v013-migrations.mjs'
import { GameStore } from './store.mjs'

let sequence = 0

function setupV012() {
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
  const marshCrafting = installMarshCrafting(game, players, crafting)
  const account = game.register({
    username: `v013_${sequence}`,
    password: '12345678',
    displayName: 'Испытатель строя',
  })
  const userId = account.user.id
  players.createCharacter(userId, {
    requestId: `v013-create-${sequence}-0001`,
    name: 'Вышата',
    profession: 'blacksmith',
  })
  stories.publicStory(userId)
  game.db.prepare("UPDATE player_story_state SET scene_id = 'chapter-end', chapter_complete = 1 WHERE user_id = ?").run(userId)
  game.db.prepare('UPDATE player_characters SET level = 5, stamina = 30, max_stamina = 30, health = 30, max_health = 30, coins = 200 WHERE user_id = ?').run(userId)
  game.db.prepare("INSERT OR IGNORE INTO player_region_progress(user_id, region_id, unlocked_at, victories) VALUES (?, 'ash-road', ?, 3)").run(userId, Date.now())
  regions.unlockRegions(userId)
  return { game, players, stories, survival, crafting, market, artifacts, regions, marshSystem, marshCrafting, userId }
}

function upgradeV013(context) {
  installV013Migrations(context.game.db)
  const equipment = new EquipmentStore(context.game, context.players, context.survival, context.artifacts, context.crafting)
  const combat = new SquadCombatStore(context.game, context.players, context.regions, equipment, context.marshSystem, context.marshCrafting)
  installV013CombatFixes(combat)
  return { ...context, equipment, combat }
}

function makeItem(context, templateId, name, type, slot) {
  const row = context.artifacts.createItem({
    ownerUserId: context.userId,
    templateId,
    name,
    type,
    quality: 'good',
    durability: 50,
    originType: 'test',
    originDetail: templateId,
    tradable: true,
  })
  context.game.db.prepare('UPDATE unique_items SET equipment_slot = ? WHERE id = ?').run(slot, row.id)
  return row.id
}

test('v0.13 migration preserves an existing v0.12 active expedition as single combat', () => {
  const context = setupV012()
  try {
    const offer = context.regions.snapshot(context.userId).contracts.find((item) => item.regionId === 'salt-marsh')
    assert.ok(offer)
    const started = context.players.startExpedition(context.userId, {
      requestId: 'v013-legacy-start-0001',
      contractId: offer.id,
    })
    const runId = started.character.activeExpedition.id
    installV013Migrations(context.game.db)
    const run = context.game.db.prepare('SELECT encounter_type FROM player_expeditions WHERE id = ?').get(runId)
    const enemies = context.game.db.prepare('SELECT COUNT(*) AS count FROM player_expedition_enemies WHERE expedition_id = ?').get(runId)
    assert.equal(run.encounter_type, 'single')
    assert.equal(Number(enemies.count), 0)
  } finally { context.game.close() }
})

test('three equipment slots coexist and runtime trigger wears main hand once after restart repair', () => {
  const context = upgradeV013(setupV012())
  try {
    const weaponId = makeItem(context, 'test-sword', 'Пробный тесак', 'weapon', 'main-hand')
    const armorId = makeItem(context, 'reed-lamellar', 'Пробный ламелляр', 'armor', 'body')
    const charmId = makeItem(context, 'bell-ward', 'Пробный оберег', 'tool', 'charm')
    context.artifacts.equipItem(context.userId, weaponId, { requestId: 'v013-equip-weapon-0001' })
    context.artifacts.equipItem(context.userId, armorId, { requestId: 'v013-equip-armor-0001' })
    context.artifacts.equipItem(context.userId, charmId, { requestId: 'v013-equip-charm-0001' })

    const character = context.players.getCharacter(context.userId)
    assert.equal(character.equipment.mainHand.id, weaponId)
    assert.equal(character.equipment.body.id, armorId)
    assert.equal(character.equipment.charm.id, charmId)
    assert.equal(character.armorRating >= 4, true)

    context.artifacts.installTriggers()
    installV013Migrations(context.game.db)
    const before = context.game.db.prepare('SELECT durability FROM unique_items WHERE id = ?').get(weaponId)
    context.game.db.prepare(`
      INSERT INTO player_action_receipts(user_id, request_id, action, result_json, created_at)
      VALUES (?, 'v013-wear-once-0001', 'expedition:attack:target', '{}', ?)
    `).run(context.userId, Date.now())
    const after = context.game.db.prepare('SELECT durability FROM unique_items WHERE id = ?').get(weaponId)
    const oldTrigger = context.game.db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'trigger' AND name = 'trg_unique_tool_wear'").get()
    assert.equal(Number(before.durability) - Number(after.durability), 1)
    assert.equal(Number(oldTrigger.count), 0)
  } finally { context.game.close() }
})

test('new Salt Marsh contract creates a targetable group and repeated attack preserves one result', () => {
  const context = upgradeV013(setupV012())
  try {
    const offer = context.regions.snapshot(context.userId).contracts.find((item) => item.regionId === 'salt-marsh')
    assert.ok(offer)
    const started = context.players.startExpedition(context.userId, {
      requestId: 'v013-group-start-0001',
      contractId: offer.id,
    })
    const run = started.character.activeExpedition
    assert.equal(run.encounterType, 'group')
    assert.equal(run.enemies.length, 2)
    const target = run.enemies[1]
    context.game.db.prepare('UPDATE player_expedition_enemies SET health = 20, max_health = 20, distance = 0, elevation = 0 WHERE id = ?').run(target.id)
    const before = context.game.db.prepare('SELECT health FROM player_expedition_enemies WHERE id = ?').get(target.id)
    const input = { requestId: 'v013-group-attack-0001', expeditionId: run.id, action: 'attack', targetId: target.id }
    const first = context.players.actExpedition(context.userId, input)
    const repeated = context.players.actExpedition(context.userId, input)
    const after = context.game.db.prepare('SELECT health FROM player_expedition_enemies WHERE id = ?').get(target.id)
    assert.deepEqual(repeated, first)
    assert.equal(Number(after.health) < Number(before.health), true)
    assert.equal(Number(after.health) >= 0, true)
    const receipts = context.game.db.prepare("SELECT COUNT(*) AS count FROM player_action_receipts WHERE user_id = ? AND request_id = 'v013-group-attack-0001'").get(context.userId)
    assert.equal(Number(receipts.count), 1)
  } finally { context.game.close() }
})

test('boss cannot skip phase two and first victory grants one lineage armor', () => {
  const context = upgradeV013(setupV012())
  try {
    context.game.db.prepare(`
      INSERT INTO player_marsh_story_state(
        user_id, generation, scene_id, flags_json, history_json, decision_count,
        started, chapter_complete, ending, updated_at
      ) VALUES (?, 1, 'marsh-afterword', '[]', '[]', 12, 1, 1, 'free-marsh', ?)
    `).run(context.userId, Date.now())
    const boss = context.combat.bossSnapshot(context.userId)
    assert.equal(boss.available, true)
    const begun = context.combat.startBoss(context.userId, { requestId: 'v013-boss-start-0001' })
    const runId = begun.character.activeExpedition.id
    const bossRow = context.game.db.prepare("SELECT * FROM player_expedition_enemies WHERE expedition_id = ? AND enemy_role = 'boss'").get(runId)
    context.game.db.prepare("UPDATE player_expedition_enemies SET status = 'defeated', health = 0 WHERE expedition_id = ? AND enemy_role != 'boss'").run(runId)
    context.game.db.prepare('UPDATE player_expedition_enemies SET health = 1, distance = 0, elevation = 0 WHERE id = ?').run(bossRow.id)
    context.game.db.prepare('UPDATE player_expeditions SET target_enemy_id = ?, hero_elevation = 1 WHERE id = ?').run(bossRow.id, runId)

    context.players.actExpedition(context.userId, {
      requestId: 'v013-boss-phase-0001', expeditionId: runId, action: 'attack', targetId: bossRow.id,
    })
    const phase = context.game.db.prepare('SELECT boss_phase FROM player_expeditions WHERE id = ?').get(runId)
    const liveBoss = context.game.db.prepare("SELECT health, status FROM player_expedition_enemies WHERE id = ?").get(bossRow.id)
    const shadows = context.game.db.prepare("SELECT COUNT(*) AS count FROM player_expedition_enemies WHERE expedition_id = ? AND enemy_key = 'salt-shadow'").get(runId)
    assert.equal(Number(phase.boss_phase), 2)
    assert.equal(liveBoss.status, 'active')
    assert.equal(Number(liveBoss.health) > 0, true)
    assert.equal(Number(shadows.count), 1)

    context.game.db.prepare("UPDATE player_expedition_enemies SET status = 'defeated', health = 0 WHERE expedition_id = ? AND id != ?").run(runId, bossRow.id)
    context.game.db.prepare('UPDATE player_expedition_enemies SET health = 1, distance = 0, elevation = 0 WHERE id = ?').run(bossRow.id)
    const victoryInput = { requestId: 'v013-boss-victory-0001', expeditionId: runId, action: 'attack', targetId: bossRow.id }
    const victory = context.players.actExpedition(context.userId, victoryInput)
    const repeated = context.players.actExpedition(context.userId, victoryInput)
    assert.deepEqual(repeated, victory)
    const progress = context.game.db.prepare('SELECT victories FROM player_boss_progress WHERE user_id = ? AND boss_id = ?').get(context.userId, 'salt-bell-warden')
    const armor = context.game.db.prepare("SELECT COUNT(*) AS count FROM unique_items WHERE lineage_user_id = ? AND origin_type = 'boss-reward' AND origin_detail = 'salt-bell-warden:first-victory'").get(context.userId)
    assert.equal(Number(progress.victories), 1)
    assert.equal(Number(armor.count), 1)
    assert.equal(context.combat.bossSnapshot(context.userId).available, false)
  } finally { context.game.close() }
})
