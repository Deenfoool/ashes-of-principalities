import { randomUUID } from 'node:crypto'
import { applyMigration } from './migrations.mjs'
import { StoreError } from './store.mjs'

const ORDER_LIFETIME = 48 * 60 * 60 * 1000
const MAX_ACTIVE_ORDERS = 10
const MAX_BATCHES = 10
const MAX_REWARD = 100_000
const COMMISSION_FEE_PERCENT = 3
const PROFESSIONS = new Set(['blacksmith', 'herbalist', 'hunter', 'scribe', 'carter', 'wanderer'])

export const commissionCatalog = [
  { id: 'field-repair-kit', title: 'Полевой ремкомплект', description: 'Кузнец собирает скобы, заклёпки и угольную пасту.', profession: 'blacksmith', ingredients: { 'scrap-iron': 2, charcoal: 1 }, output: { id: 'repair-kit', name: 'Полевой ремкомплект', type: 'consumable', quality: 'common', quantity: 2 }, baseReward: 4 },
  { id: 'healing-poultice', title: 'Лечебная припарка', description: 'Травник готовит повязки для лечения лёгких и средних травм.', profession: 'herbalist', ingredients: { 'bitter-herb': 2, cloth: 1 }, output: { id: 'healing-poultice', name: 'Лечебная припарка', type: 'consumable', quality: 'common', quantity: 2 }, baseReward: 5 },
  { id: 'leather-bindings', title: 'Кожаные накладки', description: 'Охотник укрепляет рукояти и тетивы плотной шкурой.', profession: 'hunter', ingredients: { 'burnt-hide': 2, 'river-bone': 1 }, output: { id: 'leather-bindings', name: 'Кожаные накладки', type: 'consumable', quality: 'common', quantity: 1 }, baseReward: 6 },
  { id: 'warded-ink', title: 'Обережные чернила', description: 'Писарь готовит чернила для защитного знака пути.', profession: 'scribe', ingredients: { charcoal: 2, 'river-bone': 1, cloth: 1 }, output: { id: 'warded-ink', name: 'Обережные чернила', type: 'consumable', quality: 'common', quantity: 1 }, baseReward: 7 },
  { id: 'cargo-brace', title: 'Дорожная скоба', description: 'Возчик делает крепёж для инструмента и дорожной оснастки.', profession: 'carter', ingredients: { 'scrap-iron': 2, 'burnt-hide': 1 }, output: { id: 'cargo-brace', name: 'Дорожная скоба', type: 'consumable', quality: 'common', quantity: 1 }, baseReward: 6 },
  { id: 'traveler-kit', title: 'Походный набор', description: 'Странник собирает универсальный запас для восстановления в дороге.', profession: 'wanderer', ingredients: { cloth: 1, charcoal: 1, 'bitter-herb': 1 }, output: { id: 'traveler-kit', name: 'Походный набор', type: 'consumable', quality: 'common', quantity: 1 }, baseReward: 5 },
]

const catalogById = Object.fromEntries(commissionCatalog.map((recipe) => [recipe.id, recipe]))
const positiveInteger = (value, field, maximum) => {
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number < 1 || number > maximum) throw new StoreError('invalid-commission-value', `${field} должно быть целым числом от 1 до ${maximum}.`)
  return number
}
const cleanText = (value, maximum = 40) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, maximum)
const multipliedIngredients = (recipe, batches) => Object.entries(recipe.ingredients).map(([id, quantity]) => ({ id, quantity: quantity * batches }))
const publicCatalog = (recipe) => ({ id: recipe.id, title: recipe.title, description: recipe.description, profession: recipe.profession, ingredients: Object.entries(recipe.ingredients).map(([id, quantity]) => ({ id, quantity })), output: recipe.output, baseReward: recipe.baseReward })

export class CommissionStore {
  constructor(gameStore, players, market) {
    this.gameStore = gameStore
    this.players = players
    this.market = market
    this.db = gameStore.db
    this.createSchema()
  }

