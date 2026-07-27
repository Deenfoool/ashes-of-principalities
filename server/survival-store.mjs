import { randomUUID } from 'node:crypto'
import { StoreError } from './store.mjs'

const QUALITY_MULTIPLIER = { worn: 0.75, common: 1, good: 1.5, masterwork: 2.5 }
const STARTER_TOOLS = {
  blacksmith: ['smith-hammer', 'Кузнечный молоток'],
  herbalist: ['herb-satchel', 'Сумка с травами'],
  hunter: ['short-bow', 'Короткий лук'],
  scribe: ['writing-kit', 'Письменный набор'],
  carter: ['road-rope', 'Дорожная верёвка'],
  wanderer: ['worn-cloak', 'Потёртый плащ'],
}

const cleanGuildName = (value) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, 28)
const cleanGuildTag = (value) => String(value ?? '').toUpperCase().replace(/[^А-ЯЁA-Z0-9]/g, '').slice(0, 5)

function addColumnIfMissing(db, table, name, definition) {
  const columns = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name))
  if (!columns.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`)
}

function publicInjury(row) {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    severity: Number(row.severity),
    status: row.status,
    source: row.source,
    createdAt: Number(row.created_at),
  }
}

export class SurvivalStore {
  constructor(gameStore, players) {
    this.gameStore = gameStore
    this.players = players
    this.db = gameStore.db
    this.createSchema()
    this.migrateExistingItems()
    this.installPlayerDecorators()
  }

  createSchema() {
    addColumnIfMissing(this.db, 'player_inventory', 'item_type', "TEXT NOT NULL DEFAULT 'material'")
    addColumnIfMissing(this.db, 'player_inventory', 'quality', "TEXT NOT NULL DEFAULT 'common'")
    addColumnIfMissing(this.db, 'player_inventory', 'durability', 'INTEGER NOT NULL DEFAULT 0')
    addColumnIfMissing(this.db, 'player_inventory', 'max_durability', 'INTEGER NOT NULL DEFAULT 0')
    addColumnIfMissing(this.db, 'player_inventory', 'equipped', 'INTEGER NOT NULL DEFAULT 0')
    addColumnIfMissing(this.db, 'player_inventory', 'repair_count', 'INTEGER NOT NULL DEFAULT 0')

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS player_injuries (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        severity INTEGER NOT NULL CHECK(severity BETWEEN 1 AND 3),
        status TEXT NOT NULL CHECK(status IN ('active', 'treated')),
        source TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        treated_at INTEGER
      ) STRICT;

      CREATE UNIQUE INDEX IF NOT EXISTS idx_active_injury_kind
        ON player_injuries(user_id, kind) WHERE status = 'active';
      CREATE INDEX IF NOT EXISTS idx_injuries_user_status
        ON player_injuries(user_id, status, created_at DESC);

      CREATE TRIGGER IF NOT EXISTS trg_survival_classify_starter_items
      AFTER INSERT ON player_inventory
      WHEN NEW.item_id IN ('smith-hammer', 'herb-satchel', 'short-bow', 'writing-kit', 'road-rope', 'worn-cloak')
      BEGIN
        UPDATE player_inventory SET item_type = 'tool', quality = 'common', durability = 40,
          max_durability = 40, equipped = 1
        WHERE user_id = NEW.user_id AND item_id = NEW.item_id;
      END;

      CREATE TRIGGER IF NOT EXISTS trg_survival_classify_relic
      AFTER INSERT ON player_inventory
      WHEN NEW.item_id = 'family-relic'
      BEGIN
        UPDATE player_inventory SET item_type = 'relic', quality = 'masterwork'
        WHERE user_id = NEW.user_id AND item_id = NEW.item_id;
      END;

      CREATE TRIGGER IF NOT EXISTS trg_survival_tool_wear
      AFTER INSERT ON player_action_receipts
      WHEN NEW.action IN ('expedition:attack', 'expedition:profession')
      BEGIN
        UPDATE player_inventory SET durability = max(0, durability - 1)
        WHERE user_id = NEW.user_id AND equipped = 1 AND max_durability > 0;
      END;

      CREATE TRIGGER IF NOT EXISTS trg_survival_wounded_arm
      AFTER UPDATE OF health ON player_characters
      WHEN NEW.alive = 1 AND NEW.health > 0
        AND OLD.health * 2 > OLD.max_health AND NEW.health * 2 <= NEW.max_health
      BEGIN
        INSERT OR IGNORE INTO player_injuries(id, user_id, kind, title, severity, status, source, created_at)
        VALUES (lower(hex(randomblob(16))), NEW.user_id, 'wounded-arm', 'Раненая рука', 1, 'active', 'Тяжёлый удар', unixepoch('subsec') * 1000);
      END;

      CREATE TRIGGER IF NOT EXISTS trg_survival_sprained_ankle
      AFTER UPDATE OF health ON player_characters
      WHEN NEW.alive = 1 AND NEW.health > 0
        AND OLD.health * 4 > OLD.max_health AND NEW.health * 4 <= NEW.max_health
      BEGIN
        INSERT OR IGNORE INTO player_injuries(id, user_id, kind, title, severity, status, source, created_at)
        VALUES (lower(hex(randomblob(16))), NEW.user_id, 'sprained-ankle', 'Повреждённая нога', 2, 'active', 'Падение в бою', unixepoch('subsec') * 1000);
      END;

      CREATE TRIGGER IF NOT EXISTS trg_survival_arm_penalty
      AFTER INSERT ON player_action_receipts
      WHEN NEW.action IN ('expedition:attack', 'expedition:profession')
      BEGIN
        UPDATE player_characters SET stamina = max(0, stamina - COALESCE((
          SELECT MAX(severity) FROM player_injuries
          WHERE user_id = NEW.user_id AND kind = 'wounded-arm' AND status = 'active'
        ), 0)), updated_at = unixepoch('subsec') * 1000
        WHERE user_id = NEW.user_id;
      END;

      CREATE TRIGGER IF NOT EXISTS trg_survival_ankle_penalty
      AFTER INSERT ON player_action_receipts
      WHEN NEW.action = 'expedition:flee'
      BEGIN
        UPDATE player_characters SET stamina = max(0, stamina - COALESCE((
          SELECT MAX(severity) FROM player_injuries
          WHERE user_id = NEW.user_id AND kind = 'sprained-ankle' AND status = 'active'
        ), 0)), updated_at = unixepoch('subsec') * 1000
        WHERE user_id = NEW.user_id;
      END;

      CREATE TRIGGER IF NOT EXISTS trg_survival_clear_injuries_for_heir
      AFTER UPDATE OF generation ON player_characters
      WHEN NEW.generation > OLD.generation
      BEGIN
        UPDATE player_injuries SET status = 'treated', treated_at = unixepoch('subsec') * 1000
        WHERE user_id = NEW.user_id AND status = 'active';
      END;

      CREATE TRIGGER IF NOT EXISTS trg_survival_founder_seal
      AFTER UPDATE OF status ON player_story_quests
      WHEN OLD.status = 'active' AND NEW.status = 'completed'
      BEGIN
        INSERT OR IGNORE INTO player_inventory(
          user_id, item_id, item_name, quantity, item_type, quality,
          durability, max_durability, equipped, repair_count
        ) VALUES (
          NEW.user_id, 'founder-seal', 'Печать основателя', 1, 'quest', 'good', 0, 0, 0, 0
        );
      END;
    `)
  }

  migrateExistingItems() {
    const starterIds = Object.values(STARTER_TOOLS).map(([id]) => id)
    const placeholders = starterIds.map(() => '?').join(', ')
    this.db.prepare(`
      UPDATE player_inventory SET item_type = 'tool', quality = 'common',
        max_durability = CASE WHEN max_durability > 0 THEN max_durability ELSE 40 END,
        durability = CASE WHEN durability > 0 THEN durability ELSE 40 END
      WHERE item_id IN (${placeholders})
    `).run(...starterIds)

    this.db.prepare(`
      UPDATE player_inventory SET equipped = CASE
        WHEN item_id = (SELECT CASE pc.profession
          WHEN 'blacksmith' THEN 'smith-hammer'
          WHEN 'herbalist' THEN 'herb-satchel'
          WHEN 'hunter' THEN 'short-bow'
          WHEN 'scribe' THEN 'writing-kit'
          WHEN 'carter' THEN 'road-rope'
          ELSE 'worn-cloak' END
          FROM player_characters pc WHERE pc.user_id = player_inventory.user_id)
        THEN 1 ELSE 0 END
      WHERE user_id IN (SELECT user_id FROM player_characters)
    `).run()

    this.db.prepare(`
      INSERT OR IGNORE INTO player_inventory(
        user_id, item_id, item_name, quantity, item_type, quality,
        durability, max_durability, equipped, repair_count
      )
      SELECT DISTINCT user_id, 'founder-seal', 'Печать основателя', 1, 'quest', 'good', 0, 0, 0, 0
      FROM player_story_quests WHERE status = 'completed'
    `).run()
  }

  getInventory(userId) {
    return this.db.prepare(`
      SELECT item_id AS id, item_name AS name, quantity, item_type AS type, quality,
        durability, max_durability AS maxDurability, equipped, repair_count AS repairCount
      FROM player_inventory WHERE user_id = ? ORDER BY equipped DESC, item_type, item_name
    `).all(userId).map((item) => ({
      ...item,
      quantity: Number(item.quantity),
      durability: Number(item.durability),
      maxDurability: Number(item.maxDurability),
      equipped: Boolean(item.equipped),
      repairCount: Number(item.repairCount),
      broken: Number(item.maxDurability) > 0 && Number(item.durability) <= 0,
    }))
  }

  getInjuries(userId) {
    return this.db.prepare(`
      SELECT * FROM player_injuries WHERE user_id = ? AND status = 'active'
      ORDER BY severity DESC, created_at DESC
    `).all(userId).map(publicInjury)
  }

  decorateCharacter(character) {
    if (!character) return null
    const inventory = this.getInventory(character.userId)
    const injuries = this.getInjuries(character.userId)
    return {
      ...character,
      inventory,
      injuries,
      equippedItem: inventory.find((item) => item.equipped) ?? null,
      combatModifiers: {
        attackStaminaPenalty: injuries.find((injury) => injury.kind === 'wounded-arm')?.severity ?? 0,
        fleeStaminaPenalty: injuries.find((injury) => injury.kind === 'sprained-ankle')?.severity ?? 0,
      },
    }
  }

  installPlayerDecorators() {
    if (this.players.__survivalInstalled) return
    this.players.__survivalInstalled = true

    const originalGetCharacter = this.players.getCharacter.bind(this.players)
    const originalCreateCharacter = this.players.createCharacter.bind(this.players)
    const originalCreateHeir = this.players.createHeir.bind(this.players)
    const originalActExpedition = this.players.actExpedition.bind(this.players)
    const originalRest = this.players.rest.bind(this.players)
    const originalDonateCoins = this.players.donateCoins.bind(this.players)

    this.players.getCharacter = (userId) => this.decorateCharacter(originalGetCharacter(userId))
    this.players.createCharacter = (userId, input) => {
      const result = originalCreateCharacter(userId, input)
      return { ...result, character: this.players.getCharacter(userId) }
    }
    this.players.createHeir = (userId, input) => {
      const result = originalCreateHeir(userId, input)
      return { ...result, character: this.players.getCharacter(userId) }
    }
    this.players.actExpedition = (userId, input) => {
      const action = String(input.action ?? '')
      if (action === 'profession') {
        const equipped = this.getInventory(userId).find((item) => item.equipped)
        if (equipped?.broken) throw new StoreError('tool-broken', 'Ремесленный инструмент сломан. Сначала отремонтируй его.', 409)
      }
      const result = originalActExpedition(userId, input)
      return { ...result, character: this.players.getCharacter(userId) }
    }
    this.players.rest = (userId, input) => {
      const result = originalRest(userId, input)
      return { ...result, character: this.players.getCharacter(userId) }
    }
    this.players.donateCoins = (userId, input) => {
      const result = originalDonateCoins(userId, input)
      return { ...result, character: this.players.getCharacter(userId) }
    }
  }

  ensureSafeWorkshop(userId) {
    if (this.players.getActiveRun(userId)) throw new StoreError('expedition-active', 'Нельзя заниматься лечением или ремонтом во время боя.', 409)
    const story = this.db.prepare('SELECT scene_id, chapter_complete FROM player_story_state WHERE user_id = ?').get(userId)
    if (!story || (!story.chapter_complete && story.scene_id !== 'tavern')) {
      throw new StoreError('workshop-unavailable', 'Ремонт и лечение доступны в трактире или после завершения главы.', 409)
    }
  }

  repairItem(userId, itemIdValue, input) {
    const itemId = String(itemIdValue ?? '').slice(0, 80)
    return this.players.withReceipt(userId, input.requestId, `repair:${itemId}`, () => {
      this.ensureSafeWorkshop(userId)
      const character = this.db.prepare('SELECT profession, coins FROM player_characters WHERE user_id = ? AND alive = 1').get(userId)
      if (!character) throw new StoreError('character-required', 'Для ремонта нужен живой герой.', 404)
      const item = this.db.prepare('SELECT * FROM player_inventory WHERE user_id = ? AND item_id = ?').get(userId, itemId)
      if (!item || Number(item.max_durability) <= 0) throw new StoreError('item-not-repairable', 'Этот предмет нельзя ремонтировать.', 409)
      const missing = Number(item.max_durability) - Number(item.durability)
      if (missing <= 0) throw new StoreError('item-not-damaged', 'Предмет не нуждается в ремонте.', 409)
      const qualityMultiplier = QUALITY_MULTIPLIER[item.quality] ?? 1
      const guild = this.gameStore.getGuildForUser(userId)
      const workshopDiscount = Math.min(0.25, Number(guild?.branches?.workshops ?? 0) * 0.05)
      const professionDiscount = character.profession === 'blacksmith' ? 0.5 : 1
      const cost = Math.max(1, Math.ceil(missing / 8 * qualityMultiplier * professionDiscount * (1 - workshopDiscount)))
      if (Number(character.coins) < cost) throw new StoreError('not-enough-coins', `Для ремонта нужно ${cost} монет.`, 409)
      const now = Date.now()
      this.db.prepare('UPDATE player_characters SET coins = coins - ?, updated_at = ? WHERE user_id = ?').run(cost, now, userId)
      this.db.prepare(`
        UPDATE player_inventory SET durability = max_durability, repair_count = repair_count + 1
        WHERE user_id = ? AND item_id = ?
      `).run(userId, itemId)
      return { character: this.players.getCharacter(userId), cost }
    })
  }

  equipItem(userId, itemIdValue, input) {
    const itemId = String(itemIdValue ?? '').slice(0, 80)
    return this.players.withReceipt(userId, input.requestId, `equip:${itemId}`, () => {
      if (this.players.getActiveRun(userId)) throw new StoreError('expedition-active', 'Нельзя менять снаряжение во время боя.', 409)
      const item = this.db.prepare('SELECT * FROM player_inventory WHERE user_id = ? AND item_id = ?').get(userId, itemId)
      if (!item || Number(item.max_durability) <= 0) throw new StoreError('item-not-equippable', 'Этот предмет нельзя экипировать.', 409)
      this.db.prepare('UPDATE player_inventory SET equipped = 0 WHERE user_id = ?').run(userId)
      this.db.prepare('UPDATE player_inventory SET equipped = 1 WHERE user_id = ? AND item_id = ?').run(userId, itemId)
      return { character: this.players.getCharacter(userId) }
    })
  }

  treatInjury(userId, injuryIdValue, input) {
    const injuryId = String(injuryIdValue ?? '').slice(0, 80)
    return this.players.withReceipt(userId, input.requestId, `treat:${injuryId}`, () => {
      this.ensureSafeWorkshop(userId)
      const character = this.db.prepare('SELECT profession, coins FROM player_characters WHERE user_id = ? AND alive = 1').get(userId)
      if (!character) throw new StoreError('character-required', 'Для лечения нужен живой герой.', 404)
      const injury = this.db.prepare(`
        SELECT * FROM player_injuries WHERE id = ? AND user_id = ? AND status = 'active'
      `).get(injuryId, userId)
      if (!injury) throw new StoreError('injury-not-found', 'Активная травма не найдена.', 404)
      const guild = this.gameStore.getGuildForUser(userId)
      const workshopDiscount = Math.min(0.2, Number(guild?.branches?.workshops ?? 0) * 0.04)
      const professionDiscount = character.profession === 'herbalist' ? 0.5 : 1
      const cost = Math.max(1, Math.ceil(Number(injury.severity) * 4 * professionDiscount * (1 - workshopDiscount)))
      if (Number(character.coins) < cost) throw new StoreError('not-enough-coins', `Для лечения нужно ${cost} монет.`, 409)
      const now = Date.now()
      this.db.prepare('UPDATE player_characters SET coins = coins - ?, updated_at = ? WHERE user_id = ?').run(cost, now, userId)
      this.db.prepare(`
        UPDATE player_injuries SET status = 'treated', treated_at = ? WHERE id = ? AND user_id = ?
      `).run(now, injuryId, userId)
      return { character: this.players.getCharacter(userId), cost }
    })
  }

  createPaidGuild(userId, input) {
    return this.players.withReceipt(userId, input.requestId, 'create-guild', () => {
      const name = cleanGuildName(input.name)
      const tag = cleanGuildTag(input.tag)
      if (name.length < 3) throw new StoreError('invalid-guild-name', 'Название гильдии должно содержать хотя бы 3 символа.')
      if (tag.length < 2) throw new StoreError('invalid-guild-tag', 'Тег гильдии должен содержать от 2 до 5 букв или цифр.')
      if (this.gameStore.getGuildForUser(userId)) throw new StoreError('already-in-guild', 'Ты уже состоишь в гильдии.', 409)
      if (this.db.prepare('SELECT id FROM guilds WHERE name = ? COLLATE NOCASE OR tag = ? COLLATE NOCASE').get(name, tag)) {
        throw new StoreError('guild-name-taken', 'Название или тег уже заняты.', 409)
      }
      const character = this.db.prepare('SELECT coins, alive FROM player_characters WHERE user_id = ?').get(userId)
      if (!character?.alive) throw new StoreError('character-required', 'Основать гильдию может только живой серверный герой.', 404)
      if (Number(character.coins) < 12) throw new StoreError('not-enough-coins', 'Для основания гильдии нужно 12 монет.', 409)
      const seal = this.db.prepare("SELECT quantity FROM player_inventory WHERE user_id = ? AND item_id = 'founder-seal'").get(userId)
      if (!seal || Number(seal.quantity) < 1) throw new StoreError('founder-seal-required', 'Нужна Печать основателя, выдаваемая за первый сюжетный контракт.', 409)

      const now = Date.now()
      const guildId = randomUUID()
      const leaderRole = randomUUID()
      const deputyRole = randomUUID()
      const memberRole = randomUUID()
      const season = `${new Date().getUTCFullYear()}-${String(new Date().getUTCMonth() + 1).padStart(2, '0')}`
      this.db.prepare(`
        INSERT INTO guilds(id, name, tag, leader_id, season_key, created_at) VALUES (?, ?, ?, ?, ?, ?)
      `).run(guildId, name, tag, userId, season, now)
      const insertRole = this.db.prepare(`
        INSERT INTO guild_roles(id, guild_id, name, position, can_invite, can_kick, can_use_treasury, can_manage_tree, can_manage_roles)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      insertRole.run(leaderRole, guildId, 'Глава', 100, 1, 1, 1, 1, 1)
      insertRole.run(deputyRole, guildId, 'Заместитель', 80, 1, 1, 1, 1, 0)
      insertRole.run(memberRole, guildId, 'Участник', 10, 0, 0, 0, 0, 0)
      this.db.prepare('INSERT INTO guild_members(guild_id, user_id, role_id, joined_at) VALUES (?, ?, ?, ?)').run(guildId, userId, leaderRole, now)
      this.db.prepare('UPDATE player_characters SET coins = coins - 12, updated_at = ? WHERE user_id = ?').run(now, userId)
      if (Number(seal.quantity) === 1) this.db.prepare("DELETE FROM player_inventory WHERE user_id = ? AND item_id = 'founder-seal'").run(userId)
      else this.db.prepare("UPDATE player_inventory SET quantity = quantity - 1 WHERE user_id = ? AND item_id = 'founder-seal'").run(userId)
      this.gameStore.ensureGuildTasks(guildId)
      return { guild: this.gameStore.getGuildForUser(userId), character: this.players.getCharacter(userId) }
    })
  }
}