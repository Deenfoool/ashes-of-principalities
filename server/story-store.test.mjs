import test from 'node:test'
import assert from 'node:assert/strict'
import { GameStore, StoreError } from './store.mjs'
import { PlayerStore } from './player-store.mjs'
import { StoryStore } from './story-store.mjs'

function setup(username = 'story_user', profession = 'hunter') {
  const game = new GameStore(':memory:')
  const account = game.register({ username, password: '12345678', displayName: 'Летописец' })
  const players = new PlayerStore(game)
  const stories = new StoryStore(game, players)
  players.createCharacter(account.user.id, {
    requestId: `${username}:create:0001`,
    name: 'Мирослав',
    profession,
  })
  return { game, players, stories, userId: account.user.id }
}

function choose(stories, userId, choiceId, serial) {
  return stories.choose(userId, { choiceId, requestId: `story:${serial}:request` })
}

test('story starts at crossroads and repeated request is idempotent', () => {
  const context = setup('story_idempotent')
  try {
    const initial = context.stories.publicStory(context.userId)
    assert.equal(initial.scene.id, 'crossroads')
    assert.equal(initial.quests.length, 3)
    const first = choose(context.stories, context.userId, 'inspect-cart', 'inspect-0001')
    const second = choose(context.stories, context.userId, 'inspect-cart', 'inspect-0001')
    assert.equal(first.story.scene.id, 'cart')
    assert.deepEqual(second, first)
    assert.equal(first.story.decisionCount, 1)
    assert.equal(first.character.coins, 5)
    assert.equal(first.character.inventory.some((item) => item.id === 'dry-ration'), true)
  } finally {
    context.game.close()
  }
})

test('profession requirements are enforced by the server', () => {
  const context = setup('story_profession', 'hunter')
  try {
    choose(context.stories, context.userId, 'inspect-cart', 'profession-0001')
    assert.throws(
      () => choose(context.stories, context.userId, 'repair-trace', 'profession-0002'),
      (error) => error instanceof StoreError && error.code === 'choice-unavailable',
    )
  } finally {
    context.game.close()
  }
})

test('non-combat moral outcome completes a contract exactly once', () => {
  const context = setup('story_truth', 'scribe')
  try {
    choose(context.stories, context.userId, 'enter-village', 'truth-0001')
    choose(context.stories, context.userId, 'study-record', 'truth-0002')
    choose(context.stories, context.userId, 'taxman-contract', 'truth-0003')
    choose(context.stories, context.userId, 'tax-ledger', 'truth-0004')
    choose(context.stories, context.userId, 'tax-expose', 'truth-0005')
    const completed = choose(context.stories, context.userId, 'tax-publish', 'truth-0006')
    const repeated = choose(context.stories, context.userId, 'tax-publish', 'truth-0006')
    assert.equal(completed.story.quests.find((quest) => quest.id === 'taxman').status, 'completed')
    assert.equal(completed.character.completedContracts, 1)
    assert.deepEqual(repeated, completed)
  } finally {
    context.game.close()
  }
})

test('story combat resolves into the verdict without double-counting the contract', () => {
  const context = setup('story_combat', 'blacksmith')
  try {
    choose(context.stories, context.userId, 'enter-village', 'combat-0001')
    choose(context.stories, context.userId, 'state-trade', 'combat-0002')
    choose(context.stories, context.userId, 'beast-contract', 'combat-0003')
    choose(context.stories, context.userId, 'beast-ask', 'combat-0004')
    const started = choose(context.stories, context.userId, 'beast-fight', 'combat-0005')
    let character = started.character
    let turn = 0
    while (character.activeExpedition && turn < 10) {
      character = context.players.actExpedition(context.userId, {
        requestId: `combat-action-${turn}:0001`,
        expeditionId: character.activeExpedition.id,
        action: 'profession',
      }).character
      turn += 1
    }
    assert.equal(character.alive, true)
    assert.equal(character.activeExpedition, null)
    const verdict = context.stories.publicStory(context.userId)
    assert.equal(verdict.scene.id, 'beast-verdict')
    const outcome = choose(context.stories, context.userId, 'beast-trophy', 'combat-0006')
    assert.equal(outcome.story.quests.find((quest) => quest.id === 'beast').status, 'completed')
    assert.equal(outcome.character.completedContracts, 1)
  } finally {
    context.game.close()
  }
})

test('an heir receives a fresh chapter for the new generation', () => {
  const context = setup('story_heir', 'hunter')
  try {
    choose(context.stories, context.userId, 'enter-village', 'heir-0001')
    context.game.db.prepare(`
      UPDATE player_characters SET alive = 0, health = 0, legacy_glory = 12 WHERE user_id = ?
    `).run(context.userId)
    context.players.createHeir(context.userId, {
      requestId: 'heir-create-0001',
      name: 'Ратибор',
      profession: 'carter',
    })
    const reset = context.stories.publicStory(context.userId)
    assert.equal(reset.generation, 2)
    assert.equal(reset.scene.id, 'crossroads')
    assert.equal(reset.quests.every((quest) => quest.status === 'available'), true)
  } finally {
    context.game.close()
  }
})
