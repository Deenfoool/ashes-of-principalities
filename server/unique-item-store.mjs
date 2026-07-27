import { randomUUID } from 'node:crypto'
import { applyMigration } from './migrations.mjs'
import { StoreError } from './store.mjs'

const LISTING_LIFETIME = 72 * 60 * 60 * 1000
const MAX_LISTINGS = 10
const MAX_PRICE = 100_000
const QUALITY_MULTIPLIER = { worn: 0.75, common: 1, good: 1.5, masterwork: 2.5 }
const STARTER_IDS = new Set(['smith-hammer', 'herb-satchel', 'short-bow', 'writing-kit', 'road-rope', 'worn-cloak'])

export const artifactBlueprints = [
  { id: 'ash-cleaver', profession: 'blacksmith', name: 'Пепельный тесак', description: 'Короткий клинок из перекованного дорожного железа.', templateId: 'ash-cleaver', type: 'weapon', quality: 'good', durability: 72, ingredients: { 'scrap-iron': 6, charcoal: 3, cloth: 1 }, coins: 12 },
  { id: 'root-satchel', profession: 'herbalist', name: 'Корневая сумка', description: 'Сумка с костяными застёжками для едких трав и настоев.', templateId: 'root-satchel', type: 'tool', quality: 'good', durability: 66, ingredients: { 'bitter-herb': 4, cloth: 3, 'river-bone': 1 }, coins: 10 },
  { id: 'river-bone-bow', profession: 'hunter', name: 'Лук из речной кости', description: 'Составной лук, укреплённый костью и обожжённой шкурой.', templateId: 'river-bone-bow', type: 'weapon', quality: 'good', durability: 70, ingredients: { 'burnt-hide': 3, 'river-bone': 3, cloth: 2 }, coins: 14 },
  { id: 'bone-writing-kit', profession: 'scribe', name: 'Костяной письменный набор', description: 'Письменный прибор с прочным костяным пером и дорожной чернильницей.', templateId: 'bone-writing-kit', type: 'tool', quality: 'good', durability: 68, ingredients: { 'river-bone': 2, charcoal: 3, cloth: 2 }, coins: 12 },
  { id: 'iron-road-hook', profession: 'carter', name: 'Кованый дорожный крюк', description: 'Тяжёлый крюк для груза, ворот и ближнего боя.', templateId: 'iron-road-hook', type: 'tool', quality: 'good', durability: 76, ingredients: { 'scrap-iron': 4, 'burnt-hide': 2, charcoal: 1 }, coins: 11 },
  { id: 'ash-path-cloak', profession: 'wanderer', name: 'Плащ пепельного пути', description: 'Плотный плащ с кожаной подкладкой и карманами для припасов.', templateId: 'ash-path-cloak', type: 'tool', quality: 'good', durability: 65, ingredients: { cloth: 4, 'burnt-hide': 2, 'bitter-herb': 2 }, coins: 10 },
]

const blueprintById = Object.fromEntries(artifactBlueprints.map((item) => [item.id, item]))
const cleanId = (value) => String(value ?? '').trim().slice(0, 96)
const positiveInteger = (value, field, maximum) => {
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number < 1 || number > maximum) {
    throw new StoreError('invalid-artifact-value', `${field} должно быть целым числом от 1 до ${maximum}.`)
  }
  return number
}

function publicItem(row) {
  return {
    id: row.id,
    templateId: row.template_id,
    name: row.item_name,
    quantity: 1,
    type: row.item_type,
    quality: row.quality,
    durability: Number(row.durability),
    maxDurability: Number(row.max_durability),
    equipped: Boolean(row.equipped),
    repairCount: Number(row.repair_count),
    broken: Number(row.durability) <= 0,
    unique: true,
    serialNumber: Number(row.serial_number),
    serial: `ПК-${String(row.serial_number).padStart(6, '0')}`,
    makerName: row.maker_name ?? null,
    originType: row.origin_type,
    originDetail: row.origin_detail,
    tradeCount: Number(row.trade_count),
    tradable: Boolean(row.tradable),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  }
}

function publicListing(row, userId) {
  return {
    id: row.listing_id,
    item: publicItem(row),
    sellerName: row.seller_name,
    sellerId: row.seller_id,
    unitPrice: Number(row.unit_price),
    status: row.listing_status,
    isMine: row.seller_id === userId,
    createdAt: Number(row.listing_created_at),
    expiresAt: Number(row.expires_at),
    closedAt: row.closed_at === null ? null : Number(row.closed_at),
  }
}

