import test from 'node:test'
import assert from 'node:assert/strict'
import { CommissionStore } from './commission-store.mjs'
import { CraftingStore } from './crafting-store.mjs'
import { installCraftingMigrations } from './crafting-migrations.mjs'
import { MarketStore } from './market-store.mjs'
import { PlayerStore } from './player-store.mjs'
import { StoryStore } from './story-store.mjs'
import { installSurvivalRewards } from './survival-rewards.mjs'
import { SurvivalStore } from './survival-store.mjs'
import { GameStore, StoreError } from './store.mjs'
import { installUniqueItemFixes } from './unique-item-fixes.mjs'
import { UniqueItemStore } from './unique-item-store.mjs'

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
  installCraftingMigrations(game.db)
  const market = new MarketStore(game, players)
  const artifacts = new UniqueItemStore(game, players, survival, market)
  installUniqueItemFixes(game.db, artifacts)
  artifacts.patchCrafting(crafting)
  const commissions = new CommissionStore(game, players, market)
  return { game, players, stories, survival, crafting, market, artifacts, commissions }
}

function quantity(game, userId, itemId) {
  return Number(game.db.prepare('SELECT quantity FROM player_inventory WHERE user_id = ? AND item_id = ?').get(userId, itemId)?.quantity ?? 0)
}

function grantForgeMaterials(context, userId) {
  context.crafting.addStack(userId, 'scrap-iron', 'Лом железа', 6)
  context.crafting.addStack(userId, 'charcoal', 'Древесный уголь', 3)
  context.crafting.addStack(userId, 'cloth', 'Грубая ткань', 1)
}

test('starter tools become bound unique instances and chapter reward is not duplicated', () => {
  const context = setup()
  try {
    const account = createAccount(context.game, context.players, context.stories, 'unique_starter', 'Ратибор', 'blacksmith')
    const starter = context.artifacts.ownedItems(account.user.id).find((item) => item.templateId === 'smith-hammer')
    assert.ok(starter)
    assert.equal(starter.unique, true)
    assert.equal(starter.equipped, true)
    assert.equal(starter.tradable, false)
    assert.match(starter.serial, /^ПК-\d{6}$/)
    assert.equal(quantity(context.game, account.user.id, 'smith-hammer'), 0)

    context.game.db.prepare('UPDATE player_story_state SET chapter_complete = 1 WHERE user_id = ?').run(account.user.id)
    assert.equal(context.artifacts.ownedItems(account.user.id).filter((item) => item.templateId === 'road-blade').length, 1)
    context.game.db.prepare(`
      INSERT OR REPLACE INTO player_inventory(
        user_id, item_id, item_name, quantity, item_type, quality,
        durability, max_durability, equipped, repair_count
      ) VALUES (?, 'road-blade', 'Дорожный тесак', 1, 'tool', 'good', 60, 60, 0, 0)
    `).run(account.user.id)
    context.artifacts.migrateDurableStacks()
    assert.equal(context.artifacts.ownedItems(account.user.id).filter((item) => item.templateId === 'road-blade').length, 1)
  } finally { context.game.close() }
})

test('legacy durable stack migrates without losing condition or equipment', () => {
  const game = new GameStore(':memory:')
  const players = new PlayerStore(game)
  const stories = new StoryStore(game, players)
  const survival = new SurvivalStore(game, players)
  installSurvivalRewards(game.db)
  const crafting = new CraftingStore(game, players, survival)
  installCraftingMigrations(game.db)
  const market = new MarketStore(game, players)
  try {
    const account = createAccount(game, players, stories, 'legacy_tool', 'Старый мастер', 'blacksmith')
    game.db.prepare("UPDATE player_inventory SET quality = 'good', durability = 17, max_durability = 53, repair_count = 4 WHERE user_id = ? AND item_id = 'smith-hammer'").run(account.user.id)
    const artifacts = new UniqueItemStore(game, players, survival, market)
    installUniqueItemFixes(game.db, artifacts)
    artifacts.patchCrafting(crafting)
    const migrated = artifacts.ownedItems(account.user.id).find((item) => item.templateId === 'smith-hammer')
    assert.ok(migrated)
    assert.equal(migrated.quality, 'good')
    assert.equal(migrated.durability, 17)
    assert.equal(migrated.maxDurability, 53)
    assert.equal(migrated.repairCount, 4)
    assert.equal(migrated.equipped, true)
  } finally { game.close() }
})

