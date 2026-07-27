import test from 'node:test'
import assert from 'node:assert/strict'
import { GameStore } from './store.mjs'
import { PlayerStore } from './player-store.mjs'
import { StoryStore } from './story-store.mjs'
import { SurvivalStore } from './survival-store.mjs'
import { installSurvivalRewards } from './survival-rewards.mjs'

function setup(username) {
  const game = new GameStore(':memory:')
  const players = new PlayerStore(game)
  const stories = new StoryStore(game, players)
  const survival = new SurvivalStore(game, players)
  installSurvivalRewards(game.db)
  const account = game.register({ username, password: '12345678', displayName: 'Награждённый' })
  players.createCharacter(account.user.id, {
    requestId: `${username}-create-0001`, name: 'Мирослав', profession: 'blacksmith',
  })
  stories.publicStory(account.user.id)
  return { game, players, stories, survival, userId: account.user.id }
}

test('chapter completion awards one good durable tool that can be equipped', () => {
  const context = setup('reward_chapter')
  try {
    context.game.db.prepare('UPDATE player_story_state SET chapter_complete = 1 WHERE user_id = ?').run(context.userId)
    let character = context.players.getCharacter(context.userId)
    const blade = character.inventory.find((item) => item.id === 'road-blade')
    assert.equal(blade.quality, 'good')
    assert.equal(blade.durability, 60)
    assert.equal(blade.maxDurability, 60)
    assert.equal(blade.equipped, false)

    character = context.survival.equipItem(context.userId, 'road-blade', { requestId: 'reward-equip-0001' }).character
    assert.equal(character.equippedItem.id, 'road-blade')
    assert.equal(character.inventory.find((item) => item.id === 'smith-hammer').equipped, false)
  } finally {
    context.game.close()
  }
})

test('a founder seal consumed by guild creation is not restored by migration', () => {
  const context = setup('reward_seal')
  try {
    const now = Date.now()
    context.game.db.prepare(`
      INSERT INTO player_story_quests(user_id, quest_id, status, outcome, contract_counted, started_at)
      VALUES (?, 'taxman', 'active', NULL, 0, ?)
    `).run(context.userId, now)
    context.game.db.prepare(`
      UPDATE player_story_quests SET status = 'completed', outcome = 'law', completed_at = ?
      WHERE user_id = ? AND quest_id = 'taxman'
    `).run(now, context.userId)
    context.game.db.prepare('UPDATE player_characters SET coins = 20 WHERE user_id = ?').run(context.userId)

    context.survival.createPaidGuild(context.userId, {
      requestId: 'reward-guild-0001', name: 'Одинокий костёр', tag: 'ОК',
    })
    assert.equal(context.players.getCharacter(context.userId).inventory.some((item) => item.id === 'founder-seal'), false)

    context.game.db.prepare(`
      INSERT OR IGNORE INTO player_inventory(
        user_id, item_id, item_name, quantity, item_type, quality,
        durability, max_durability, equipped, repair_count
      ) VALUES (?, 'founder-seal', 'Печать основателя', 1, 'quest', 'good', 0, 0, 0, 0)
    `).run(context.userId)
    installSurvivalRewards(context.game.db)

    assert.equal(context.players.getCharacter(context.userId).inventory.some((item) => item.id === 'founder-seal'), false)
    assert.equal(
      context.game.db.prepare("SELECT COUNT(*) AS count FROM player_reward_claims WHERE user_id = ? AND reward_id = 'founder-seal-consumed'").get(context.userId).count,
      1,
    )
  } finally {
    context.game.close()
  }
})