export class UniqueItemStore {
  constructor(gameStore, players, survival, market) {
    this.gameStore = gameStore
    this.players = players
    this.survival = survival
    this.market = market
    this.db = gameStore.db
    this.createSchema()
    this.installTriggers()
    this.migrateDurableStacks()
    this.patchSurvival()
  }

  createSchema() {
    applyMigration(this.db, '011_unique_items', () => {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS unique_items (
          id TEXT PRIMARY KEY,
          template_id TEXT NOT NULL,
          item_name TEXT NOT NULL,
          item_type TEXT NOT NULL CHECK(item_type IN ('tool', 'weapon', 'armor')),
          quality TEXT NOT NULL CHECK(quality IN ('worn', 'common', 'good', 'masterwork')),
          durability INTEGER NOT NULL CHECK(durability >= 0),
          max_durability INTEGER NOT NULL CHECK(max_durability > 0),
          equipped INTEGER NOT NULL DEFAULT 0 CHECK(equipped IN (0, 1)),
          repair_count INTEGER NOT NULL DEFAULT 0 CHECK(repair_count >= 0),
          owner_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
          lineage_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          maker_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
          origin_type TEXT NOT NULL,
          origin_detail TEXT NOT NULL DEFAULT '',
          serial_number INTEGER NOT NULL UNIQUE CHECK(serial_number > 0),
          trade_count INTEGER NOT NULL DEFAULT 0 CHECK(trade_count >= 0),
          tradable INTEGER NOT NULL DEFAULT 1 CHECK(tradable IN (0, 1)),
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        ) STRICT;

        CREATE TABLE IF NOT EXISTS unique_item_history (
          id TEXT PRIMARY KEY,
          item_id TEXT NOT NULL REFERENCES unique_items(id) ON DELETE CASCADE,
          event_type TEXT NOT NULL,
          actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
          from_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
          to_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
          details_json TEXT NOT NULL DEFAULT '{}',
          created_at INTEGER NOT NULL
        ) STRICT;

        CREATE TABLE IF NOT EXISTS unique_item_listings (
          id TEXT PRIMARY KEY,
          item_id TEXT NOT NULL UNIQUE REFERENCES unique_items(id) ON DELETE CASCADE,
          seller_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          unit_price INTEGER NOT NULL CHECK(unit_price > 0),
          status TEXT NOT NULL CHECK(status IN ('active', 'sold', 'cancelled', 'expired')),
          created_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL,
          closed_at INTEGER
        ) STRICT;

        CREATE TABLE IF NOT EXISTS unique_item_trades (
          id TEXT PRIMARY KEY,
          listing_id TEXT NOT NULL REFERENCES unique_item_listings(id),
          item_id TEXT NOT NULL REFERENCES unique_items(id),
          seller_id TEXT NOT NULL REFERENCES users(id),
          buyer_id TEXT NOT NULL REFERENCES users(id),
          gross INTEGER NOT NULL CHECK(gross > 0),
          fee INTEGER NOT NULL CHECK(fee >= 0),
          seller_net INTEGER NOT NULL CHECK(seller_net >= 0),
          created_at INTEGER NOT NULL
        ) STRICT;

        CREATE INDEX IF NOT EXISTS idx_unique_owner ON unique_items(owner_user_id, equipped DESC, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_unique_maker ON unique_items(maker_user_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_unique_history_item ON unique_item_history(item_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_unique_listings_active ON unique_item_listings(status, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_unique_listings_expiry ON unique_item_listings(status, expires_at);
        CREATE INDEX IF NOT EXISTS idx_unique_trades_user ON unique_item_trades(seller_id, buyer_id, created_at DESC);
      `)
    })
  }

  installTriggers() {
    this.db.exec(`
      DROP TRIGGER IF EXISTS trg_survival_classify_starter_items;
      DROP TRIGGER IF EXISTS trg_survival_tool_wear;
      DROP TRIGGER IF EXISTS trg_survival_persist_equipped_tool;
      DROP TRIGGER IF EXISTS trg_survival_chapter_reward;

      CREATE TRIGGER IF NOT EXISTS trg_unique_starter_item
      AFTER INSERT ON player_inventory
      WHEN NEW.item_id IN ('smith-hammer', 'herb-satchel', 'short-bow', 'writing-kit', 'road-rope', 'worn-cloak')
      BEGIN
        UPDATE unique_items SET equipped = 0, updated_at = unixepoch('subsec') * 1000
        WHERE owner_user_id = NEW.user_id AND equipped = 1;
        INSERT INTO unique_items(
          id, template_id, item_name, item_type, quality, durability, max_durability,
          equipped, repair_count, owner_user_id, lineage_user_id, maker_user_id, origin_type, origin_detail,
          serial_number, trade_count, tradable, created_at, updated_at
        ) VALUES (
          lower(hex(randomblob(16))), NEW.item_id, NEW.item_name, 'tool', 'common', 40, 40,
          1, 0, NEW.user_id, NEW.user_id, NULL, 'starter',
          'generation:' || COALESCE((SELECT generation FROM player_characters WHERE user_id = NEW.user_id), 1),
          COALESCE((SELECT MAX(serial_number) FROM unique_items), 0) + 1, 0, 0,
          unixepoch('subsec') * 1000, unixepoch('subsec') * 1000
        );
        DELETE FROM player_inventory WHERE user_id = NEW.user_id AND item_id = NEW.item_id;
      END;

      CREATE TRIGGER IF NOT EXISTS trg_unique_chapter_reward
      AFTER UPDATE OF chapter_complete ON player_story_state
      WHEN OLD.chapter_complete = 0 AND NEW.chapter_complete = 1
        AND NOT EXISTS (
          SELECT 1 FROM unique_items
          WHERE lineage_user_id = NEW.user_id AND origin_type = 'chapter-reward'
            AND origin_detail = 'generation:' || (SELECT generation FROM player_characters WHERE user_id = NEW.user_id)
        )
      BEGIN
        INSERT INTO unique_items(
          id, template_id, item_name, item_type, quality, durability, max_durability,
          equipped, repair_count, owner_user_id, lineage_user_id, maker_user_id, origin_type, origin_detail,
          serial_number, trade_count, tradable, created_at, updated_at
        ) VALUES (
          lower(hex(randomblob(16))), 'road-blade', 'Дорожный тесак', 'weapon', 'good', 60, 60,
          0, 0, NEW.user_id, NEW.user_id, NULL, 'chapter-reward',
          'generation:' || (SELECT generation FROM player_characters WHERE user_id = NEW.user_id),
          COALESCE((SELECT MAX(serial_number) FROM unique_items), 0) + 1, 0, 1,
          unixepoch('subsec') * 1000, unixepoch('subsec') * 1000
        );
      END;

      CREATE TRIGGER IF NOT EXISTS trg_unique_tool_wear
      AFTER INSERT ON player_action_receipts
      WHEN NEW.action IN ('expedition:attack', 'expedition:profession')
      BEGIN
        UPDATE unique_items SET durability = max(0, durability - 1), updated_at = unixepoch('subsec') * 1000
        WHERE owner_user_id = NEW.user_id AND equipped = 1;
      END;

      CREATE TRIGGER IF NOT EXISTS trg_unique_craft_repair
      AFTER INSERT ON player_action_receipts
      WHEN NEW.action = 'craft:use-repair-kit'
      BEGIN
        UPDATE unique_items SET durability = MIN(max_durability, durability + 20), updated_at = unixepoch('subsec') * 1000
        WHERE owner_user_id = NEW.user_id AND equipped = 1;
      END;

      CREATE TRIGGER IF NOT EXISTS trg_unique_craft_reinforce
      AFTER INSERT ON player_action_receipts
      WHEN NEW.action IN ('craft:reinforce-tool-hunter', 'craft:reinforce-tool-carter')
      BEGIN
        UPDATE unique_items SET max_durability = MIN(100, max_durability + 10),
          durability = MIN(MIN(100, max_durability + 10), durability + 10),
          updated_at = unixepoch('subsec') * 1000
        WHERE owner_user_id = NEW.user_id AND equipped = 1;
      END;

      CREATE TRIGGER IF NOT EXISTS trg_unique_craft_reforge_good
      AFTER INSERT ON player_action_receipts
      WHEN NEW.action = 'craft:reforge-good'
      BEGIN
        UPDATE unique_items SET quality = 'good', max_durability = MIN(120, max_durability + 20),
          durability = MIN(120, max_durability + 20), repair_count = repair_count + 1,
          updated_at = unixepoch('subsec') * 1000
        WHERE owner_user_id = NEW.user_id AND equipped = 1;
      END;

      CREATE TRIGGER IF NOT EXISTS trg_unique_craft_reforge_masterwork
      AFTER INSERT ON player_action_receipts
      WHEN NEW.action = 'craft:reforge-masterwork'
      BEGIN
        UPDATE unique_items SET quality = 'masterwork', max_durability = MIN(120, max_durability + 25),
          durability = MIN(120, max_durability + 25), repair_count = repair_count + 1,
          updated_at = unixepoch('subsec') * 1000
        WHERE owner_user_id = NEW.user_id AND equipped = 1;
      END;

      CREATE TRIGGER IF NOT EXISTS trg_unique_persist_loadout
      AFTER INSERT ON player_action_receipts
      WHEN NEW.action LIKE 'equip:%'
      BEGIN
        INSERT INTO player_loadouts(user_id, slot, item_id, updated_at)
        SELECT NEW.user_id, 'tool', id, unixepoch('subsec') * 1000
        FROM unique_items WHERE owner_user_id = NEW.user_id AND equipped = 1 LIMIT 1
        ON CONFLICT(user_id, slot) DO UPDATE SET item_id = excluded.item_id, updated_at = excluded.updated_at;
      END;
    `)
  }

  nextSerial() {
    return Number(this.db.prepare('SELECT COALESCE(MAX(serial_number), 0) + 1 AS value FROM unique_items').get().value)
  }

  history(itemId, eventType, actorUserId, fromUserId, toUserId, details = {}) {
    this.db.prepare(`
      INSERT INTO unique_item_history(id, item_id, event_type, actor_user_id, from_user_id, to_user_id, details_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(randomUUID(), itemId, eventType, actorUserId ?? null, fromUserId ?? null, toUserId ?? null, JSON.stringify(details), Date.now())
  }

  createItem({ ownerUserId, makerUserId = null, templateId, name, type = 'tool', quality = 'common', durability = 40, originType, originDetail = '', tradable = true }) {
    const id = randomUUID()
    const now = Date.now()
    this.db.prepare(`
      INSERT INTO unique_items(
        id, template_id, item_name, item_type, quality, durability, max_durability,
        equipped, repair_count, owner_user_id, lineage_user_id, maker_user_id, origin_type, origin_detail,
        serial_number, trade_count, tradable, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
    `).run(id, templateId, name, type, quality, durability, durability, ownerUserId, ownerUserId, makerUserId, originType, originDetail, this.nextSerial(), tradable ? 1 : 0, now, now)
    this.history(id, 'created', makerUserId ?? ownerUserId, null, ownerUserId, { originType, originDetail })
    return this.itemRow(id)
  }

  migrateDurableStacks() {
    const rows = this.db.prepare('SELECT * FROM player_inventory WHERE max_durability > 0 ORDER BY user_id, item_id').all()
    for (const row of rows) {
      const originType = row.item_id === 'road-blade' ? 'chapter-reward' : STARTER_IDS.has(row.item_id) ? 'legacy-starter' : 'legacy-migration'
      const generation = Number(this.db.prepare('SELECT generation FROM player_characters WHERE user_id = ?').get(row.user_id)?.generation ?? 1)
      const existing = row.item_id === 'road-blade'
        ? this.db.prepare("SELECT id FROM unique_items WHERE lineage_user_id = ? AND template_id = 'road-blade' AND origin_type = 'chapter-reward'").get(row.user_id)
        : null
      if (!existing) {
        this.createItem({ ownerUserId: row.user_id, templateId: row.item_id, name: row.item_name, type: row.item_id === 'road-blade' ? 'weapon' : 'tool', quality: row.quality, durability: Math.max(1, Number(row.max_durability)), originType, originDetail: `generation:${generation}`, tradable: !STARTER_IDS.has(row.item_id) })
        const created = this.db.prepare('SELECT id FROM unique_items WHERE owner_user_id = ? AND template_id = ? ORDER BY created_at DESC LIMIT 1').get(row.user_id, row.item_id)
        this.db.prepare('UPDATE unique_items SET durability = ?, max_durability = ?, equipped = ?, repair_count = ? WHERE id = ?').run(Number(row.durability), Number(row.max_durability), Number(row.equipped), Number(row.repair_count), created.id)
      }
      this.db.prepare('DELETE FROM player_inventory WHERE user_id = ? AND item_id = ?').run(row.user_id, row.item_id)
    }
    this.db.prepare(`
      UPDATE unique_items SET equipped = 0
      WHERE equipped = 1 AND id NOT IN (
        SELECT id FROM unique_items chosen
        WHERE chosen.id = (
          SELECT candidate.id FROM unique_items candidate
          WHERE candidate.owner_user_id = chosen.owner_user_id
          ORDER BY candidate.equipped DESC, candidate.updated_at DESC LIMIT 1
        )
      )
    `).run()
    this.db.prepare(`
      INSERT INTO player_loadouts(user_id, slot, item_id, updated_at)
      SELECT owner_user_id, 'tool', id, updated_at FROM unique_items WHERE equipped = 1 AND owner_user_id IS NOT NULL
      ON CONFLICT(user_id, slot) DO UPDATE SET item_id = excluded.item_id, updated_at = excluded.updated_at
    `).run()
  }

  itemRow(itemId) {
    return this.db.prepare('SELECT ui.*, maker.display_name AS maker_name FROM unique_items ui LEFT JOIN users maker ON maker.id = ui.maker_user_id WHERE ui.id = ?').get(itemId)
  }

  ownedRows(userId) {
    return this.db.prepare('SELECT ui.*, maker.display_name AS maker_name FROM unique_items ui LEFT JOIN users maker ON maker.id = ui.maker_user_id WHERE ui.owner_user_id = ? ORDER BY ui.equipped DESC, ui.created_at DESC').all(userId)
  }

  ownedItems(userId) { return this.ownedRows(userId).map(publicItem) }
  equippedRow(userId) { return this.db.prepare('SELECT * FROM unique_items WHERE owner_user_id = ? AND equipped = 1 LIMIT 1').get(userId) }

  patchCrafting(crafting) {
    crafting.equippedTool = (userId) => {
      const row = this.equippedRow(userId)
      return row ? { ...row, item_id: row.id, item_name: row.item_name } : undefined
    }
    const originalCraft = crafting.craft.bind(crafting)
    const toolRecipes = new Set(['use-repair-kit', 'reinforce-tool-hunter', 'reinforce-tool-carter', 'reforge-good', 'reforge-masterwork'])
    crafting.craft = (userId, recipeId, input) => {
      const result = originalCraft(userId, recipeId, input)
      if (!toolRecipes.has(String(recipeId))) return result
      return { ...crafting.workshop(userId), crafted: result.crafted }
    }
  }

  patchSurvival() {
    const originalGetInventory = this.survival.getInventory.bind(this.survival)
    this.survival.getInventory = (userId) => [...originalGetInventory(userId).filter((item) => Number(item.maxDurability) <= 0), ...this.ownedItems(userId)]
    this.survival.repairItem = (userId, itemId, input) => this.repairItem(userId, itemId, input)
    this.survival.equipItem = (userId, itemId, input) => this.equipItem(userId, itemId, input)
  }

  safeReason(userId) {
    const character = this.db.prepare('SELECT alive FROM player_characters WHERE user_id = ?').get(userId)
    if (!character?.alive) return 'Работать с артефактами может только живой герой.'
    if (this.players.getActiveRun(userId)) return 'Артефакты недоступны во время похода.'
    const story = this.db.prepare('SELECT scene_id, chapter_complete FROM player_story_state WHERE user_id = ?').get(userId)
    if (!story || (!Number(story.chapter_complete) && story.scene_id !== 'tavern')) return 'Работать можно в трактире или после завершения первой главы.'
    return null
  }

  ensureSafe(userId) {
    const reason = this.safeReason(userId)
    if (reason) throw new StoreError('artifact-unavailable', reason, 409)
  }

  repairItem(userId, itemIdValue, input) {
    const itemId = cleanId(itemIdValue)
    return this.players.withReceipt(userId, input.requestId, `repair:${itemId}`, () => {
      this.ensureSafe(userId)
      const character = this.db.prepare('SELECT profession, coins FROM player_characters WHERE user_id = ? AND alive = 1').get(userId)
      const item = this.db.prepare('SELECT * FROM unique_items WHERE id = ? AND owner_user_id = ?').get(itemId, userId)
      if (!item) throw new StoreError('item-not-repairable', 'Уникальный предмет не найден.', 404)
      const missing = Number(item.max_durability) - Number(item.durability)
      if (missing <= 0) throw new StoreError('item-not-damaged', 'Предмет не нуждается в ремонте.', 409)
      const guild = this.gameStore.getGuildForUser(userId)
      const workshopDiscount = Math.min(0.25, Number(guild?.branches?.workshops ?? 0) * 0.05)
      const professionDiscount = character.profession === 'blacksmith' ? 0.5 : 1
      const cost = Math.max(1, Math.ceil(missing / 8 * (QUALITY_MULTIPLIER[item.quality] ?? 1) * professionDiscount * (1 - workshopDiscount)))
      if (Number(character.coins) < cost) throw new StoreError('not-enough-coins', `Для ремонта нужно ${cost} монет.`, 409)
      const now = Date.now()
      this.db.prepare('UPDATE player_characters SET coins = coins - ?, updated_at = ? WHERE user_id = ?').run(cost, now, userId)
      this.db.prepare('UPDATE unique_items SET durability = max_durability, repair_count = repair_count + 1, updated_at = ? WHERE id = ?').run(now, itemId)
      this.history(itemId, 'repaired', userId, userId, userId, { cost })
      return { character: this.players.getCharacter(userId), cost }
    })
  }

  equipItem(userId, itemIdValue, input) {
    const itemId = cleanId(itemIdValue)
    return this.players.withReceipt(userId, input.requestId, `equip:${itemId}`, () => {
      if (this.players.getActiveRun(userId)) throw new StoreError('expedition-active', 'Нельзя менять снаряжение во время боя.', 409)
      const item = this.db.prepare('SELECT id FROM unique_items WHERE id = ? AND owner_user_id = ?').get(itemId, userId)
      if (!item) throw new StoreError('item-not-equippable', 'Этот уникальный предмет не принадлежит герою.', 409)
      const now = Date.now()
      this.db.prepare('UPDATE unique_items SET equipped = 0, updated_at = ? WHERE owner_user_id = ?').run(now, userId)
      this.db.prepare('UPDATE unique_items SET equipped = 1, updated_at = ? WHERE id = ?').run(now, itemId)
      this.history(itemId, 'equipped', userId, userId, userId)
      return { character: this.players.getCharacter(userId) }
    })
  }

  consumeMaterials(userId, ingredients) {
    for (const [itemId, quantity] of Object.entries(ingredients)) {
      const row = this.db.prepare('SELECT quantity FROM player_inventory WHERE user_id = ? AND item_id = ?').get(userId, itemId)
      if (!row || Number(row.quantity) < quantity) throw new StoreError('artifact-materials-changed', 'Материалы изменились. Обнови кузницу.', 409)
      if (Number(row.quantity) === quantity) this.db.prepare('DELETE FROM player_inventory WHERE user_id = ? AND item_id = ?').run(userId, itemId)
      else this.db.prepare('UPDATE player_inventory SET quantity = quantity - ? WHERE user_id = ? AND item_id = ?').run(quantity, userId, itemId)
    }
  }

  blueprintReason(userId, blueprint, character) {
    if (!character?.alive) return 'Для изготовления нужен живой герой.'
    const safe = this.safeReason(userId)
    if (safe) return safe
    if (character.profession !== blueprint.profession) return 'Чертёж требует другое ремесло.'
    if (Number(character.coins) < blueprint.coins) return `Нужно монет: ${blueprint.coins}.`
    for (const [itemId, quantity] of Object.entries(blueprint.ingredients)) {
      const owned = Number(this.db.prepare('SELECT quantity FROM player_inventory WHERE user_id = ? AND item_id = ?').get(userId, itemId)?.quantity ?? 0)
      if (owned < quantity) return `Не хватает материала: ${itemId} ×${quantity}.`
    }
    return null
  }

  forge(userId, blueprintIdValue, input) {
    const blueprintId = cleanId(blueprintIdValue)
    const blueprint = blueprintById[blueprintId]
    if (!blueprint) throw new StoreError('artifact-blueprint-not-found', 'Такого чертежа нет.', 404)
    return this.players.withReceipt(userId, input.requestId, `artifact:forge:${blueprintId}`, () => {
      const character = this.players.getCharacter(userId)
      const reason = this.blueprintReason(userId, blueprint, character)
      if (reason) throw new StoreError('artifact-blueprint-unavailable', reason, 409)
      this.consumeMaterials(userId, blueprint.ingredients)
      const now = Date.now()
      this.db.prepare('UPDATE player_characters SET coins = coins - ?, reputation = reputation + 2, updated_at = ? WHERE user_id = ?').run(blueprint.coins, now, userId)
      const row = this.createItem({ ownerUserId: userId, makerUserId: userId, templateId: blueprint.templateId, name: blueprint.name, type: blueprint.type, quality: blueprint.quality, durability: blueprint.durability, originType: 'crafted', originDetail: blueprint.id, tradable: true })
      this.db.prepare('INSERT INTO player_crafting_history(id, user_id, recipe_id, result_text, created_at) VALUES (?, ?, ?, ?, ?)').run(randomUUID(), userId, `artifact:${blueprint.id}`, `${blueprint.name} · ПК-${String(row.serial_number).padStart(6, '0')}`, now)
      return { ...this.snapshot(userId), forged: publicItem({ ...row, maker_name: character.name }) }
    })
  }

  expireListings(now = Date.now()) {
    const rows = this.db.prepare("SELECT * FROM unique_item_listings WHERE status = 'active' AND expires_at <= ? ORDER BY expires_at LIMIT 100").all(now)
    if (!rows.length) return 0
    this.gameStore.transaction(() => {
      for (const row of rows) {
        const closed = this.db.prepare("UPDATE unique_item_listings SET status = 'expired', closed_at = ? WHERE id = ? AND status = 'active'").run(now, row.id)
        if (Number(closed.changes) < 1) continue
        this.db.prepare('UPDATE unique_items SET owner_user_id = ?, updated_at = ? WHERE id = ? AND owner_user_id IS NULL').run(row.seller_id, now, row.item_id)
        this.history(row.item_id, 'listing-expired', null, null, row.seller_id)
      }
    })
    return rows.length
  }

  listingRows(userId, own = false) {
    const where = own ? 'uil.seller_id = ?' : "uil.status = 'active'"
    const params = own ? [userId] : []
    return this.db.prepare(`
      SELECT ui.*, maker.display_name AS maker_name, seller.display_name AS seller_name,
        uil.id AS listing_id, uil.seller_id, uil.unit_price, uil.status AS listing_status,
        uil.created_at AS listing_created_at, uil.expires_at, uil.closed_at
      FROM unique_item_listings uil
      JOIN unique_items ui ON ui.id = uil.item_id
      LEFT JOIN users maker ON maker.id = ui.maker_user_id
      JOIN users seller ON seller.id = uil.seller_id
      WHERE ${where}
      ORDER BY uil.created_at DESC LIMIT 60
    `).all(...params).map((row) => publicListing(row, userId))
  }

  leaderboard() {
    const hasCommissions = Boolean(this.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'craft_commissions'").get())
    const commissionJoin = hasCommissions ? `LEFT JOIN (SELECT fulfiller_id, COUNT(*) AS fulfilled FROM craft_commissions WHERE status = 'fulfilled' GROUP BY fulfiller_id) c ON c.fulfiller_id = u.id` : ''
    const commissionField = hasCommissions ? 'COALESCE(c.fulfilled, 0)' : '0'
    return this.db.prepare(`
      SELECT u.id, u.display_name AS name, pc.profession, pc.reputation,
        COUNT(DISTINCT ui.id) AS crafted, ${commissionField} AS fulfilled,
        pc.reputation + COUNT(DISTINCT ui.id) * 2 + ${commissionField} * 3 AS score
      FROM users u JOIN player_characters pc ON pc.user_id = u.id
      LEFT JOIN unique_items ui ON ui.maker_user_id = u.id AND ui.origin_type = 'crafted'
      ${commissionJoin}
      GROUP BY u.id, u.display_name, pc.profession, pc.reputation${hasCommissions ? ', c.fulfilled' : ''}
      HAVING COUNT(DISTINCT ui.id) > 0 OR ${commissionField} > 0
      ORDER BY score DESC, crafted DESC, u.display_name LIMIT 20
    `).all().map((row, index) => ({ rank: index + 1, name: row.name, profession: row.profession, reputation: Number(row.reputation), crafted: Number(row.crafted), fulfilled: Number(row.fulfilled), score: Number(row.score) }))
  }

  snapshot(userId) {
    this.expireListings()
    const character = this.players.getCharacter(userId)
    const blueprints = artifactBlueprints.map((blueprint) => ({ ...blueprint, available: !this.blueprintReason(userId, blueprint, character), reason: this.blueprintReason(userId, blueprint, character) }))
    const trades = this.db.prepare(`
      SELECT uit.*, ui.item_name, seller.display_name AS seller_name, buyer.display_name AS buyer_name
      FROM unique_item_trades uit JOIN unique_items ui ON ui.id = uit.item_id
      JOIN users seller ON seller.id = uit.seller_id JOIN users buyer ON buyer.id = uit.buyer_id
      WHERE uit.seller_id = ? OR uit.buyer_id = ? ORDER BY uit.created_at DESC LIMIT 40
    `).all(userId, userId).map((row) => ({ id: row.id, itemName: row.item_name, sellerName: row.seller_name, buyerName: row.buyer_name, side: row.buyer_id === userId ? 'purchase' : 'sale', gross: Number(row.gross), fee: Number(row.fee), sellerNet: Number(row.seller_net), createdAt: Number(row.created_at) }))
    return { character, safe: !this.safeReason(userId), safeReason: this.safeReason(userId), listingLifetimeHours: LISTING_LIFETIME / 3_600_000, blueprints, owned: this.ownedItems(userId), listings: this.listingRows(userId), ownListings: this.listingRows(userId, true), trades, leaderboard: this.leaderboard() }
  }

  createListing(userId, itemIdValue, input) {
    const itemId = cleanId(itemIdValue)
    const unitPrice = positiveInteger(input.unitPrice, 'Цена', MAX_PRICE)
    return this.players.withReceipt(userId, input.requestId, `artifact:list:${itemId}:${unitPrice}`, () => {
      this.ensureSafe(userId)
      const item = this.db.prepare('SELECT * FROM unique_items WHERE id = ? AND owner_user_id = ?').get(itemId, userId)
      if (!item) throw new StoreError('artifact-not-found', 'Уникальный предмет не найден.', 404)
      if (!Number(item.tradable)) throw new StoreError('artifact-bound', 'Этот предмет связан с родом и не продаётся.', 409)
      if (Number(item.equipped)) throw new StoreError('artifact-equipped', 'Сначала сними предмет.', 409)
      const count = Number(this.db.prepare("SELECT COUNT(*) AS count FROM unique_item_listings WHERE seller_id = ? AND status = 'active'").get(userId).count)
      if (count >= MAX_LISTINGS) throw new StoreError('artifact-listing-limit', `Можно держать не более ${MAX_LISTINGS} активных объявлений.`, 409)
      const now = Date.now()
      const listingId = randomUUID()
      this.db.prepare('UPDATE unique_items SET owner_user_id = NULL, updated_at = ? WHERE id = ?').run(now, itemId)
      this.db.prepare("INSERT INTO unique_item_listings(id, item_id, seller_id, unit_price, status, created_at, expires_at) VALUES (?, ?, ?, ?, 'active', ?, ?)").run(listingId, itemId, userId, unitPrice, now, now + LISTING_LIFETIME)
      this.history(itemId, 'listed', userId, userId, null, { listingId, unitPrice })
      return this.snapshot(userId)
    })
  }

  buyListing(userId, listingIdValue, input) {
    const listingId = cleanId(listingIdValue)
    return this.players.withReceipt(userId, input.requestId, `artifact:buy:${listingId}`, () => {
      this.ensureSafe(userId)
      this.expireListings()
      const listing = this.db.prepare("SELECT * FROM unique_item_listings WHERE id = ? AND status = 'active'").get(listingId)
      if (!listing) throw new StoreError('artifact-listing-not-found', 'Активное объявление не найдено.', 404)
      if (listing.seller_id === userId) throw new StoreError('artifact-self-purchase', 'Нельзя купить собственный предмет.', 409)
      const buyer = this.db.prepare('SELECT coins, alive FROM player_characters WHERE user_id = ?').get(userId)
      if (!buyer?.alive) throw new StoreError('character-required', 'Для покупки нужен живой герой.', 404)
      const gross = Number(listing.unit_price)
      if (Number(buyer.coins) < gross) throw new StoreError('not-enough-coins', `Для покупки нужно ${gross} монет.`, 409)
      const fee = Math.floor(gross * 5 / 100)
      const net = gross - fee
      const now = Date.now()
      this.db.prepare('UPDATE player_characters SET coins = coins - ?, updated_at = ? WHERE user_id = ?').run(gross, now, userId)
      this.market.creditCoinsOrEstate(listing.seller_id, net)
      this.db.prepare('UPDATE unique_items SET owner_user_id = ?, equipped = 0, trade_count = trade_count + 1, updated_at = ? WHERE id = ? AND owner_user_id IS NULL').run(userId, now, listing.item_id)
      this.db.prepare("UPDATE unique_item_listings SET status = 'sold', closed_at = ? WHERE id = ? AND status = 'active'").run(now, listingId)
      this.db.prepare('INSERT INTO unique_item_trades(id, listing_id, item_id, seller_id, buyer_id, gross, fee, seller_net, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(randomUUID(), listingId, listing.item_id, listing.seller_id, userId, gross, fee, net, now)
      this.history(listing.item_id, 'sold', userId, listing.seller_id, userId, { gross, fee, net })
      return { ...this.snapshot(userId), purchase: { listingId, itemId: listing.item_id, gross, fee } }
    })
  }

  cancelListing(userId, listingIdValue, input) {
    const listingId = cleanId(listingIdValue)
    return this.players.withReceipt(userId, input.requestId, `artifact:cancel:${listingId}`, () => {
      this.ensureSafe(userId)
      const listing = this.db.prepare('SELECT * FROM unique_item_listings WHERE id = ? AND seller_id = ?').get(listingId, userId)
      if (!listing) throw new StoreError('artifact-listing-not-found', 'Объявление не найдено.', 404)
      if (listing.status !== 'active') throw new StoreError('artifact-listing-closed', 'Объявление уже закрыто.', 409)
      const now = Date.now()
      this.db.prepare("UPDATE unique_item_listings SET status = 'cancelled', closed_at = ? WHERE id = ? AND status = 'active'").run(now, listingId)
      this.db.prepare('UPDATE unique_items SET owner_user_id = ?, updated_at = ? WHERE id = ? AND owner_user_id IS NULL').run(userId, now, listing.item_id)
      this.history(listing.item_id, 'listing-cancelled', userId, null, userId)
      return this.snapshot(userId)
    })
  }
}
