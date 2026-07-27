import { randomUUID } from 'node:crypto'
import { applyMigration } from './migrations.mjs'
import { StoreError } from './store.mjs'

const MARKET_FEE_PERCENT = 5
const MAX_ACTIVE_LISTINGS = 20
const MAX_QUANTITY = 999
const MAX_UNIT_PRICE = 10_000
const LISTING_LIFETIME = 72 * 60 * 60 * 1000
const SELLABLE_TYPES = new Set(['material', 'consumable'])
const SORTS = new Set(['newest', 'price-asc', 'price-desc', 'quantity'])

const positiveInteger = (value, field, maximum) => {
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number < 1 || number > maximum) {
    throw new StoreError('invalid-market-value', `${field} должно быть целым числом от 1 до ${maximum}.`)
  }
  return number
}

const cleanId = (value) => String(value ?? '').trim().slice(0, 96)
const cleanQuery = (value) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, 40)

function listingFromRow(row, userId) {
  const status = row.status === 'cancelled' && row.close_reason === 'expired' ? 'expired' : row.status
  return {
    id: row.id,
    sellerName: row.seller_name,
    item: { id: row.item_id, name: row.item_name, type: row.item_type, quality: row.item_quality },
    quantityTotal: Number(row.quantity_total),
    quantityRemaining: Number(row.quantity_remaining),
    unitPrice: Number(row.unit_price),
    status,
    isMine: row.seller_id === userId,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    expiresAt: Number(row.expires_at ?? 0),
  }
}

function tradeFromRow(row, userId) {
  return {
    id: row.id,
    listingId: row.listing_id,
    itemName: row.item_name,
    quantity: Number(row.quantity),
    unitPrice: Number(row.unit_price),
    gross: Number(row.gross),
    fee: Number(row.fee),
    sellerNet: Number(row.seller_net),
    buyerName: row.buyer_name,
    sellerName: row.seller_name,
    side: row.buyer_id === userId ? 'purchase' : 'sale',
    createdAt: Number(row.created_at),
  }
}

export class MarketStore {
  constructor(gameStore, players) {
    this.gameStore = gameStore
    this.players = players
    this.db = gameStore.db
    this.createSchema()
    this.installPlayerHooks()
  }

