import test from 'node:test'
import assert from 'node:assert/strict'
import { CraftingStore } from './crafting-store.mjs'
import { MarketStore } from './market-store.mjs'
import { PlayerStore } from './player-store.mjs'
import { StoryStore } from './story-store.mjs'
import { installSurvivalRewards } from './survival-rewards.mjs'
import { SurvivalStore } from './survival-store.mjs'
import { GameStore } from './store.mjs'

function setup() {
  const game = new GameStore(':memory:')
  const players = new PlayerStore(game)
  const stories = new StoryStore(game, players)
  const survival = new SurvivalStore(game, players)
  installSurvivalRewards(game.db)
  const crafting = new CraftingStore(game, players, survival)
  const market = new MarketStore(game, players)
  const account = game.register({ username: 'market_lifecycle', password: '12345678', displayName: 'Торговец' })
  players.createCharacter(account.user.id, { requestId: 'market-life-hero-0001', name: 'Торговец', profession: 'carter' })
  stories.publicStory(account.user.id)
  game.db.prepare("UPDATE player_story_state SET scene_id = 'tavern' WHERE user_id = ?").run(account.user.id)
  return { game, crafting, market, account }
}
function quantity(game, userId, itemId) {
  return Number(game.db.prepare('SELECT quantity FROM player_inventory WHERE user_id = ? AND item_id = ?').get(userId, itemId)?.quantity ?? 0)
}

test('expired listing returns reserve and search filters server results', () => {
  const context = setup()
  try {
    context.crafting.addStack(context.account.user.id, 'scrap-iron', 'Лом железа', 3)
    context.crafting.addStack(context.account.user.id, 'traveler-kit', 'Походный набор', 2, 'consumable')
    const iron = context.market.createListing(context.account.user.id, {
      requestId: 'market-life-create-0001', itemId: 'scrap-iron', quantity: 3, unitPrice: 8,
    }).ownListings[0]
    context.market.createListing(context.account.user.id, {
      requestId: 'market-life-create-0002', itemId: 'traveler-kit', quantity: 2, unitPrice: 3,
    })
    assert.equal(context.market.snapshot(context.account.user.id, { query: 'Поход', type: 'consumable' }).listings.length, 1)
    assert.equal(context.market.snapshot(context.account.user.id, { type: 'material', sort: 'price-desc' }).listings.length, 1)
    context.game.db.prepare('UPDATE market_listings SET expires_at = 0 WHERE id = ?').run(iron.id)
    const snapshot = context.market.snapshot(context.account.user.id)
    assert.equal(quantity(context.game, context.account.user.id, 'scrap-iron'), 3)
    assert.equal(snapshot.ownListings.find((listing) => listing.id === iron.id).status, 'expired')
    context.market.snapshot(context.account.user.id)
    assert.equal(quantity(context.game, context.account.user.id, 'scrap-iron'), 3)
  } finally { context.game.close() }
})
