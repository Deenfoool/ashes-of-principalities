import { createHash } from 'node:crypto'
import { applyMigration } from './migrations.mjs'
import { StoreError } from './store.mjs'

const HOUR = 60 * 60 * 1000
const TACTICS = new Set(['cover', 'trap'])
const NATURAL_COVER = new Set(['reed-maze', 'sunken-chapel', 'ruined-yard', 'salt-causeway'])

const stableNumber = (value) => createHash('sha256').update(value).digest().readUInt32BE(0)
const nextIntent = (runId, turn, style) => {
  const intents = style === 'ranged'
    ? ['attack', 'guard', 'hex', 'attack']
    : style === 'skirmisher'
      ? ['attack', 'heavy', 'guard', 'attack']
      : ['attack', 'attack', 'heavy', 'guard']
  return intents[stableNumber(`${runId}:${turn}:marsh-tactic`) % intents.length]
}

export function installMarshBalanceMigrations(db) {
  applyMigration(db, '015_marsh_injury_penalties', () => {
    db.exec(`
      CREATE TRIGGER trg_marsh_fever_movement_penalty
      AFTER INSERT ON player_action_receipts
      WHEN NEW.action IN ('expedition:advance', 'expedition:retreat')
      BEGIN
        UPDATE player_characters SET stamina = MAX(0, stamina - COALESCE((
          SELECT MAX(severity) FROM player_injuries
          WHERE user_id = NEW.user_id AND kind = 'marsh-fever' AND status = 'active'
        ), 0)), updated_at = unixepoch('subsec') * 1000
        WHERE user_id = NEW.user_id;
      END;

      CREATE TRIGGER trg_marsh_deep_cut_attack_penalty
      AFTER INSERT ON player_action_receipts
      WHEN NEW.action IN ('expedition:attack', 'expedition:profession')
      BEGIN
        UPDATE player_characters SET stamina = MAX(0, stamina - COALESCE((
          SELECT MAX(severity) FROM player_injuries
          WHERE user_id = NEW.user_id AND kind = 'deep-cut' AND status = 'active'
        ), 0)), updated_at = unixepoch('subsec') * 1000
        WHERE user_id = NEW.user_id;
      END;
    `)
  })
}

export class MarshSystem {
  constructor(gameStore, players) {
    this.gameStore = gameStore
    this.players = players
    this.db = gameStore.db
    this.installPlayerDecorators()
  }

  inventoryQuantity(userId, itemId) {
    return Number(this.db.prepare(`
      SELECT quantity FROM player_inventory WHERE user_id = ? AND item_id = ?
    `).get(userId, itemId)?.quantity ?? 0)
  }

  consume(userId, itemId, quantity = 1) {
    const owned = this.inventoryQuantity(userId, itemId)
    if (owned < quantity) throw new StoreError('tactic-item-required', 'Не хватает подготовленного расходника.', 409)
    if (owned === quantity) this.db.prepare('DELETE FROM player_inventory WHERE user_id = ? AND item_id = ?').run(userId, itemId)
    else this.db.prepare('UPDATE player_inventory SET quantity = quantity - ? WHERE user_id = ? AND item_id = ?').run(quantity, userId, itemId)
  }

  advanceHealing(userId, now = Date.now()) {
    const rows = this.db.prepare(`
      SELECT * FROM player_injuries
      WHERE user_id = ? AND status = 'active' AND natural_heal_at IS NOT NULL AND natural_heal_at <= ?
    `).all(userId, now)
    let changed = 0
    for (const row of rows) {
      const interval = Math.max(HOUR, Number(row.recovery_interval || 12 * HOUR))
      const steps = Math.max(1, Math.floor((now - Number(row.natural_heal_at)) / interval) + 1)
      const severity = Number(row.severity) - steps
      if (severity <= 0) {
        this.db.prepare("UPDATE player_injuries SET status = 'treated', treated_at = ? WHERE id = ?")
          .run(now, row.id)
      } else {
        this.db.prepare(`
          UPDATE player_injuries SET severity = ?, natural_heal_at = ?,
            recovery_note = 'Травма естественно ослабла после времени в покое.' WHERE id = ?
        `).run(severity, Number(row.natural_heal_at) + steps * interval, row.id)
      }
      changed += 1
    }
    return changed
  }

  accelerateHealing(userId, amount = 12 * HOUR) {
    this.db.prepare(`
      UPDATE player_injuries SET natural_heal_at = MAX(?, natural_heal_at - ?)
      WHERE user_id = ? AND status = 'active' AND natural_heal_at IS NOT NULL
    `).run(Date.now(), amount, userId)
    return this.advanceHealing(userId)
  }