  createSchema() {
    applyMigration(this.db, '008_marketplace', () => {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS market_listings (
          id TEXT PRIMARY KEY,
          seller_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          item_id TEXT NOT NULL,
          item_name TEXT NOT NULL,
          item_type TEXT NOT NULL,
          item_quality TEXT NOT NULL,
          quantity_total INTEGER NOT NULL CHECK(quantity_total > 0),
          quantity_remaining INTEGER NOT NULL CHECK(quantity_remaining >= 0),
          unit_price INTEGER NOT NULL CHECK(unit_price > 0),
          status TEXT NOT NULL CHECK(status IN ('active', 'sold', 'cancelled')),
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          closed_at INTEGER
        ) STRICT;
        CREATE TABLE IF NOT EXISTS market_trades (
          id TEXT PRIMARY KEY,
          listing_id TEXT NOT NULL REFERENCES market_listings(id),
          buyer_id TEXT NOT NULL REFERENCES users(id),
          seller_id TEXT NOT NULL REFERENCES users(id),
          item_id TEXT NOT NULL,
          item_name TEXT NOT NULL,
          quantity INTEGER NOT NULL CHECK(quantity > 0),
          unit_price INTEGER NOT NULL CHECK(unit_price > 0),
          gross INTEGER NOT NULL CHECK(gross > 0),
          fee INTEGER NOT NULL CHECK(fee >= 0),
          seller_net INTEGER NOT NULL CHECK(seller_net >= 0),
          created_at INTEGER NOT NULL
        ) STRICT;
        CREATE TABLE IF NOT EXISTS market_accounts (
          user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
          pending_coins INTEGER NOT NULL DEFAULT 0 CHECK(pending_coins >= 0),
          updated_at INTEGER NOT NULL
        ) STRICT;
        CREATE INDEX IF NOT EXISTS idx_market_active_time ON market_listings(status, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_market_seller_time ON market_listings(seller_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_market_trade_buyer_time ON market_trades(buyer_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_market_trade_seller_time ON market_trades(seller_id, created_at DESC);
        CREATE TRIGGER IF NOT EXISTS trg_market_claim_pending_for_heir
        AFTER UPDATE OF generation ON player_characters
        WHEN NEW.generation > OLD.generation
          AND COALESCE((SELECT pending_coins FROM market_accounts WHERE user_id = NEW.user_id), 0) > 0
        BEGIN
          UPDATE player_characters SET coins = coins + (
            SELECT pending_coins FROM market_accounts WHERE user_id = NEW.user_id
          ) WHERE user_id = NEW.user_id;
          UPDATE market_accounts SET pending_coins = 0, updated_at = unixepoch('subsec') * 1000
          WHERE user_id = NEW.user_id;
        END;
      `)
    })
    applyMigration(this.db, '009_market_lifecycle', () => {
      this.db.exec(`
        ALTER TABLE market_listings ADD COLUMN expires_at INTEGER;
        ALTER TABLE market_listings ADD COLUMN close_reason TEXT;
        UPDATE market_listings SET expires_at = created_at + ${LISTING_LIFETIME} WHERE expires_at IS NULL;
        CREATE TABLE IF NOT EXISTS market_pending_items (
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          item_id TEXT NOT NULL,
          item_name TEXT NOT NULL,
          item_type TEXT NOT NULL,
          item_quality TEXT NOT NULL,
          quantity INTEGER NOT NULL CHECK(quantity > 0),
          updated_at INTEGER NOT NULL,
          PRIMARY KEY(user_id, item_id)
        ) STRICT;
        CREATE INDEX IF NOT EXISTS idx_market_expiry ON market_listings(status, expires_at);
      `)
    })
  }

  installPlayerHooks() {
    if (this.players.__marketEstateInstalled) return
    this.players.__marketEstateInstalled = true
    const originalCreateHeir = this.players.createHeir.bind(this.players)
    this.players.createHeir = (userId, input) => {
      const result = originalCreateHeir(userId, input)
      this.claimEstate(userId)
      return { ...result, character: this.players.getCharacter(userId) }
    }
  }

  safeReason(userId) {
    const character = this.db.prepare('SELECT alive FROM player_characters WHERE user_id = ?').get(userId)
    if (!character?.alive) return 'Торговать может только живой герой.'
    if (this.players.getActiveRun(userId)) return 'Рынок недоступен во время похода.'
    const story = this.db.prepare('SELECT scene_id, chapter_complete FROM player_story_state WHERE user_id = ?').get(userId)
    if (!story || (!Number(story.chapter_complete) && story.scene_id !== 'tavern')) return 'Торговать можно в трактире или после завершения первой главы.'
    return null
  }

  ensureSafe(userId) {
    const reason = this.safeReason(userId)
    if (reason) throw new StoreError('market-unavailable', reason, 409)
  }

  addStack(userId, item) {
    this.db.prepare(`
      INSERT INTO player_inventory(user_id, item_id, item_name, quantity, item_type, quality, durability, max_durability, equipped, repair_count)
      VALUES (?, ?, ?, ?, ?, ?, 0, 0, 0, 0)
      ON CONFLICT(user_id, item_id) DO UPDATE SET quantity = quantity + excluded.quantity,
        item_name = excluded.item_name, item_type = excluded.item_type, quality = excluded.quality
    `).run(userId, item.id, item.name, item.quantity, item.type, item.quality)
  }

  creditCoinsOrEstate(userId, amount) {
    if (amount <= 0) return
    const now = Date.now()
    const credited = this.db.prepare('UPDATE player_characters SET coins = coins + ?, updated_at = ? WHERE user_id = ? AND alive = 1').run(amount, now, userId)
    if (Number(credited.changes) > 0) return
    this.db.prepare(`
      INSERT INTO market_accounts(user_id, pending_coins, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET pending_coins = pending_coins + excluded.pending_coins, updated_at = excluded.updated_at
    `).run(userId, amount, now)
  }

  addStackOrEstate(userId, item) {
    const alive = Boolean(this.db.prepare('SELECT alive FROM player_characters WHERE user_id = ?').get(userId)?.alive)
    if (alive) return this.addStack(userId, item)
    this.db.prepare(`
      INSERT INTO market_pending_items(user_id, item_id, item_name, item_type, item_quality, quantity, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, item_id) DO UPDATE SET quantity = quantity + excluded.quantity,
        item_name = excluded.item_name, item_type = excluded.item_type,
        item_quality = excluded.item_quality, updated_at = excluded.updated_at
    `).run(userId, item.id, item.name, item.type, item.quality, item.quantity, Date.now())
  }

  claimEstate(userId) {
    const character = this.db.prepare('SELECT alive FROM player_characters WHERE user_id = ?').get(userId)
    if (!character?.alive) return { coins: 0, items: 0 }
    let claimedCoins = 0
    let claimedItems = 0
    this.gameStore.transaction(() => {
      const account = this.db.prepare('SELECT pending_coins FROM market_accounts WHERE user_id = ?').get(userId)
      claimedCoins = Number(account?.pending_coins ?? 0)
      if (claimedCoins > 0) {
        this.db.prepare('UPDATE player_characters SET coins = coins + ?, updated_at = ? WHERE user_id = ?').run(claimedCoins, Date.now(), userId)
        this.db.prepare('UPDATE market_accounts SET pending_coins = 0, updated_at = ? WHERE user_id = ?').run(Date.now(), userId)
      }
      const items = this.db.prepare('SELECT * FROM market_pending_items WHERE user_id = ?').all(userId)
      for (const row of items) {
        this.addStack(userId, { id: row.item_id, name: row.item_name, type: row.item_type, quality: row.item_quality, quantity: Number(row.quantity) })
        claimedItems += Number(row.quantity)
      }
      if (items.length > 0) this.db.prepare('DELETE FROM market_pending_items WHERE user_id = ?').run(userId)
    })
    return { coins: claimedCoins, items: claimedItems }
  }

  reserveItem(userId, itemId, quantity) {
    const item = this.db.prepare('SELECT * FROM player_inventory WHERE user_id = ? AND item_id = ?').get(userId, itemId)
    if (!item) throw new StoreError('market-item-not-found', 'Предмет для продажи не найден.', 404)
    if (!SELLABLE_TYPES.has(item.item_type) || Number(item.max_durability) > 0 || Number(item.equipped)) throw new StoreError('market-item-forbidden', 'На рынке можно продавать только материалы и расходники.', 409)
    if (Number(item.quantity) < quantity) throw new StoreError('market-not-enough-items', 'Недостаточно предметов для этого объявления.', 409)
    if (Number(item.quantity) === quantity) this.db.prepare('DELETE FROM player_inventory WHERE user_id = ? AND item_id = ?').run(userId, itemId)
    else this.db.prepare('UPDATE player_inventory SET quantity = quantity - ? WHERE user_id = ? AND item_id = ?').run(quantity, userId, itemId)
    return item
  }

  expireListings(now = Date.now()) {
    const rows = this.db.prepare("SELECT * FROM market_listings WHERE status = 'active' AND quantity_remaining > 0 AND expires_at IS NOT NULL AND expires_at <= ? ORDER BY expires_at LIMIT 200").all(now)
    if (rows.length === 0) return 0
    this.gameStore.transaction(() => {
      for (const row of rows) {
        const current = this.db.prepare("SELECT * FROM market_listings WHERE id = ? AND status = 'active'").get(row.id)
        if (!current) continue
        const remaining = Number(current.quantity_remaining)
        if (remaining > 0) this.addStackOrEstate(current.seller_id, { id: current.item_id, name: current.item_name, type: current.item_type, quality: current.item_quality, quantity: remaining })
        this.db.prepare("UPDATE market_listings SET quantity_remaining = 0, status = 'cancelled', close_reason = 'expired', updated_at = ?, closed_at = ? WHERE id = ?").run(now, now, current.id)
      }
    })
    return rows.length
  }

  buildSnapshot(userId, options = {}) {
    const query = cleanQuery(options.query)
    const type = SELLABLE_TYPES.has(options.type) ? options.type : 'all'
    const sort = SORTS.has(options.sort) ? options.sort : 'newest'
    const clauses = ["ml.status = 'active'", 'ml.quantity_remaining > 0']
    const params = []
    if (type !== 'all') { clauses.push('ml.item_type = ?'); params.push(type) }
    if (query) { clauses.push('(ml.item_name LIKE ? OR u.display_name LIKE ?)'); params.push(`%${query}%`, `%${query}%`) }
    const orderBy = { newest: 'ml.created_at DESC', 'price-asc': 'ml.unit_price ASC, ml.created_at DESC', 'price-desc': 'ml.unit_price DESC, ml.created_at DESC', quantity: 'ml.quantity_remaining DESC, ml.created_at DESC' }[sort]
    const listingSelect = 'SELECT ml.*, u.display_name AS seller_name FROM market_listings ml JOIN users u ON u.id = ml.seller_id'
    const listings = this.db.prepare(`${listingSelect} WHERE ${clauses.join(' AND ')} ORDER BY ${orderBy} LIMIT 100`).all(...params).map((row) => listingFromRow(row, userId))
    const ownListings = this.db.prepare(`${listingSelect} WHERE ml.seller_id = ? ORDER BY ml.created_at DESC LIMIT 40`).all(userId).map((row) => listingFromRow(row, userId))
    const trades = this.db.prepare(`SELECT mt.*, buyer.display_name AS buyer_name, seller.display_name AS seller_name FROM market_trades mt JOIN users buyer ON buyer.id = mt.buyer_id JOIN users seller ON seller.id = mt.seller_id WHERE mt.buyer_id = ? OR mt.seller_id = ? ORDER BY mt.created_at DESC LIMIT 50`).all(userId, userId).map((row) => tradeFromRow(row, userId))
    const sellable = this.db.prepare("SELECT item_id AS id, item_name AS name, quantity, item_type AS type, quality FROM player_inventory WHERE user_id = ? AND item_type IN ('material', 'consumable') AND quantity > 0 AND max_durability = 0 AND equipped = 0 ORDER BY item_type, item_name").all(userId).map((row) => ({ ...row, quantity: Number(row.quantity) }))
    const pendingCoins = Number(this.db.prepare('SELECT pending_coins FROM market_accounts WHERE user_id = ?').get(userId)?.pending_coins ?? 0)
    const pendingItems = Number(this.db.prepare('SELECT COALESCE(SUM(quantity), 0) AS quantity FROM market_pending_items WHERE user_id = ?').get(userId)?.quantity ?? 0)
    return { character: this.players.getCharacter(userId), feePercent: MARKET_FEE_PERCENT, listingLifetimeHours: LISTING_LIFETIME / 3_600_000, pendingCoins, pendingItems, filters: { query, type, sort }, safe: !this.safeReason(userId), safeReason: this.safeReason(userId), listings, ownListings, trades, sellable }
  }

  snapshot(userId, options = {}) { this.expireListings(); this.claimEstate(userId); return this.buildSnapshot(userId, options) }

  createListing(userId, input) {
    this.expireListings()
    const itemId = cleanId(input.itemId)
    const quantity = positiveInteger(input.quantity, 'Количество', MAX_QUANTITY)
    const unitPrice = positiveInteger(input.unitPrice, 'Цена', MAX_UNIT_PRICE)
    return this.players.withReceipt(userId, input.requestId, `market:create:${itemId}:${quantity}:${unitPrice}`, () => {
      this.ensureSafe(userId)
      const activeCount = Number(this.db.prepare("SELECT COUNT(*) AS count FROM market_listings WHERE seller_id = ? AND status = 'active'").get(userId).count)
      if (activeCount >= MAX_ACTIVE_LISTINGS) throw new StoreError('market-listing-limit', `Одновременно можно держать не более ${MAX_ACTIVE_LISTINGS} объявлений.`, 409)
      const item = this.reserveItem(userId, itemId, quantity)
      const now = Date.now()
      this.db.prepare("INSERT INTO market_listings(id, seller_id, item_id, item_name, item_type, item_quality, quantity_total, quantity_remaining, unit_price, status, created_at, updated_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)").run(randomUUID(), userId, item.item_id, item.item_name, item.item_type, item.quality, quantity, quantity, unitPrice, now, now, now + LISTING_LIFETIME)
      return this.buildSnapshot(userId)
    })
  }

  cancelListing(userId, listingIdValue, input) {
    this.expireListings()
    const listingId = cleanId(listingIdValue)
    return this.players.withReceipt(userId, input.requestId, `market:cancel:${listingId}`, () => {
      this.ensureSafe(userId)
      const listing = this.db.prepare('SELECT * FROM market_listings WHERE id = ? AND seller_id = ?').get(listingId, userId)
      if (!listing) throw new StoreError('market-listing-not-found', 'Объявление не найдено.', 404)
      if (listing.status !== 'active') throw new StoreError('market-listing-closed', 'Объявление уже закрыто.', 409)
      const remaining = Number(listing.quantity_remaining)
      if (remaining > 0) this.addStack(userId, { id: listing.item_id, name: listing.item_name, type: listing.item_type, quality: listing.item_quality, quantity: remaining })
      const now = Date.now()
      this.db.prepare("UPDATE market_listings SET quantity_remaining = 0, status = 'cancelled', close_reason = 'cancelled', updated_at = ?, closed_at = ? WHERE id = ?").run(now, now, listingId)
      return this.buildSnapshot(userId)
    })
  }

  buyListing(userId, listingIdValue, input) {
    this.expireListings()
    const listingId = cleanId(listingIdValue)
    const quantity = positiveInteger(input.quantity, 'Количество', MAX_QUANTITY)
    return this.players.withReceipt(userId, input.requestId, `market:buy:${listingId}:${quantity}`, () => {
      this.ensureSafe(userId)
      const listing = this.db.prepare('SELECT * FROM market_listings WHERE id = ?').get(listingId)
      if (!listing || listing.status !== 'active' || Number(listing.quantity_remaining) < 1) throw new StoreError('market-listing-not-found', 'Активное объявление не найдено.', 404)
      if (listing.seller_id === userId) throw new StoreError('market-self-purchase', 'Нельзя купить собственный товар.', 409)
      if (quantity > Number(listing.quantity_remaining)) throw new StoreError('market-not-enough-stock', 'В объявлении осталось меньше товара.', 409)
      const buyer = this.db.prepare('SELECT coins, alive FROM player_characters WHERE user_id = ?').get(userId)
      if (!buyer?.alive) throw new StoreError('character-required', 'Для покупки нужен живой герой.', 404)
      const gross = quantity * Number(listing.unit_price)
      if (Number(buyer.coins) < gross) throw new StoreError('not-enough-coins', `Для покупки нужно ${gross} монет.`, 409)
      const fee = Math.floor(gross * MARKET_FEE_PERCENT / 100)
      const sellerNet = gross - fee
      const now = Date.now()
      const remaining = Number(listing.quantity_remaining) - quantity
      this.db.prepare('UPDATE player_characters SET coins = coins - ?, updated_at = ? WHERE user_id = ?').run(gross, now, userId)
      this.creditCoinsOrEstate(listing.seller_id, sellerNet)
      this.addStack(userId, { id: listing.item_id, name: listing.item_name, type: listing.item_type, quality: listing.item_quality, quantity })
      this.db.prepare('UPDATE market_listings SET quantity_remaining = ?, status = ?, updated_at = ?, closed_at = ? WHERE id = ?').run(remaining, remaining === 0 ? 'sold' : 'active', now, remaining === 0 ? now : null, listingId)
      this.db.prepare('INSERT INTO market_trades(id, listing_id, buyer_id, seller_id, item_id, item_name, quantity, unit_price, gross, fee, seller_net, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(randomUUID(), listingId, userId, listing.seller_id, listing.item_id, listing.item_name, quantity, listing.unit_price, gross, fee, sellerNet, now)
      return { ...this.buildSnapshot(userId), purchase: { listingId, itemName: listing.item_name, quantity, gross, fee } }
    })
  }
}
