import test from 'node:test'
import assert from 'node:assert/strict'
import { MarketStore } from './market-store.mjs'
import { PlayerStore } from './player-store.mjs'
import { StoryStore } from './story-store.mjs'
import { installSurvivalRewards } from './survival-rewards.mjs'
import { SurvivalStore } from './survival-store.mjs'
import { GameStore, StoreError } from './store.mjs'

function createAccount(game, players, stories, username, displayName, profession = 'hunter') {
  const account = game.register({ username, password: '12345678', displayName })
  players.createCharacter(account.user.id, {
    requestId: `${username}-hero-0001`,
    name: displayName,
    profession,
  })
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
  const seller = createAccount(game, players, stories, 'market_seller', 'Ратибор', 'blacksmith')
  const buyer = createAccount(game, players, stories, 'market_buyer', 'Мирослав', 'hunter')
  const market = new MarketStore(game, players)
  return { game, players, stories, survival, market, seller, buyer }
}

function quantity(game, userId, itemId) {
  return Number(game.db.prepare('SELECT quantity FROM player_inventory WHERE user_id = ? AND item_id = ?').get(userId, itemId)?.quantity ?? 0)
}

test('creating a listing reserves inventory exactly once', () => {
  const context = setup()
  try {
    context.market.addStack(context.seller.user.id, {
      id: 'scrap-iron', name: 'Лом железа', type: 'material', quality: 'common', quantity: 5,
    })
    const input = { requestId: 'market-create-0001', itemId: 'scrap-iron', quantity: 3, unitPrice: 4 }
    const first = context.market.createListing(context.seller.user.id, input)
    const repeated = context.market.createListing(context.seller.user.id, input)

    assert.equal(quantity(context.game, context.seller.user.id, 'scrap-iron'), 2)
    assert.equal(first.ownListings.length, 1)
    assert.equal(first.ownListings[0].quantityRemaining, 3)
    assert.deepEqual(repeated, first)
    assert.equal(context.game.db.prepare('SELECT COUNT(*) AS count FROM market_listings').get().count, 1)
  } finally {
    context.game.close()
  }
})

test('partial purchase transfers items and coins atomically with fee', () => {
  const context = setup()
  try {
    context.market.addStack(context.seller.user.id, {
      id: 'charcoal', name: 'Древесный уголь', type: 'material', quality: 'common', quantity: 4,
    })
    context.game.db.prepare('UPDATE player_characters SET coins = 50 WHERE user_id = ?').run(context.buyer.user.id)
    context.game.db.prepare('UPDATE player_characters SET coins = 4 WHERE user_id = ?').run(context.seller.user.id)
    const created = context.market.createListing(context.seller.user.id, {
      requestId: 'market-create-0002', itemId: 'charcoal', quantity: 4, unitPrice: 10,
    })
    const listingId = created.ownListings[0].id
    const purchaseInput = { requestId: 'market-buy-0001', quantity: 2 }
    const bought = context.market.buyListing(context.buyer.user.id, listingId, purchaseInput)
    const repeated = context.market.buyListing(context.buyer.user.id, listingId, purchaseInput)

    assert.equal(bought.purchase.gross, 20)
    assert.equal(bought.purchase.fee, 1)
    assert.equal(quantity(context.game, context.buyer.user.id, 'charcoal'), 2)
    assert.equal(context.players.getCharacter(context.buyer.user.id).coins, 30)
    assert.equal(context.players.getCharacter(context.seller.user.id).coins, 23)
    assert.equal(context.game.db.prepare('SELECT quantity_remaining FROM market_listings WHERE id = ?').get(listingId).quantity_remaining, 2)
    assert.equal(context.game.db.prepare('SELECT COUNT(*) AS count FROM market_trades').get().count, 1)
    assert.deepEqual(repeated, bought)
  } finally {
    context.game.close()
  }
})

test('cancelling returns only the unsold reservation once', () => {
  const context = setup()
  try {
    context.market.addStack(context.seller.user.id, {
      id: 'cloth', name: 'Грубая ткань', type: 'material', quality: 'common', quantity: 5,
    })
    context.game.db.prepare('UPDATE player_characters SET coins = 20 WHERE user_id = ?').run(context.buyer.user.id)
    const listingId = context.market.createListing(context.seller.user.id, {
      requestId: 'market-create-0003', itemId: 'cloth', quantity: 5, unitPrice: 2,
    }).ownListings[0].id
    context.market.buyListing(context.buyer.user.id, listingId, { requestId: 'market-buy-0002', quantity: 2 })

    const input = { requestId: 'market-cancel-0001' }
    const cancelled = context.market.cancelListing(context.seller.user.id, listingId, input)
    const repeated = context.market.cancelListing(context.seller.user.id, listingId, input)

    assert.equal(quantity(context.game, context.seller.user.id, 'cloth'), 3)
    assert.equal(cancelled.ownListings[0].status, 'cancelled')
    assert.deepEqual(repeated, cancelled)
  } finally {
    context.game.close()
  }
})

test('self purchase and forbidden equipment listings are rejected', () => {
  const context = setup()
  try {
    assert.throws(
      () => context.market.createListing(context.seller.user.id, {
        requestId: 'market-tool-0001', itemId: 'smith-hammer', quantity: 1, unitPrice: 5,
      }),
      (error) => error instanceof StoreError && error.code === 'market-item-forbidden',
    )

    context.market.addStack(context.seller.user.id, {
      id: 'bitter-herb', name: 'Горькая трава', type: 'material', quality: 'common', quantity: 1,
    })
    const listingId = context.market.createListing(context.seller.user.id, {
      requestId: 'market-create-0004', itemId: 'bitter-herb', quantity: 1, unitPrice: 1,
    }).ownListings[0].id
    assert.throws(
      () => context.market.buyListing(context.seller.user.id, listingId, { requestId: 'market-self-0001', quantity: 1 }),
      (error) => error instanceof StoreError && error.code === 'market-self-purchase',
    )
  } finally {
    context.game.close()
  }
})