  decorateCharacter(character) {
    if (!character) return null
    this.advanceHealing(character.userId)
    const recovery = new Map(this.db.prepare(`
      SELECT id, natural_heal_at, recovery_interval, recovery_note
      FROM player_injuries WHERE user_id = ? AND status = 'active'
    `).all(character.userId).map((row) => [row.id, row]))
    const injuries = (character.injuries ?? []).map((injury) => {
      const row = recovery.get(injury.id)
      return {
        ...injury,
        naturalHealAt: row?.natural_heal_at ? Number(row.natural_heal_at) : null,
        recoveryInterval: Number(row?.recovery_interval ?? 0),
        recoveryNote: row?.recovery_note ?? '',
      }
    })
    let activeExpedition = character.activeExpedition
    if (activeExpedition?.positional) {
      const naturalCover = NATURAL_COVER.has(activeExpedition.terrainId)
      const screen = this.inventoryQuantity(character.userId, 'reed-screen') > 0
      const snare = this.inventoryQuantity(character.userId, 'reed-snare') > 0
      activeExpedition = {
        ...activeExpedition,
        tactics: [
          {
            id: 'cover',
            label: 'Укрыться',
            available: naturalCover || screen,
            reason: naturalCover ? 'Местность даёт естественное укрытие.' : screen ? 'Будет использован тростниковый экран.' : 'Нужно естественное укрытие или тростниковый экран.',
          },
          {
            id: 'trap',
            label: 'Поставить ловушку',
            available: snare,
            reason: snare ? 'Будет использована тростниковая петля.' : 'Нужна тростниковая петля.',
          },
        ],
      }
    }
    const fever = injuries.find((injury) => injury.kind === 'marsh-fever')?.severity ?? 0
    const deepCut = injuries.find((injury) => injury.kind === 'deep-cut')?.severity ?? 0
    return {
      ...character,
      injuries,
      activeExpedition,
      combatModifiers: {
        ...character.combatModifiers,
        movementStaminaPenalty: fever,
        attackStaminaPenalty: Number(character.combatModifiers?.attackStaminaPenalty ?? 0) + deepCut,
      },
    }
  }

  installPlayerDecorators() {
    if (this.players.__marshSystemInstalled) return
    this.players.__marshSystemInstalled = true
    const originalGetCharacter = this.players.getCharacter.bind(this.players)
    const originalRest = this.players.rest.bind(this.players)

    this.players.getCharacter = (userId) => {
      this.advanceHealing(userId)
      return this.decorateCharacter(originalGetCharacter(userId))
    }
    this.players.rest = (userId, input) => {
      const result = originalRest(userId, input)
      this.accelerateHealing(userId)
      return { ...result, character: this.players.getCharacter(userId) }
    }
  }

  enemyReaction(run, offer, state, log) {
    let { health, stamina, guard, distance, enemyHealth } = state
    if (run.enemy_intent === 'guard') {
      const recovered = Math.min(Number(run.enemy_max_health), enemyHealth + 1) - enemyHealth
      enemyHealth += recovered
      log.push(`Враг использует паузу и восстанавливает ${recovered} здоровье.`)
    } else if (run.enemy_intent === 'hex') {
      const damage = Math.max(0, 2 + Number(offer.difficulty) - guard)
      health -= damage
      stamina = Math.max(0, stamina - 1)
      guard = 0
      log.push(`Порча проходит сквозь укрытие: ${damage} урона и −1 сила.`)
    } else if (run.enemy_style === 'ranged' && distance === 0 && Number(run.max_distance) > 0) {
      distance += 1
      log.push('Дальний противник отскакивает от укрытия и возвращает дистанцию.')
    } else if (run.enemy_style !== 'ranged' && distance > 0) {
      distance -= 1
      log.push('Противник сближается, пока ты занимаешь позицию.')
    } else {
      const heavy = run.enemy_intent === 'heavy'
      const base = heavy ? 5 + Number(offer.difficulty) : 3 + Number(offer.difficulty)
      const damage = Math.max(0, base - guard)
      health -= damage
      guard = 0
      log.push(`Враг отвечает на манёвр и наносит ${damage} урона.`)
    }
    return { health, stamina, guard, distance, enemyHealth }
  }

