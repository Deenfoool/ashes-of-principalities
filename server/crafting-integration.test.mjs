import test from 'node:test'
import assert from 'node:assert/strict'
import { installCraftingMigrations } from './crafting-migrations.mjs'
import { CraftingStore } from './crafting-store.mjs'
import { PlayerStore } from './player-store.mjs'
import { StoryStore } from './story-store.mjs'
import { installSurvivalRewards } from './survival-rewards.mjs'
import { SurvivalStore } from './survival-store.mjs'
import { GameStore } from './store.mjs'

function setup(username, profession = 'scribe') {
  const game = new GameStore(':memory:')
  const players = new PlayerStore(game)
  const stories = new StoryStore(game, players)
  const survival = new SurvivalStore(game, players)
  installSurvivalRewards(game.db)
  const account = game.register({ username, password: '12345678', displayName: 'Промысловик' })
  players.createCharacter(account.user.id, {
    requestId: `${username}-create-0001`, name: 'Яромир', profession,
  })
  stories.publicStory(account.user.id)
  game.db.prepare("UPDATE player_story_state SET scene_id = 'tavern' WHERE user_id = ?").run(account.user.id)
  const crafting = new CraftingStore(game, players, survival)
  installCraftingMigrations(game.db)
  return { game, players, stories, survival, crafting, userId: account.user.id }
}

function quantity(game, userId, itemId) {
  return Number(game.db.prepare('SELECT quantity FROM player_inventory WHERE user_id = ? AND item_id = ?').get(userId, itemId)?.quantity ?? 0)
}

test('crafting lifecycle migration is recorded once and clears temporary effects for an heir', () => {
  const context = setup('craft_lifecycle')
  try {
    context.game.db.prepare(`
      INSERT INTO player_effects(user_id, effect_id, charges, updated_at)
      VALUES (?, 'path-ward', 2, ?)
    `).run(context.userId, Date.now())

    context.game.db.prepare('UPDATE player_characters SET generation = generation + 1 WHERE user_id = ?').run(context.userId)
    installCraftingMigrations(context.game.db)

    assert.equal(context.game.db.prepare('SELECT COUNT(*) AS count FROM player_effects WHERE user_id = ?').get(context.userId).count, 0)
    assert.equal(context.game.db.prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE id = '007_crafting_lifecycle'").get().count, 1)
  } finally {
    context.game.close()
  }
})

test('guild foraging branch adds materials without allowing duplicate claims', () => {
  const context = setup('craft_foraging', 'hunter')
  try {
    const now = Date.now()
    context.game.db.prepare('UPDATE player_characters SET coins = 20 WHERE user_id = ?').run(context.userId)
    context.game.db.prepare(`
      INSERT INTO player_inventory(
        user_id, item_id, item_name, quantity, item_type, quality,
        durability, max_durability, equipped, repair_count
      ) VALUES (?, 'founder-seal', 'Печать основателя', 1, 'quest', 'good', 0, 0, 0, 0)
    `).run(context.userId)
    const founded = context.survival.createPaidGuild(context.userId, {
      requestId: 'foraging-guild-0001', name: 'Лесные следы', tag: 'ЛС',
    })
    context.game.db.prepare('UPDATE guilds SET foraging = 3 WHERE id = ?').run(founded.guild.id)

    context.game.db.prepare(`
      INSERT INTO player_expeditions(
        id, user_id, contract_id, status, turn, enemy_id, enemy_name,
        enemy_health, enemy_max_health, enemy_intent, last_log_json, started_at, updated_at
      ) VALUES ('foraging-win', ?, 'ash-wolf', 'won', 3, 'ash-wolf', 'Пепельный волк',
        0, 11, 'attack', '[]', ?, ?)
    `).run(context.userId, now, now)

    const first = context.crafting.claimExpeditionMaterials(context.userId, 'foraging-win')
    const second = context.crafting.claimExpeditionMaterials(context.userId, 'foraging-win')

    assert.equal(first.find((item) => item.id === 'burnt-hide').quantity, 4)
    assert.equal(quantity(context.game, context.userId, 'burnt-hide'), 4)
    assert.equal(quantity(context.game, context.userId, 'charcoal'), 1)
    assert.deepEqual(second, [])
  } finally {
    context.game.close()
  }
})

test('historical victories are normalized to base drops before current guild bonuses begin', () => {
  const game = new GameStore(':memory:')
  const players = new PlayerStore(game)
  const stories = new StoryStore(game, players)
  const survival = new SurvivalStore(game, players)
  installSurvivalRewards(game.db)
  try {
    const account = game.register({ username: 'craft_history_guild', password: '12345678', displayName: 'Старый охотник' })
    players.createCharacter(account.user.id, {
      requestId: 'history-guild-create-0001', name: 'Лютобор', profession: 'hunter',
    })
    stories.publicStory(account.user.id)
    game.db.prepare("UPDATE player_story_state SET scene_id = 'tavern' WHERE user_id = ?").run(account.user.id)
    game.db.prepare('UPDATE player_characters SET coins = 20 WHERE user_id = ?').run(account.user.id)
    game.db.prepare(`
      INSERT INTO player_inventory(
        user_id, item_id, item_name, quantity, item_type, quality,
        durability, max_durability, equipped, repair_count
      ) VALUES (?, 'founder-seal', 'Печать основателя', 1, 'quest', 'good', 0, 0, 0, 0)
    `).run(account.user.id)
    const founded = survival.createPaidGuild(account.user.id, {
      requestId: 'history-guild-found-0001', name: 'Старый промысел', tag: 'СП',
    })
    game.db.prepare('UPDATE guilds SET foraging = 3 WHERE id = ?').run(founded.guild.id)

    const now = Date.now()
    game.db.prepare(`
      INSERT INTO player_expeditions(
        id, user_id, contract_id, status, turn, enemy_id, enemy_name,
        enemy_health, enemy_max_health, enemy_intent, last_log_json, started_at, updated_at
      ) VALUES ('historical-foraging-win', ?, 'ash-wolf', 'won', 3, 'ash-wolf', 'Пепельный волк',
        0, 11, 'attack', '[]', ?, ?)
    `).run(account.user.id, now, now)

    new CraftingStore(game, players, survival)
    assert.equal(quantity(game, account.user.id, 'burnt-hide'), 4)

    installCraftingMigrations(game.db)
    installCraftingMigrations(game.db)

    assert.equal(quantity(game, account.user.id, 'burnt-hide'), 2)
    assert.equal(quantity(game, account.user.id, 'charcoal'), 1)
    assert.equal(game.db.prepare(`
      SELECT quantity FROM player_material_claims
      WHERE expedition_id = 'historical-foraging-win' AND item_id = 'burnt-hide'
    `).get().quantity, 2)
  } finally {
    game.close()
  }
})