  createSchema() {
    applyMigration(this.db, '010_craft_commissions', () => {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS craft_commissions (
          id TEXT PRIMARY KEY,
          requester_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          target_crafter_id TEXT REFERENCES users(id) ON DELETE SET NULL,
          fulfiller_id TEXT REFERENCES users(id) ON DELETE SET NULL,
          recipe_id TEXT NOT NULL,
          recipe_title TEXT NOT NULL,
          required_profession TEXT NOT NULL,
          batch_count INTEGER NOT NULL CHECK(batch_count > 0),
          output_item_id TEXT NOT NULL,
          output_item_name TEXT NOT NULL,
          output_item_type TEXT NOT NULL,
          output_item_quality TEXT NOT NULL,
          output_quantity INTEGER NOT NULL CHECK(output_quantity > 0),
          reward_coins INTEGER NOT NULL CHECK(reward_coins > 0),
          fee_coins INTEGER NOT NULL DEFAULT 0 CHECK(fee_coins >= 0),
          status TEXT NOT NULL CHECK(status IN ('open', 'fulfilled', 'cancelled', 'expired')),
          created_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          closed_at INTEGER
        ) STRICT;
        CREATE INDEX IF NOT EXISTS idx_commissions_open_profession ON craft_commissions(status, required_profession, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_commissions_requester ON craft_commissions(requester_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_commissions_target ON craft_commissions(target_crafter_id, status, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_commissions_fulfiller ON craft_commissions(fulfiller_id, closed_at DESC);
        CREATE INDEX IF NOT EXISTS idx_commissions_expiry ON craft_commissions(status, expires_at);
      `)
    })
  }

  safeReason(userId) {
    return this.market.safeReason(userId)?.replace('Торговать', 'Работать с заказами') ?? null
  }

  ensureSafe(userId) {
    const reason = this.safeReason(userId)
    if (reason) throw new StoreError('commission-unavailable', reason, 409)
  }

  inventoryMap(userId) {
    return new Map(this.db.prepare('SELECT item_id, quantity FROM player_inventory WHERE user_id = ?').all(userId).map((row) => [row.item_id, Number(row.quantity)]))
  }

  fulfillReason(userId, order) {
    if (order.status !== 'open') return 'Заказ уже закрыт.'
    if (order.requester_id === userId) return 'Нельзя выполнить собственный заказ.'
    if (order.target_crafter_id && order.target_crafter_id !== userId) return 'Заказ адресован другому мастеру.'
    const safe = this.safeReason(userId)
    if (safe) return safe
    const character = this.db.prepare('SELECT profession, alive FROM player_characters WHERE user_id = ?').get(userId)
    if (!character?.alive) return 'Для выполнения нужен живой герой.'
    if (character.profession !== order.required_profession) return 'Нужно другое ремесло.'
    const recipe = catalogById[order.recipe_id]
    if (!recipe) return 'Рецепт заказа больше не поддерживается.'
    const inventory = this.inventoryMap(userId)
    for (const ingredient of multipliedIngredients(recipe, Number(order.batch_count))) {
      if ((inventory.get(ingredient.id) ?? 0) < ingredient.quantity) return `Не хватает материала: ${ingredient.id} ×${ingredient.quantity}.`
    }
    return null
  }

  orderFromRow(row, userId) {
    const recipe = catalogById[row.recipe_id]
    const reason = row.status === 'open' ? this.fulfillReason(userId, row) : 'Заказ закрыт.'
    return {
      id: row.id,
      requesterName: row.requester_name,
      targetName: row.target_name ?? null,
      fulfillerName: row.fulfiller_name ?? null,
      recipe: { id: row.recipe_id, title: row.recipe_title, profession: row.required_profession, ingredients: recipe ? multipliedIngredients(recipe, Number(row.batch_count)) : [] },
      batches: Number(row.batch_count),
      output: { id: row.output_item_id, name: row.output_item_name, type: row.output_item_type, quality: row.output_item_quality, quantity: Number(row.output_quantity) },
      rewardCoins: Number(row.reward_coins),
      feeCoins: Number(row.fee_coins),
      status: row.status,
      isMine: row.requester_id === userId,
      canFulfill: !reason,
      fulfillReason: reason,
      createdAt: Number(row.created_at),
      expiresAt: Number(row.expires_at),
      closedAt: row.closed_at === null ? null : Number(row.closed_at),
    }
  }

  expireOrders(now = Date.now()) {
    const rows = this.db.prepare("SELECT id, requester_id, reward_coins FROM craft_commissions WHERE status = 'open' AND expires_at <= ? ORDER BY expires_at LIMIT 200").all(now)
    if (rows.length === 0) return 0
    this.gameStore.transaction(() => {
      for (const row of rows) {
        const closed = this.db.prepare("UPDATE craft_commissions SET status = 'expired', updated_at = ?, closed_at = ? WHERE id = ? AND status = 'open'").run(now, now, row.id)
        if (Number(closed.changes) > 0) this.market.creditCoinsOrEstate(row.requester_id, Number(row.reward_coins))
      }
    })
    return rows.length
  }

  selectRows(where, params, order = 'cc.created_at DESC', limit = 100) {
    return this.db.prepare(`
      SELECT cc.*, requester.display_name AS requester_name,
        target.display_name AS target_name, fulfiller.display_name AS fulfiller_name
      FROM craft_commissions cc
      JOIN users requester ON requester.id = cc.requester_id
      LEFT JOIN users target ON target.id = cc.target_crafter_id
      LEFT JOIN users fulfiller ON fulfiller.id = cc.fulfiller_id
      WHERE ${where}
      ORDER BY ${order} LIMIT ${limit}
    `).all(...params)
  }

  buildSnapshot(userId, options = {}) {
    const query = cleanText(options.query)
    const profession = PROFESSIONS.has(options.profession) ? options.profession : 'all'
    const availableClauses = ["cc.status = 'open'", 'cc.requester_id <> ?', '(cc.target_crafter_id IS NULL OR cc.target_crafter_id = ?)']
    const availableParams = [userId, userId]
    if (profession !== 'all') { availableClauses.push('cc.required_profession = ?'); availableParams.push(profession) }
    if (query) { availableClauses.push('(cc.recipe_title LIKE ? OR requester.display_name LIKE ?)'); availableParams.push(`%${query}%`, `%${query}%`) }
    const available = this.selectRows(availableClauses.join(' AND '), availableParams).map((row) => this.orderFromRow(row, userId))
    const mine = this.selectRows('cc.requester_id = ?', [userId], 'cc.created_at DESC', 50).map((row) => this.orderFromRow(row, userId))
    const fulfilled = this.selectRows('cc.fulfiller_id = ?', [userId], 'cc.closed_at DESC', 50).map((row) => this.orderFromRow(row, userId))
    return { character: this.players.getCharacter(userId), catalog: commissionCatalog.map(publicCatalog), feePercent: COMMISSION_FEE_PERCENT, lifetimeHours: ORDER_LIFETIME / 3_600_000, filters: { query, profession }, safe: !this.safeReason(userId), safeReason: this.safeReason(userId), available, mine, fulfilled }
  }

  snapshot(userId, options = {}) { this.expireOrders(); this.market.claimEstate(userId); return this.buildSnapshot(userId, options) }

  createOrder(userId, input) {
    this.expireOrders()
    const recipe = catalogById[cleanText(input.recipeId, 80)]
    if (!recipe) throw new StoreError('commission-recipe-not-found', 'Такой ремесленный заказ недоступен.', 404)
    const batches = positiveInteger(input.batches, 'Количество партий', MAX_BATCHES)
    const rewardCoins = positiveInteger(input.rewardCoins, 'Награда', MAX_REWARD)
    const minimumReward = recipe.baseReward * batches
    if (rewardCoins < minimumReward) throw new StoreError('commission-reward-too-low', `Минимальная награда за этот объём: ${minimumReward} монет.`, 409)
    const targetUsername = cleanText(input.targetUsername, 20).toLocaleLowerCase('ru-RU')
    const target = targetUsername ? this.db.prepare('SELECT u.id, u.display_name, pc.profession, pc.alive FROM users u LEFT JOIN player_characters pc ON pc.user_id = u.id WHERE u.username = ? COLLATE NOCASE').get(targetUsername) : null
    if (targetUsername && !target) throw new StoreError('commission-target-not-found', 'Указанный мастер не найден.', 404)
    if (target?.id === userId) throw new StoreError('commission-self-target', 'Нельзя адресовать заказ самому себе.', 409)
    if (target && (!target.alive || target.profession !== recipe.profession)) throw new StoreError('commission-target-profession', 'У выбранного мастера сейчас нет живого героя нужного ремесла.', 409)
    const action = `commission:create:${recipe.id}:${batches}:${rewardCoins}:${target?.id ?? 'open'}`
    return this.players.withReceipt(userId, input.requestId, action, () => {
      this.ensureSafe(userId)
      const character = this.db.prepare('SELECT coins, alive FROM player_characters WHERE user_id = ?').get(userId)
      if (!character?.alive) throw new StoreError('character-required', 'Для заказа нужен живой герой.', 404)
      if (Number(character.coins) < rewardCoins) throw new StoreError('not-enough-coins', `Для резерва нужно ${rewardCoins} монет.`, 409)
      const activeCount = Number(this.db.prepare("SELECT COUNT(*) AS count FROM craft_commissions WHERE requester_id = ? AND status = 'open'").get(userId).count)
      if (activeCount >= MAX_ACTIVE_ORDERS) throw new StoreError('commission-limit', `Одновременно можно держать не более ${MAX_ACTIVE_ORDERS} заказов.`, 409)
      const now = Date.now()
      const outputQuantity = recipe.output.quantity * batches
      this.db.prepare('UPDATE player_characters SET coins = coins - ?, updated_at = ? WHERE user_id = ?').run(rewardCoins, now, userId)
      this.db.prepare("INSERT INTO craft_commissions(id, requester_id, target_crafter_id, recipe_id, recipe_title, required_profession, batch_count, output_item_id, output_item_name, output_item_type, output_item_quality, output_quantity, reward_coins, status, created_at, expires_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?)").run(randomUUID(), userId, target?.id ?? null, recipe.id, recipe.title, recipe.profession, batches, recipe.output.id, recipe.output.name, recipe.output.type, recipe.output.quality, outputQuantity, rewardCoins, now, now + ORDER_LIFETIME, now)
      return this.buildSnapshot(userId)
    })
  }

  consumeMaterials(userId, recipe, batches) {
    for (const ingredient of multipliedIngredients(recipe, batches)) {
      const row = this.db.prepare('SELECT quantity FROM player_inventory WHERE user_id = ? AND item_id = ?').get(userId, ingredient.id)
      if (!row || Number(row.quantity) < ingredient.quantity) throw new StoreError('commission-materials-changed', 'Материалы изменились. Обнови список заказов.', 409)
      if (Number(row.quantity) === ingredient.quantity) this.db.prepare('DELETE FROM player_inventory WHERE user_id = ? AND item_id = ?').run(userId, ingredient.id)
      else this.db.prepare('UPDATE player_inventory SET quantity = quantity - ? WHERE user_id = ? AND item_id = ?').run(ingredient.quantity, userId, ingredient.id)
    }
  }

  fulfillOrder(userId, orderIdValue, input) {
    this.expireOrders()
    const orderId = cleanText(orderIdValue, 96)
    return this.players.withReceipt(userId, input.requestId, `commission:fulfill:${orderId}`, () => {
      const order = this.db.prepare('SELECT * FROM craft_commissions WHERE id = ?').get(orderId)
      if (!order) throw new StoreError('commission-not-found', 'Заказ не найден.', 404)
      const reason = this.fulfillReason(userId, order)
      if (reason) throw new StoreError('commission-unavailable', reason, 409)
      const recipe = catalogById[order.recipe_id]
      const batches = Number(order.batch_count)
      this.consumeMaterials(userId, recipe, batches)
      const fee = Math.floor(Number(order.reward_coins) * COMMISSION_FEE_PERCENT / 100)
      const net = Number(order.reward_coins) - fee
      const now = Date.now()
      this.market.addStackOrEstate(order.requester_id, { id: order.output_item_id, name: order.output_item_name, type: order.output_item_type, quality: order.output_item_quality, quantity: Number(order.output_quantity) })
      this.market.creditCoinsOrEstate(userId, net)
      this.db.prepare("UPDATE craft_commissions SET fulfiller_id = ?, fee_coins = ?, status = 'fulfilled', updated_at = ?, closed_at = ? WHERE id = ? AND status = 'open'").run(userId, fee, now, now, order.id)
      this.db.prepare('INSERT INTO player_crafting_history(id, user_id, recipe_id, result_text, created_at) VALUES (?, ?, ?, ?, ?)').run(randomUUID(), userId, `commission:${recipe.id}`, `Заказ: ${order.output_item_name} ×${order.output_quantity}`, now)
      this.db.prepare('UPDATE player_characters SET reputation = reputation + ?, updated_at = ? WHERE user_id = ?').run(Math.min(3, batches), now, userId)
      return { ...this.buildSnapshot(userId), fulfillment: { orderId: order.id, itemName: order.output_item_name, quantity: Number(order.output_quantity), rewardCoins: net, feeCoins: fee } }
    })
  }

  cancelOrder(userId, orderIdValue, input) {
    this.expireOrders()
    const orderId = cleanText(orderIdValue, 96)
    return this.players.withReceipt(userId, input.requestId, `commission:cancel:${orderId}`, () => {
      this.ensureSafe(userId)
      const order = this.db.prepare('SELECT * FROM craft_commissions WHERE id = ? AND requester_id = ?').get(orderId, userId)
      if (!order) throw new StoreError('commission-not-found', 'Заказ не найден.', 404)
      if (order.status !== 'open') throw new StoreError('commission-closed', 'Заказ уже закрыт.', 409)
      const now = Date.now()
      this.db.prepare("UPDATE craft_commissions SET status = 'cancelled', updated_at = ?, closed_at = ? WHERE id = ? AND status = 'open'").run(now, now, order.id)
      this.market.creditCoinsOrEstate(userId, Number(order.reward_coins))
      return this.buildSnapshot(userId)
    })
  }
}