  tactic(userId, input) {
    const tactic = String(input.tactic ?? '')
    if (!TACTICS.has(tactic)) throw new StoreError('invalid-tactic', 'Неизвестная полевая тактика.')
    return this.players.withReceipt(userId, input.requestId, `expedition:tactic:${tactic}`, () => {
      const character = this.db.prepare('SELECT * FROM player_characters WHERE user_id = ?').get(userId)
      const run = this.db.prepare(`
        SELECT * FROM player_expeditions WHERE id = ? AND user_id = ? AND status = 'active'
      `).get(String(input.expeditionId ?? ''), userId)
      if (!character || !run || !run.offer_id) throw new StoreError('expedition-not-found', 'Позиционный бой не найден.', 404)
      if (!character.alive) throw new StoreError('character-dead', 'Герой уже погиб.', 409)
      const offer = this.db.prepare('SELECT * FROM player_contract_offers WHERE id = ?').get(run.offer_id)
      if (!offer) throw new StoreError('contract-not-found', 'Запись контракта потеряна.', 500)

      let health = Number(character.health)
      let stamina = Number(character.stamina)
      let guard = Number(run.guard)
      let distance = Number(run.distance)
      let enemyHealth = Number(run.enemy_health)
      const log = []
      const feverPenalty = Number(this.db.prepare(`
        SELECT MAX(severity) AS value FROM player_injuries
        WHERE user_id = ? AND kind = 'marsh-fever' AND status = 'active'
      `).get(userId)?.value ?? 0)
      const saltPenalty = Number(this.db.prepare(`
        SELECT MAX(severity) AS value FROM player_injuries
        WHERE user_id = ? AND kind = 'salt-burn' AND status = 'active'
      `).get(userId)?.value ?? 0)
      const cost = 1 + feverPenalty + saltPenalty
      if (stamina < cost) throw new StoreError('not-enough-stamina', `Для тактики нужно ${cost} силы.`, 409)
      stamina -= cost

      if (tactic === 'cover') {
        const natural = NATURAL_COVER.has(run.terrain_id)
        if (!natural) this.consume(userId, 'reed-screen')
        const protection = natural ? 5 : 4
        guard = Math.min(9, guard + protection)
        log.push(natural
          ? `Ты используешь местность как укрытие: защита +${protection}.`
          : `Ты раскрываешь тростниковый экран: защита +${protection}.`)
        ;({ health, stamina, guard, distance, enemyHealth } = this.enemyReaction(
          run, offer, { health, stamina, guard, distance, enemyHealth }, log,
        ))
      } else {
        this.consume(userId, 'reed-snare')
        const reinforced = this.inventoryQuantity(userId, 'brine-spikes') > 0
        if (reinforced) this.consume(userId, 'brine-spikes')
        const damage = reinforced ? 6 : 4
        const dealt = Math.min(Math.max(0, enemyHealth - 1), damage)
        enemyHealth -= dealt
        distance = Math.min(Number(run.max_distance), distance + 1)
        log.push(`Ловушка срабатывает: ${dealt} урона и противник отброшен${reinforced ? ' рассольными шипами' : ''}.`)
      }

      const now = Date.now()
      const nextTurn = Number(run.turn) + 1
      if (health <= 0) {
        const glory = Number(character.level) + Math.floor(Number(character.reputation) / 5) + Number(offer.difficulty)
        log.push('Герой погиб, пытаясь изменить поле боя.')
        this.db.prepare(`
          UPDATE player_characters SET health = 0, stamina = ?, alive = 0,
            deaths = deaths + 1, legacy_glory = legacy_glory + ?, updated_at = ? WHERE user_id = ?
        `).run(stamina, glory, now, userId)
        this.db.prepare(`
          UPDATE player_expeditions SET status = 'dead', enemy_health = ?, turn = ?, distance = ?,
            guard = 0, prepared = 0, last_log_json = ?, updated_at = ? WHERE id = ?
        `).run(enemyHealth, nextTurn, distance, JSON.stringify(log), now, run.id)
        this.db.prepare("UPDATE player_contract_offers SET status = 'dead', closed_at = ? WHERE id = ?")
          .run(now, run.offer_id)
        return { character: this.players.getCharacter(userId) }
      }

      this.db.prepare('UPDATE player_characters SET health = ?, stamina = ?, updated_at = ? WHERE user_id = ?')
        .run(health, stamina, now, userId)
      this.db.prepare(`
        UPDATE player_expeditions SET enemy_health = ?, enemy_intent = ?, turn = ?, distance = ?,
          guard = ?, last_log_json = ?, updated_at = ? WHERE id = ?
      `).run(
        enemyHealth, nextIntent(run.id, nextTurn, run.enemy_style), nextTurn, distance,
        guard, JSON.stringify(log), now, run.id,
      )
      return { character: this.players.getCharacter(userId) }
    })
  }
}