test('forging and crafting modification affect one instance exactly once', () => {
  const context = setup()
  try {
    const smith = createAccount(context.game, context.players, context.stories, 'artifact_smith', 'Добрыня', 'blacksmith')
    context.game.db.prepare('UPDATE player_characters SET coins = 100 WHERE user_id = ?').run(smith.user.id)
    grantForgeMaterials(context, smith.user.id)
    const input = { requestId: 'artifact-forge-0001' }
    const first = context.artifacts.forge(smith.user.id, 'ash-cleaver', input)
    const repeated = context.artifacts.forge(smith.user.id, 'ash-cleaver', input)
    assert.equal(first.forged.id, repeated.forged.id)
    assert.equal(context.game.db.prepare("SELECT COUNT(*) AS count FROM unique_items WHERE maker_user_id = ? AND origin_type = 'crafted'").get(smith.user.id).count, 1)
    assert.equal(quantity(context.game, smith.user.id, 'scrap-iron'), 0)
    assert.equal(context.players.getCharacter(smith.user.id).coins, 88)

    context.survival.equipItem(smith.user.id, first.forged.id, { requestId: 'artifact-equip-0001' })
    context.game.db.prepare('UPDATE unique_items SET durability = 20 WHERE id = ?').run(first.forged.id)
    context.crafting.addStack(smith.user.id, 'repair-kit', 'Полевой ремкомплект', 1, 'consumable')
    const repair = { requestId: 'artifact-kit-0001' }
    context.crafting.craft(smith.user.id, 'use-repair-kit', repair)
    context.crafting.craft(smith.user.id, 'use-repair-kit', repair)
    assert.equal(context.game.db.prepare('SELECT durability FROM unique_items WHERE id = ?').get(first.forged.id).durability, 40)
  } finally { context.game.close() }
})

test('the same serial instance can be sold, relisted and sold again without cloning', () => {
  const context = setup()
  try {
    const smith = createAccount(context.game, context.players, context.stories, 'serial_smith', 'Мастер', 'blacksmith')
    const buyer = createAccount(context.game, context.players, context.stories, 'serial_buyer', 'Купец', 'hunter')
    const third = createAccount(context.game, context.players, context.stories, 'serial_third', 'Следопыт', 'wanderer')
    context.game.db.prepare('UPDATE player_characters SET coins = 100 WHERE user_id IN (?, ?)').run(buyer.user.id, third.user.id)
    context.game.db.prepare('UPDATE player_characters SET coins = 100 WHERE user_id = ?').run(smith.user.id)
    grantForgeMaterials(context, smith.user.id)
    const item = context.artifacts.forge(smith.user.id, 'ash-cleaver', { requestId: 'serial-forge-0001' }).forged

    const firstListing = context.artifacts.createListing(smith.user.id, item.id, { requestId: 'serial-list-0001', unitPrice: 20 }).ownListings.find((listing) => listing.status === 'active')
    context.artifacts.buyListing(buyer.user.id, firstListing.id, { requestId: 'serial-buy-0001' })
    const secondListing = context.artifacts.createListing(buyer.user.id, item.id, { requestId: 'serial-list-0002', unitPrice: 30 }).ownListings.find((listing) => listing.status === 'active')
    context.artifacts.buyListing(third.user.id, secondListing.id, { requestId: 'serial-buy-0002' })

    const row = context.game.db.prepare('SELECT owner_user_id, trade_count FROM unique_items WHERE id = ?').get(item.id)
    assert.equal(row.owner_user_id, third.user.id)
    assert.equal(row.trade_count, 2)
    assert.equal(context.game.db.prepare('SELECT COUNT(*) AS count FROM unique_items WHERE id = ?').get(item.id).count, 1)
    assert.equal(context.game.db.prepare('SELECT COUNT(*) AS count FROM unique_item_trades WHERE item_id = ?').get(item.id).count, 2)
  } finally { context.game.close() }
})

test('expired artifact listing returns the exact instance once', () => {
  const context = setup()
  try {
    const smith = createAccount(context.game, context.players, context.stories, 'expiry_smith', 'Кузнец', 'blacksmith')
    context.game.db.prepare('UPDATE player_characters SET coins = 100 WHERE user_id = ?').run(smith.user.id)
    grantForgeMaterials(context, smith.user.id)
    const item = context.artifacts.forge(smith.user.id, 'ash-cleaver', { requestId: 'expiry-forge-0001' }).forged
    const listing = context.artifacts.createListing(smith.user.id, item.id, { requestId: 'expiry-list-0001', unitPrice: 25 }).ownListings.find((entry) => entry.status === 'active')
    context.game.db.prepare('UPDATE unique_item_listings SET expires_at = 0 WHERE id = ?').run(listing.id)
    context.artifacts.snapshot(smith.user.id)
    context.artifacts.snapshot(smith.user.id)
    assert.equal(context.game.db.prepare('SELECT owner_user_id FROM unique_items WHERE id = ?').get(item.id).owner_user_id, smith.user.id)
    assert.equal(context.game.db.prepare('SELECT status FROM unique_item_listings WHERE id = ?').get(listing.id).status, 'expired')
    assert.throws(
      () => context.artifacts.buyListing(smith.user.id, listing.id, { requestId: 'expiry-buy-0001' }),
      (error) => error instanceof StoreError && error.code === 'artifact-listing-not-found',
    )
  } finally { context.game.close() }
})
