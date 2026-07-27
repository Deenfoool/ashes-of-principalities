import test from 'node:test'
import assert from 'node:assert/strict'
import { GameStore } from './store.mjs'
import { PlayerStore } from './player-store.mjs'
import { StoryStore } from './story-store.mjs'
import { SurvivalStore } from './survival-store.mjs'

function setup(username = 'survival_user', profession = 'hunter') {
  const game = new GameStore(':memory:')
  const players = new PlayerStore(game)
  const stories = new StoryStore(game, players)
  const survival = new SurvivalStore(game, players)
  const account = game.register({ username, password: '12345678', displayName: 'Выживший' })
  players.createCharacter(account.user.id, {
    requestId: `${username}-create-0001`,
    name: 'Ратибор',
    profession,
  })
  stories.publicStory(account.user.id)
  return { game, players, stories, survival, userId: account.user.id }
}

test('starter tool has quality and loses durability only once per request', () => {
  const context = setup('survival_wear', 'hunter')
  try {
    const initial = context.players.getCharacter(context.userId)
    assert.equal(initial.equippedItem.id, 'short-bow')
    assert.equal(initial.equippedItem.quality, 'common')
    assert.equal(initial.equippedItem.durability, 40)

    const started = context.players.startExpedition(context.userId, {
      requestId: 'wear-start-0001', contractId: 'ash-wolf',
    }).character
    const action = {
      requestId: 'wear-action-0001',
      expeditionId: started.activeExpedition.id,
      action: 'attack',
    }
    const first = context.players.actExpedition(context.userId, action).character
    const repeated = context.players.actExpedition(context.userId, action).character
    assert.equal(first.equippedItem.durability, 39)
    assert.equal(repeated.equippedItem.durability, 39)
  } finally {
    context.game.close()
  }
})

test('health thresholds create persistent injuries with combat penalties', () => {
  const context = setup('survival_injury', 'hunter')
  try {
    context.game.db.prepare('UPDATE player_characters SET health = 4 WHERE user_id = ?').run(context.userId)
    let character = context.players.getCharacter(context.userId)
    assert.equal(character.injuries.some((injury) => injury.kind === 'wounded-arm'), true)
    assert.equal(character.combatModifiers.attackStaminaPenalty, 1)

    context.game.db.prepare('UPDATE player_characters SET health = 2 WHERE user_id = ?').run(context.userId)
    character = context.players.getCharacter(context.userId)
    assert.equal(character.injuries.some((injury) => injury.kind === 'sprained-ankle'), true)
    assert.equal(character.combatModifiers.fleeStaminaPenalty, 2)
  } finally {
    context.game.close()
  }
})

test('repair and treatment charge once and return current server character', () => {
  const context = setup('survival_care', 'herbalist')
  try {
    context.game.db.prepare("UPDATE player_story_state SET scene_id = 'tavern' WHERE user_id = ?").run(context.userId)
    context.game.db.prepare('UPDATE player_characters SET coins = 30, health = 4 WHERE user_id = ?').run(context.userId)
    context.game.db.prepare("UPDATE player_inventory SET durability = 10 WHERE user_id = ? AND item_id = 'herb-satchel'").run(context.userId)

    const repaired = context.survival.repairItem(context.userId, 'herb-satchel', { requestId: 'repair-care-0001' })
    const repeatedRepair = context.survival.repairItem(context.userId, 'herb-satchel', { requestId: 'repair-care-0001' })
    assert.equal(repaired.character.equippedItem.durability, 40)
    assert.equal(repeatedRepair.character.coins, repaired.character.coins)

    const injury = context.players.getCharacter(context.userId).injuries[0]
    const treated = context.survival.treatInjury(context.userId, injury.id, { requestId: 'treat-care-0001' })
    const repeatedTreatment = context.survival.treatInjury(context.userId, injury.id, { requestId: 'treat-care-0001' })
    assert.equal(treated.character.injuries.length, 0)
    assert.equal(repeatedTreatment.character.coins, treated.character.coins)
  } finally {
    context.game.close()
  }
})

test('guild founding consumes server coins and the founder seal atomically', () => {
  const context = setup('survival_guild', 'blacksmith')
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

    const input = { requestId: 'guild-found-0001', name: 'Серые вороны', tag: 'СВ' }
    const created = context.survival.createPaidGuild(context.userId, input)
    const repeated = context.survival.createPaidGuild(context.userId, input)
    assert.equal(created.guild.name, 'Серые вороны')
    assert.equal(created.character.coins, 8)
    assert.equal(created.character.inventory.some((item) => item.id === 'founder-seal'), false)
    assert.deepEqual(repeated, created)
    assert.equal(context.game.getGuildForUser(context.userId).memberCount, 1)
  } finally {
    context.game.close()
  }
})