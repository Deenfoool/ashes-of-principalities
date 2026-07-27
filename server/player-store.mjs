import { createHash, randomUUID } from 'node:crypto'
import { StoreError } from './store.mjs'

const PROFESSIONS = new Set(['blacksmith', 'herbalist', 'hunter', 'scribe', 'carter', 'wanderer'])
const ACTIONS = new Set(['attack', 'guard', 'prepare', 'profession', 'flee'])
const RECEIPT_LIFETIME = 30 * 24 * 60 * 60 * 1000

const professionStats = {
  blacksmith: { health: 12, stamina: 8, insight: 3, coins: 4, item: ['smith-hammer', 'Кузнечный молоток'] },
  herbalist: { health: 9, stamina: 8, insight: 5, coins: 4, item: ['herb-satchel', 'Сумка с травами'] },
  hunter: { health: 9, stamina: 10, insight: 4, coins: 4, item: ['short-bow', 'Короткий лук'] },
  scribe: { health: 8, stamina: 8, insight: 6, coins: 8, item: ['writing-kit', 'Письменный набор'] },
  carter: { health: 10, stamina: 9, insight: 3, coins: 8, item: ['road-rope', 'Дорожная верёвка'] },
  wanderer: { health: 10, stamina: 9, insight: 4, coins: 5, item: ['worn-cloak', 'Потёртый плащ'] },
}

export const expeditionContracts = [
  {
    id: 'ash-wolf',
    title: 'Пепельный волк',
    description: 'Хищник, выгнанный пожарами к человеческим дорогам.',
    enemyId: 'ash-wolf',
    enemyName: 'Пепельный волк',
    enemyHealth: 11,
    difficulty: 1,
    rewardCoins: 8,
    rewardExperience: 28,
    trophyId: 'ash-wolf-hide',
    trophyName: 'Обожжённая волчья шкура',
  },
  {
    id: 'toll-robber',
    title: 'Сборщик без князя',
    description: 'Вооружённый разбойник собирает подать с тех, кого некому защитить.',
    enemyId: 'toll-robber',
    enemyName: 'Ложный сборщик',
    enemyHealth: 14,
    difficulty: 2,
    rewardCoins: 13,
    rewardExperience: 38,
    trophyId: 'false-seal',
    trophyName: 'Поддельная княжеская печать',
  },
  {
    id: 'drowned-dead',
    title: 'Мертвец у брода',
    description: 'Утопленник возвращается каждую ночь и зовёт путников по имени.',
    enemyId: 'drowned-dead',
    enemyName: 'Утопленник',
    enemyHealth: 18,
    difficulty: 3,
    rewardCoins: 19,
    rewardExperience: 52,
    trophyId: 'river-token',
    trophyName: 'Речная костяная метка',
  },
]

const contractById = Object.fromEntries(expeditionContracts.map((contract) => [contract.id, contract]))

const cleanName = (value) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, 24)
const cleanRequestId = (value) => {
  const id = String(value ?? '').trim()
  if (!/^[a-zA-Z0-9:_-]{8,96}$/.test(id)) {
    throw new StoreError('invalid-request-id', 'Некорректный идентификатор действия.')
  }
  return id
}

const stableNumber = (value) => createHash('sha256').update(value).digest().readUInt32BE(0)
const xpThreshold = (level) => 55 + Number(level) * 35
const nextIntent = (runId, turn, difficulty) => {
  const intents = difficulty >= 3 ? ['attack', 'heavy', 'guard', 'hex'] : ['attack', 'attack', 'heavy', 'guard']
  return intents[stableNumber(`${runId}:${turn}`) % intents.length]
}

function publicCharacter(row, inventory, expedition) {
  if (!row) return null
  return {
    userId: row.user_id,
    name: row.name,
    profession: row.profession,
    level: Number(row.level),
    experience: Number(row.experience),
    experienceToNext: xpThreshold(Number(row.level)),
    maxHealth: Number(row.max_health),
    health: Number(row.health),
    maxStamina: Number(row.max_stamina),
    stamina: Number(row.stamina),
    insight: Number(row.insight),
    reputation: Number(row.reputation),
    coins: Number(row.coins),
    generation: Number(row.generation),
    deaths: Number(row.deaths),
    legacyGlory: Number(row.legacy_glory),
    completedContracts: Number(row.completed_contracts),
    alive: Boolean(row.alive),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    inventory,
    activeExpedition: expedition,
  }
}

