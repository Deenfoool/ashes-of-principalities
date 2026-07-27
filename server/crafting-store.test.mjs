import test from 'node:test'
import assert from 'node:assert/strict'
import { CraftingStore } from './crafting-store.mjs'
import { PlayerStore } from './player-store.mjs'
import { StoryStore } from './story-store.mjs'
import { installSurvivalRewards } from './survival-rewards.mjs'
import { SurvivalStore } from './survival-store.mjs'
import { GameStore, StoreError } from './store.mjs'

function setup(username, profession = 'blacksmith', { createCrafting = true } = {}) {
  const game = new GameStore(':memory:')
  const players = new PlayerStore(game)
  const stories = new StoryStore(game, players)
  const survival = new SurvivalStore(game, players)
  installSurvivalRewards(game.db)
  const account = game.register({ username, password: '12345678', displayName: 'Мастер' })
  players.createCharacter(account.user.id, {
    requestId: `${username}-create-0001`, name: 'Ратибор', profession,
  })
  stories.publicStory(account.user.id)
  game.db.prepare("UPDATE player_story_state SET scene_id = 'tavern' WHERE user_id = ?").run(account.user.id)
  const crafting = createCrafting ? new CraftingStore(game, players, survival) : null
  return { game, players, stories, survival, crafting, userId: account.user.id }
}

function quantity(game, userId, itemId) {
  return Number(game.db.prepare('SELECT quantity FROM player_inventory WHERE user_id = ? AND item_id = ?').get(userId, itemId)?.quantity ?? 0)
}

test('blacksmith crafts a bonus repair kit exactly once per request', () => {
  const context = setup('craft_kit')
  try {
    context.crafting.addStack(context.userId, 'scrap-iron', 'Лом железа', 2)
    context.crafting.addStack(context.userId, 'charcoal', 'Древесный уголь', 1)
    const first = context.crafting.craft(context.userId, 'field-repair-kit', { requestId: 'craft-kit-0001' })
    const repeated = context.crafting.craft(context.userId, 'field-repair-kit', { requestId: 'craft-kit-0001' })

    assert.equal(quantity(context.game, context.userId, 'repair-kit'), 2)
    assert.equal(quantity(context.game, context.userId, 'scrap-iron'), 0)
    assert.equal(quantity(context.game, context.userId, 'charcoal'), 0)
    assert.equal(first.crafted.result, 'Полевой ремкомплект ×2')
    assert.deepEqual(repeated, first)
    assert.equal(context.game.db.prepare('SELECT COUNT(*) AS count FROM player_crafting_history WHERE user_id = ?').get(context.userId).count, 1)
  } finally {
    context.game.close()
  }
})

test('blacksmith reforge consumes materials and persists quality only once', () => {
  const context = setup('craft_reforge')
  try {
    context.game.db.prepare('UPDATE player_characters SET level = 2, coins = 10 WHERE user_id = ?').run(context.userId)
    context.crafting.addStack(context.userId, 'scrap-iron', 'Лом железа', 4)
    context.crafting.addStack(context.userId, 'charcoal', 'Древесный уголь', 2)

    context.crafting.craft(context.userId, 'reforge-good', { requestId: 'reforge-good-0001' })
    context.crafting.craft(context.userId, 'reforge-good', { requestId: 'reforge-good-0001' })

    const tool = context.players.getCharacter(context.userId).equippedItem
    assert.equal(tool.quality, 'good')
    assert.equal(tool.maxDurability, 60)
    assert.equal(tool.durability, 60)
    assert.equal(context.players.getCharacter(context.userId).coins, 4)
  } finally {
    context.game.close()
  }
})

test('profession restrictions are enforced by the server', () => {
  const context = setup('craft_restricted', 'hunter')
  try {
    context.game.db.prepare('UPDATE player_characters SET level = 3, coins = 20 WHERE user_id = ?').run(context.userId)
    context.crafting.addStack(context.userId, 'scrap-iron', 'Лом железа', 8)
    context.crafting.addStack(context.userId, 'charcoal', 'Древесный уголь', 4)
    assert.throws(
      () => context.crafting.craft(context.userId, 'reforge-good', { requestId: 'restricted-0001' }),
      (error) => error instanceof StoreError && error.code === 'recipe-unavailable',
    )
  } finally {
    context.game.close()
  }
})

test('old confirmed expeditions receive materials once during migration', () => {
  const context = setup('craft_migration', 'hunter', { createCrafting: false })
  try {
    const now = Date.now()
    context.game.db.prepare(`
      INSERT INTO player_expeditions(
        id, user_id, contract_id, status, turn, enemy_id, enemy_name,
        enemy_health, enemy_max_health, enemy_intent, last_log_json, started_at, updated_at
      ) VALUES ('historic-win', ?, 'ash-wolf', 'won', 3, 'ash-wolf', 'Пепельный волк',
        0, 11, 'attack', '[]', ?, ?)
    `).run(context.userId, now, now)

    const crafting = new CraftingStore(context.game, context.players, context.survival)
    assert.equal(quantity(context.game, context.userId, 'burnt-hide'), 2)
    assert.equal(quantity(context.game, context.userId, 'charcoal'), 1)
    crafting.claimExistingExpeditions()
    assert.equal(quantity(context.game, context.userId, 'burnt-hide'), 2)
    assert.equal(context.game.db.prepare("SELECT COUNT(*) AS count FROM player_material_claims WHERE expedition_id = 'historic-win'").get().count, 2)
  } finally {
    context.game.close()
  }
})

test('scribe ward is consumed by the next expedition and grants starting guard', () => {
  const context = setup('craft_ward', 'scribe')
  try {
    context.game.db.prepare('UPDATE player_characters SET level = 2 WHERE user_id = ?').run(context.userId)
    context.crafting.addStack(context.userId, 'charcoal', 'Древесный уголь', 2)
    context.crafting.addStack(context.userId, 'river-bone', 'Речная кость', 1)
    context.crafting.addStack(context.userId, 'cloth', 'Грубая ткань', 1)
    context.crafting.craft(context.userId, 'warded-ink', { requestId: 'ward-ink-0001' })
    context.crafting.craft(context.userId, 'inscribe-ward', { requestId: 'ward-use-0001' })

    const started = context.players.startExpedition(context.userId, {
      requestId: 'ward-expedition-0001', contractId: 'ash-wolf',
    })
    assert.equal(started.character.activeExpedition.guard, 3)
    assert.equal(context.game.db.prepare("SELECT COUNT(*) AS count FROM player_effects WHERE user_id = ? AND effect_id = 'path-ward'").get(context.userId).count, 0)
  } finally {
    context.game.close()
  }
})
