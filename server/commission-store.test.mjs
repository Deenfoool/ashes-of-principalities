import test from 'node:test'
import assert from 'node:assert/strict'
import { CommissionStore } from './commission-store.mjs'
import { CraftingStore } from './crafting-store.mjs'
import { MarketStore } from './market-store.mjs'
import { PlayerStore } from './player-store.mjs'
import { StoryStore } from './story-store.mjs'
import { installSurvivalRewards } from './survival-rewards.mjs'
import { SurvivalStore } from './survival-store.mjs'
import { GameStore, StoreError } from './store.mjs'

function createAccount(game, players, stories, username, displayName, profession) {
  const account = game.register({ username, password: '12345678', displayName })
  players.createCharacter(account.user.id, { requestId: `${username}-hero-0001`, name: displayName, profession })
  stories.publicStory(account.user.id)
  game.db.prepare("UPDATE player_story_state SET scene_id = 'tavern' WHERE user_id = ?").run(account.user.id)
  return account
}
function setup() {
  const game = new GameStore(':memory:')
  const players = new PlayerStore(game)
  const stories = new StoryStore(game, players)
  const survival = new SurvivalStore(game, players)
  installSurvivalRewards(game.db)
  const crafting = new CraftingStore(game, players, survival)
  const market = new MarketStore(game, players)
  const commissions = new CommissionStore(game, players, market)
  const requester = createAccount(game, players, stories, 'order_buyer', 'Велимир', 'hunter')
  const smith = createAccount(game, players, stories, 'order_smith', 'Добрыня', 'blacksmith')
  const herbalist = createAccount(game, players, stories, 'order_herbal', 'Злата', 'herbalist')
  game.db.prepare('UPDATE player_characters SET coins = 100 WHERE user_id = ?').run(requester.user.id)
  return { game, players, crafting, market, commissions, requester, smith, herbalist }
}
function quantity(game, userId, itemId) {
  return Number(game.db.prepare('SELECT quantity FROM player_inventory WHERE user_id = ? AND item_id = ?').get(userId, itemId)?.quantity ?? 0)
}

test('targeted commission reserves reward and fulfills exactly once', () => {
  const context = setup()
  try {
    context.crafting.addStack(context.smith.user.id, 'scrap-iron', 'Лом железа', 4)
    context.crafting.addStack(context.smith.user.id, 'charcoal', 'Древесный уголь', 2)
    const order = context.commissions.createOrder(context.requester.user.id, {
      requestId: 'commission-create-0001', recipeId: 'field-repair-kit', batches: 2,
      rewardCoins: 40, targetUsername: 'order_smith',
    }).mine[0]
    assert.equal(context.players.getCharacter(context.requester.user.id).coins, 60)
    assert.equal(order.output.quantity, 4)
    assert.equal(order.targetName, 'Добрыня')
    assert.throws(
      () => context.commissions.fulfillOrder(context.herbalist.user.id, order.id, { requestId: 'commission-wrong-0001' }),
      (error) => error instanceof StoreError && error.code === 'commission-unavailable',
    )
    const input = { requestId: 'commission-fulfill-0001' }
    const fulfilled = context.commissions.fulfillOrder(context.smith.user.id, order.id, input)
    const repeated = context.commissions.fulfillOrder(context.smith.user.id, order.id, input)
    assert.equal(quantity(context.game, context.requester.user.id, 'repair-kit'), 4)
    assert.equal(quantity(context.game, context.smith.user.id, 'scrap-iron'), 0)
    assert.equal(context.players.getCharacter(context.smith.user.id).coins, 43)
    assert.equal(fulfilled.fulfillment.feeCoins, 1)
    assert.deepEqual(repeated, fulfilled)
  } finally { context.game.close() }
})

test('cancel and expiry refund reserved coins only once', () => {
  const context = setup()
  try {
    const first = context.commissions.createOrder(context.requester.user.id, {
      requestId: 'commission-create-0002', recipeId: 'traveler-kit', batches: 1, rewardCoins: 10,
    }).mine[0]
    const cancelled = context.commissions.cancelOrder(context.requester.user.id, first.id, { requestId: 'commission-cancel-0001' })
    const repeated = context.commissions.cancelOrder(context.requester.user.id, first.id, { requestId: 'commission-cancel-0001' })
    assert.equal(context.players.getCharacter(context.requester.user.id).coins, 100)
    assert.equal(cancelled.mine[0].status, 'cancelled')
    assert.deepEqual(repeated, cancelled)
    const second = context.commissions.createOrder(context.requester.user.id, {
      requestId: 'commission-create-0003', recipeId: 'traveler-kit', batches: 1, rewardCoins: 12,
    }).mine.find((order) => order.status === 'open')
    context.game.db.prepare('UPDATE craft_commissions SET expires_at = 0 WHERE id = ?').run(second.id)
    context.commissions.snapshot(context.requester.user.id)
    context.commissions.snapshot(context.requester.user.id)
    assert.equal(context.players.getCharacter(context.requester.user.id).coins, 100)
    assert.equal(context.game.db.prepare('SELECT status FROM craft_commissions WHERE id = ?').get(second.id).status, 'expired')
  } finally { context.game.close() }
})

test('commission delivery survives requester death and reaches the heir', () => {
  const context = setup()
  try {
    context.crafting.addStack(context.smith.user.id, 'scrap-iron', 'Лом железа', 2)
    context.crafting.addStack(context.smith.user.id, 'charcoal', 'Древесный уголь', 1)
    const order = context.commissions.createOrder(context.requester.user.id, {
      requestId: 'commission-create-0004', recipeId: 'field-repair-kit', batches: 1, rewardCoins: 10,
    }).mine[0]
    context.game.db.prepare('UPDATE player_characters SET alive = 0, health = 0 WHERE user_id = ?').run(context.requester.user.id)
    context.commissions.fulfillOrder(context.smith.user.id, order.id, { requestId: 'commission-fulfill-0002' })
    assert.equal(quantity(context.game, context.requester.user.id, 'repair-kit'), 0)
    assert.equal(context.game.db.prepare('SELECT quantity FROM market_pending_items WHERE user_id = ? AND item_id = ?').get(context.requester.user.id, 'repair-kit').quantity, 2)
    context.players.createHeir(context.requester.user.id, { requestId: 'commission-heir-0001', name: 'Наследник', profession: 'hunter' })
    assert.equal(quantity(context.game, context.requester.user.id, 'repair-kit'), 2)
    assert.equal(context.game.db.prepare('SELECT COUNT(*) AS count FROM market_pending_items WHERE user_id = ?').get(context.requester.user.id).count, 0)
  } finally { context.game.close() }
})