function publicRun(row) {
  if (!row) return null
  return {
    id: row.id,
    contractId: row.contract_id,
    status: row.status,
    turn: Number(row.turn),
    enemyId: row.enemy_id,
    enemyName: row.enemy_name,
    enemyHealth: Number(row.enemy_health),
    enemyMaxHealth: Number(row.enemy_max_health),
    enemyIntent: row.enemy_intent,
    guard: Number(row.guard),
    prepared: Boolean(row.prepared),
    lastLog: JSON.parse(row.last_log_json || '[]'),
    startedAt: Number(row.started_at),
    updatedAt: Number(row.updated_at),
  }
}

export class PlayerStore {
  constructor(gameStore) {
    this.gameStore = gameStore
    this.db = gameStore.db
    this.createSchema()
    this.db.prepare('DELETE FROM player_action_receipts WHERE created_at < ?').run(Date.now() - RECEIPT_LIFETIME)
  }

  createSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS player_characters (
        user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        profession TEXT NOT NULL,
        level INTEGER NOT NULL DEFAULT 1,
        experience INTEGER NOT NULL DEFAULT 0,
        max_health INTEGER NOT NULL,
        health INTEGER NOT NULL,
        max_stamina INTEGER NOT NULL,
        stamina INTEGER NOT NULL,
        insight INTEGER NOT NULL,
        reputation INTEGER NOT NULL DEFAULT 0,
        coins INTEGER NOT NULL DEFAULT 0,
        generation INTEGER NOT NULL DEFAULT 1,
        deaths INTEGER NOT NULL DEFAULT 0,
        legacy_glory INTEGER NOT NULL DEFAULT 0,
        completed_contracts INTEGER NOT NULL DEFAULT 0,
        alive INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS player_inventory (
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        item_id TEXT NOT NULL,
        item_name TEXT NOT NULL,
        quantity INTEGER NOT NULL DEFAULT 1,
        PRIMARY KEY(user_id, item_id)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS player_expeditions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        contract_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('active', 'won', 'fled', 'dead')),
        turn INTEGER NOT NULL DEFAULT 1,
        enemy_id TEXT NOT NULL,
        enemy_name TEXT NOT NULL,
        enemy_health INTEGER NOT NULL,
        enemy_max_health INTEGER NOT NULL,
        enemy_intent TEXT NOT NULL,
        guard INTEGER NOT NULL DEFAULT 0,
        prepared INTEGER NOT NULL DEFAULT 0,
        last_log_json TEXT NOT NULL DEFAULT '[]',
        started_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;

      CREATE UNIQUE INDEX IF NOT EXISTS idx_one_active_expedition
        ON player_expeditions(user_id) WHERE status = 'active';

      CREATE TABLE IF NOT EXISTS player_action_receipts (
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        request_id TEXT NOT NULL,
        action TEXT NOT NULL,
        result_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY(user_id, request_id)
      ) STRICT;

      CREATE INDEX IF NOT EXISTS idx_player_runs_user_time
        ON player_expeditions(user_id, updated_at DESC);
    `)
  }

  getInventory(userId) {
    return this.db.prepare(`
      SELECT item_id AS id, item_name AS name, quantity
      FROM player_inventory WHERE user_id = ? ORDER BY item_name
    `).all(userId).map((item) => ({ ...item, quantity: Number(item.quantity) }))
  }

  getActiveRun(userId) {
    return publicRun(this.db.prepare(`
      SELECT * FROM player_expeditions WHERE user_id = ? AND status = 'active'
    `).get(userId))
  }

  getCharacter(userId) {
    const row = this.db.prepare('SELECT * FROM player_characters WHERE user_id = ?').get(userId)
    return publicCharacter(row, row ? this.getInventory(userId) : [], row ? this.getActiveRun(userId) : null)
  }

  withReceipt(userId, requestIdValue, action, callback) {
    const requestId = cleanRequestId(requestIdValue)
    const existing = this.db.prepare(`
      SELECT action, result_json FROM player_action_receipts WHERE user_id = ? AND request_id = ?
    `).get(userId, requestId)
    if (existing) {
      if (existing.action !== action) throw new StoreError('request-id-conflict', 'Этот идентификатор уже использован для другого действия.', 409)
      return JSON.parse(existing.result_json)
    }

    return this.gameStore.transaction(() => {
      const duplicate = this.db.prepare(`
        SELECT action, result_json FROM player_action_receipts WHERE user_id = ? AND request_id = ?
      `).get(userId, requestId)
      if (duplicate) {
        if (duplicate.action !== action) throw new StoreError('request-id-conflict', 'Этот идентификатор уже использован для другого действия.', 409)
        return JSON.parse(duplicate.result_json)
      }
      const result = callback()
      this.db.prepare(`
        INSERT INTO player_action_receipts(user_id, request_id, action, result_json, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(userId, requestId, action, JSON.stringify(result), Date.now())
      return result
    })
  }

  createCharacter(userId, input) {
    return this.withReceipt(userId, input.requestId, 'create-character', () => {
      if (this.getCharacter(userId)) throw new StoreError('character-exists', 'У аккаунта уже есть персонаж.', 409)
      const name = cleanName(input.name)
      const profession = String(input.profession ?? '')
      if (name.length < 2) throw new StoreError('invalid-character-name', 'Имя героя должно содержать хотя бы 2 символа.')
      if (!PROFESSIONS.has(profession)) throw new StoreError('invalid-profession', 'Неизвестное ремесло.')
      const stats = professionStats[profession]
      const now = Date.now()
      this.db.prepare(`
        INSERT INTO player_characters(
          user_id, name, profession, max_health, health, max_stamina, stamina,
          insight, coins, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(userId, name, profession, stats.health, stats.health, stats.stamina, stats.stamina, stats.insight, stats.coins, now, now)
      this.db.prepare(`
        INSERT INTO player_inventory(user_id, item_id, item_name, quantity) VALUES (?, ?, ?, 1)
      `).run(userId, stats.item[0], stats.item[1])
      return { character: this.getCharacter(userId) }
    })
  }

  startExpedition(userId, input) {
    return this.withReceipt(userId, input.requestId, 'start-expedition', () => {
      const character = this.db.prepare('SELECT * FROM player_characters WHERE user_id = ?').get(userId)
      if (!character) throw new StoreError('character-required', 'Сначала создай серверного героя.', 404)
      if (!character.alive) throw new StoreError('character-dead', 'Этот герой погиб. Создай наследника.', 409)
      if (this.getActiveRun(userId)) throw new StoreError('expedition-active', 'Сначала закончи текущий поход.', 409)
      if (Number(character.stamina) < 2) throw new StoreError('not-enough-stamina', 'Для похода нужно хотя бы 2 единицы сил.', 409)
      const contract = contractById[String(input.contractId ?? '')]
      if (!contract) throw new StoreError('contract-not-found', 'Такого контракта нет.', 404)

      const id = randomUUID()
      const now = Date.now()
      this.db.prepare('UPDATE player_characters SET stamina = stamina - 2, updated_at = ? WHERE user_id = ?').run(now, userId)
      this.db.prepare(`
        INSERT INTO player_expeditions(
          id, user_id, contract_id, status, turn, enemy_id, enemy_name,
          enemy_health, enemy_max_health, enemy_intent, last_log_json, started_at, updated_at
        ) VALUES (?, ?, ?, 'active', 1, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id, userId, contract.id, contract.enemyId, contract.enemyName,
        contract.enemyHealth, contract.enemyHealth, nextIntent(id, 1, contract.difficulty),
        JSON.stringify([`Ты вышел по контракту «${contract.title}».`]), now, now,
      )
      return { character: this.getCharacter(userId) }
    })
  }

  addInventory(userId, itemId, itemName, quantity = 1) {
    this.db.prepare(`
      INSERT INTO player_inventory(user_id, item_id, item_name, quantity)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(user_id, item_id) DO UPDATE SET quantity = quantity + excluded.quantity
    `).run(userId, itemId, itemName, quantity)
  }

  grantExperience(row, gained) {
    let level = Number(row.level)
    let experience = Number(row.experience) + gained
    let maxHealth = Number(row.max_health)
    let maxStamina = Number(row.max_stamina)
    const messages = []
    while (experience >= xpThreshold(level)) {
      experience -= xpThreshold(level)
      level += 1
      if (level % 2 === 0) maxHealth += 1
      if (level % 3 === 0) maxStamina += 1
      messages.push(`Достигнут ${level}-й уровень.`)
    }
    return { level, experience, maxHealth, maxStamina, messages }
  }

  actExpedition(userId, input) {
    const action = String(input.action ?? '')
    if (!ACTIONS.has(action)) throw new StoreError('invalid-combat-action', 'Неизвестное боевое действие.')
    return this.withReceipt(userId, input.requestId, `expedition:${action}`, () => {
      const character = this.db.prepare('SELECT * FROM player_characters WHERE user_id = ?').get(userId)
      const run = this.db.prepare(`
        SELECT * FROM player_expeditions WHERE id = ? AND user_id = ? AND status = 'active'
      `).get(String(input.expeditionId ?? ''), userId)
      if (!character || !run) throw new StoreError('expedition-not-found', 'Активный поход не найден.', 404)
      if (!character.alive) throw new StoreError('character-dead', 'Герой уже погиб.', 409)

      const contract = contractById[run.contract_id]
      let enemyHealth = Number(run.enemy_health)
      let health = Number(character.health)
      let stamina = Number(character.stamina)
      let guard = Number(run.guard)
      let prepared = Boolean(run.prepared)
      let skipEnemy = false
      const log = []
      const levelBonus = Math.floor(Number(character.level) / 4)

      if (action === 'attack') {
        const damage = 2 + levelBonus + (prepared ? 2 : 0)
        enemyHealth -= damage
        prepared = false
        log.push(`Ты наносишь ${damage} урона.`)
      } else if (action === 'guard') {
        guard = Math.min(6, guard + 3)
        log.push('Ты занимаешь защищённую позицию.')
      } else if (action === 'prepare') {
        prepared = true
        stamina = Math.min(Number(character.max_stamina), stamina + 1)
        log.push('Ты выжидаешь момент и восстанавливаешь часть сил.')
      } else if (action === 'flee') {
        const chance = 35 + stamina * 4 + Number(character.insight) * 2
        const escaped = stableNumber(`${run.id}:flee:${run.turn}`) % 100 < chance
        if (escaped) {
          this.db.prepare(`
            UPDATE player_expeditions SET status = 'fled', turn = turn + 1, last_log_json = ?, updated_at = ? WHERE id = ?
          `).run(JSON.stringify(['Ты разрываешь дистанцию и уходишь живым.']), Date.now(), run.id)
          this.db.prepare('UPDATE player_characters SET stamina = MAX(0, stamina - 1), updated_at = ? WHERE user_id = ?')
            .run(Date.now(), userId)
          return { character: this.getCharacter(userId) }
        }
        stamina = Math.max(0, stamina - 1)
        log.push('Отступление не удалось.')
      } else {
        const profession = character.profession
        if (profession === 'blacksmith') {
          if (stamina < 1) throw new StoreError('not-enough-stamina', 'Не хватает сил для ремесленного приёма.', 409)
          const damage = 5 + levelBonus
          enemyHealth -= damage
          stamina -= 1
          prepared = false
          log.push(`Кузнечный замах наносит ${damage} урона.`)
        } else if (profession === 'herbalist') {
          const healed = Math.min(3, Number(character.max_health) - health)
          health += healed
          enemyHealth -= 1
          log.push(`Ты применяешь горькую настойку: +${healed} здоровья, врагу 1 урон.`)
        } else if (profession === 'hunter') {
          const damage = 4 + (run.enemy_intent === 'heavy' ? 1 : 0)
          enemyHealth -= damage
          log.push(`Точный выстрел наносит ${damage} урона.`)
        } else if (profession === 'scribe') {
          enemyHealth -= 2
          if (['heavy', 'hex'].includes(run.enemy_intent)) {
            skipEnemy = true
            log.push('Ты распознаёшь замысел врага и срываешь его действие.')
          } else {
            log.push('Ты читаешь движение противника и наносишь 2 урона.')
          }
        } else if (profession === 'carter') {
          enemyHealth -= 1
          guard = Math.min(7, guard + 4)
          log.push('Ты принимаешь удар как тяжёлый груз: 1 урон и усиленная защита.')
        } else {
          const damage = 2 + (stableNumber(`${run.id}:wanderer:${run.turn}`) % 4)
          enemyHealth -= damage
          if (damage >= 4) health = Math.min(Number(character.max_health), health + 1)
          log.push(`Импровизированный приём наносит ${damage} урона.`)
        }
      }

      const now = Date.now()
      if (enemyHealth <= 0) {
        const guild = this.gameStore.getGuildForUser(userId)
        const coinMultiplier = 1 + (guild?.branches?.treasury ?? 0) * 0.02
        const xpMultiplier = 1 + (guild?.branches?.chronicle ?? 0) * 0.03
        const rewardCoins = Math.floor(contract.rewardCoins * coinMultiplier)
        const rewardExperience = Math.floor(contract.rewardExperience * xpMultiplier)
        const progression = this.grantExperience(character, rewardExperience)
        this.db.prepare(`
          UPDATE player_characters SET
            level = ?, experience = ?, max_health = ?, health = MIN(?, health + 2),
            max_stamina = ?, stamina = MIN(?, ?), coins = coins + ?, reputation = reputation + ?,
            completed_contracts = completed_contracts + 1, updated_at = ?
          WHERE user_id = ?
        `).run(
          progression.level, progression.experience, progression.maxHealth, progression.maxHealth,
          progression.maxStamina, progression.maxStamina, stamina + 1, rewardCoins,
          contract.difficulty, now, userId,
        )
        this.addInventory(userId, contract.trophyId, contract.trophyName, 1)
        log.push(`Победа: ${rewardCoins} монет и ${rewardExperience} опыта.`)
        log.push(...progression.messages)
        this.db.prepare(`
          UPDATE player_expeditions SET status = 'won', enemy_health = 0, turn = turn + 1,
            prepared = 0, guard = 0, last_log_json = ?, updated_at = ? WHERE id = ?
        `).run(JSON.stringify(log), now, run.id)
        const role = this.gameStore.getRoleForUser(userId)
        if (role) {
          this.gameStore.progressTaskByGuild(role.guild_id, 'contracts', 1)
          this.gameStore.progressTaskByGuild(role.guild_id, 'victories', 1)
        }
        return { character: this.getCharacter(userId) }
      }

      if (!skipEnemy) {
        if (run.enemy_intent === 'guard') {
          const recovered = Math.min(Number(run.enemy_max_health), enemyHealth + 1) - enemyHealth
          enemyHealth += recovered
          log.push(`Враг защищается и восстанавливает ${recovered} здоровье.`)
        } else {
          const baseDamage = run.enemy_intent === 'heavy' ? 5 + contract.difficulty : run.enemy_intent === 'hex' ? 2 + contract.difficulty : 3 + contract.difficulty
          const damage = Math.max(0, baseDamage - guard)
          health -= damage
          if (run.enemy_intent === 'hex') stamina = Math.max(0, stamina - 1)
          log.push(`Враг наносит ${damage} урона${run.enemy_intent === 'hex' ? ' и отнимает 1 силу' : ''}.`)
          guard = 0
        }
      }

      const nextTurn = Number(run.turn) + 1
      if (health <= 0) {
        const glory = Number(character.level) + Math.floor(Number(character.reputation) / 5) + contract.difficulty
        log.push('Герой погиб. Его имя осталось в летописи рода.')
        this.db.prepare(`
          UPDATE player_characters SET health = 0, stamina = ?, alive = 0, deaths = deaths + 1,
            legacy_glory = legacy_glory + ?, updated_at = ? WHERE user_id = ?
        `).run(stamina, glory, now, userId)
        this.db.prepare(`
          UPDATE player_expeditions SET status = 'dead', enemy_health = ?, turn = ?,
            guard = 0, prepared = 0, last_log_json = ?, updated_at = ? WHERE id = ?
        `).run(Math.max(0, enemyHealth), nextTurn, JSON.stringify(log), now, run.id)
        return { character: this.getCharacter(userId) }
      }

      this.db.prepare(`
        UPDATE player_characters SET health = ?, stamina = ?, updated_at = ? WHERE user_id = ?
      `).run(health, stamina, now, userId)
      this.db.prepare(`
        UPDATE player_expeditions SET enemy_health = ?, enemy_intent = ?, turn = ?,
          guard = ?, prepared = ?, last_log_json = ?, updated_at = ? WHERE id = ?
      `).run(
        enemyHealth, nextIntent(run.id, nextTurn, contract.difficulty), nextTurn,
        guard, prepared ? 1 : 0, JSON.stringify(log), now, run.id,
      )
      return { character: this.getCharacter(userId) }
    })
  }

  rest(userId, input) {
    return this.withReceipt(userId, input.requestId, 'rest', () => {
      const character = this.db.prepare('SELECT * FROM player_characters WHERE user_id = ?').get(userId)
      if (!character) throw new StoreError('character-required', 'Сначала создай героя.', 404)
      if (!character.alive) throw new StoreError('character-dead', 'Погибшему нужен наследник, а не отдых.', 409)
      if (this.getActiveRun(userId)) throw new StoreError('expedition-active', 'Нельзя отдыхать во время похода.', 409)
      if (Number(character.coins) < 2) throw new StoreError('not-enough-coins', 'Ночлег стоит 2 монеты.', 409)
      this.db.prepare(`
        UPDATE player_characters SET health = max_health, stamina = max_stamina, coins = coins - 2, updated_at = ?
        WHERE user_id = ?
      `).run(Date.now(), userId)
      return { character: this.getCharacter(userId) }
    })
  }

  createHeir(userId, input) {
    return this.withReceipt(userId, input.requestId, 'create-heir', () => {
      const previous = this.db.prepare('SELECT * FROM player_characters WHERE user_id = ?').get(userId)
      if (!previous) throw new StoreError('character-required', 'У рода ещё нет первого героя.', 404)
      if (previous.alive) throw new StoreError('character-alive', 'Наследник появляется только после смерти героя.', 409)
      const name = cleanName(input.name)
      const profession = String(input.profession ?? '')
      if (name.length < 2) throw new StoreError('invalid-character-name', 'Имя наследника слишком короткое.')
      if (!PROFESSIONS.has(profession)) throw new StoreError('invalid-profession', 'Неизвестное ремесло.')
      const stats = professionStats[profession]
      const inheritedCoins = 3 + Math.min(10, Math.floor(Number(previous.legacy_glory) / 5))
      const now = Date.now()
      this.db.prepare(`
        UPDATE player_characters SET name = ?, profession = ?, level = 1, experience = 0,
          max_health = ?, health = ?, max_stamina = ?, stamina = ?, insight = ?,
          reputation = 0, coins = ?, generation = generation + 1, alive = 1, updated_at = ?
        WHERE user_id = ?
      `).run(
        name, profession, stats.health, stats.health, stats.stamina, stats.stamina,
        stats.insight, inheritedCoins, now, userId,
      )
      this.db.prepare('DELETE FROM player_inventory WHERE user_id = ?').run(userId)
      this.addInventory(userId, stats.item[0], stats.item[1], 1)
      if (Number(previous.legacy_glory) >= 10) this.addInventory(userId, 'family-relic', 'Семейная реликвия', 1)
      return { character: this.getCharacter(userId) }
    })
  }

  donateCoins(userId, input) {
    return this.withReceipt(userId, input.requestId, 'guild-donation', () => {
      const amount = Math.floor(Number(input.amount))
      if (!Number.isFinite(amount) || amount <= 0 || amount > 100_000) {
        throw new StoreError('invalid-amount', 'Взнос должен быть положительным целым числом.')
      }
      const character = this.db.prepare('SELECT coins FROM player_characters WHERE user_id = ? AND alive = 1').get(userId)
      if (!character) throw new StoreError('character-required', 'Для взноса нужен живой серверный герой.', 404)
      if (Number(character.coins) < amount) throw new StoreError('not-enough-coins', 'У героя недостаточно монет.', 409)
      const role = this.gameStore.getRoleForUser(userId)
      if (!role) throw new StoreError('not-in-guild', 'Ты не состоишь в гильдии.', 404)
      const now = Date.now()
      this.db.prepare('UPDATE player_characters SET coins = coins - ?, updated_at = ? WHERE user_id = ?').run(amount, now, userId)
      this.db.prepare('UPDATE guilds SET treasury_coins = treasury_coins + ? WHERE id = ?').run(amount, role.guild_id)
      this.db.prepare(`
        INSERT INTO treasury_log(id, guild_id, user_id, operation, amount, created_at)
        VALUES (?, ?, ?, 'deposit-coins', ?, ?)
      `).run(randomUUID(), role.guild_id, userId, amount, now)
      this.gameStore.progressTaskByGuild(role.guild_id, 'donations', amount)
      return {
        character: this.getCharacter(userId),
        guild: this.gameStore.getGuildForUser(userId),
      }
    })
  }
}
