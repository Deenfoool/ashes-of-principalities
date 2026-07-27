import test from 'node:test'
import assert from 'node:assert/strict'
import { MarketStore } from './market-store.mjs'
import { PlayerStore } from './player-store.mjs'
import { StoryStore } from './story-store.mjs'
import { installSurvivalRewards } from './survival-rewards.mjs'
import { SurvivalStore } from './survival-store.mjs'
import { GameStore } from './store.mjs'

function createAccount(game, players, stories, username, displayName, profession) {
  const account = game.register({ username, password: '12345678', displayName })
  players.createCharacter(account.user.id, {
    requestId: `${username}-hero-0001`, name: displayName, profession,
  })
  stories.publicStory(account.user.id)
  game.db.prepare("UPDATE player_story_state SET scene_id = 'tavern' WHERE user_id = ?").run(account.user.id)
  return account
}

test('sale after seller death is inherited by the next generation', () => {
  const game = new GameStore(':memory:')
  const players = new PlayerStore(game)
  const stories = new StoryStore(game, players)
  new SurvivalStore(game, players)
  installSurvivalRewards(game.db)
  const seller = createAccount(game, players, stories, 'market_dead_seller', 'Ратибор', 'blacksmith')
  const buyer = createAccount(game, players, stories, 'market_heir_buyer', 'Мирослав', 'hunter')
  const market = new MarketStore(game, players)

  try {
    market.addStack(seller.user.id, {
      id: 'river-bone', name: 'Речная кость', type: 'material', quality: 'common', quantity: 1,
    })
    game.db.prepare('UPDATE player_characters SET coins = 50 WHERE user_id = ?').run(buyer.user.id)
    const listingId = market.createListing(seller.user.id, {
      requestId: 'market-death-create-0001', itemId: 'river-bone', quantity: 1, unitPrice: 20,
    }).ownListings[0].id

    game.db.prepare('UPDATE player_characters SET health = 0, alive = 0 WHERE user_id = ?').run(seller.user.id)
    market.buyListing(buyer.user.id, listingId, { requestId: 'market-death-buy-0001', quantity: 1 })

    assert.equal(players.getCharacter(seller.user.id).coins, 4)
    assert.equal(game.db.prepare('SELECT pending_coins FROM market_accounts WHERE user_id = ?').get(seller.user.id).pending_coins, 19)

    const heir = players.createHeir(seller.user.id, {
      requestId: 'market-death-heir-0001', name: 'Добрыня', profession: 'hunter',
    })
    assert.equal(heir.character.coins, 22)
    assert.equal(game.db.prepare('SELECT pending_coins FROM market_accounts WHERE user_id = ?').get(seller.user.id).pending_coins, 0)
  } finally {
    game.close()
  }
})
