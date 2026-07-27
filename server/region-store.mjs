import { createHash, randomUUID } from 'node:crypto'
import { applyMigration } from './migrations.mjs'
import { StoreError } from './store.mjs'

const ROTATION_MS = 24 * 60 * 60 * 1000
const ACTIONS = new Set(['attack', 'guard', 'prepare', 'profession', 'flee', 'advance', 'retreat'])
const REGION_ORDER = ['ash-road', 'salt-marsh']

const regions = {
  'ash-road': {
    id: 'ash-road',
    name: 'Пепельный тракт',
    description: 'Обгоревшие дороги, брошенные заставы и зверьё, привыкшее к человеческому пеплу.',
    unlock: 'Первая глава должна быть завершена.',
  },
  'salt-marsh': {
    id: 'salt-marsh',
    name: 'Соляные топи',
    description: 'Белёсая вода, тростниковые острова и колокольни, ушедшие под солёную жижу.',
    unlock: 'Нужны 3-й уровень и три завершённых вольных контракта.',
  },
}

const enemies = {
  'ash-road': [
    { id: 'cinder-hound', name: 'Угольный гончий', style: 'melee', health: 12, difficulty: 1, trophyId: 'cinder-fang', trophyName: 'Угольный клык' },
    { id: 'road-cutthroat', name: 'Дорожный душегуб', style: 'skirmisher', health: 14, difficulty: 2, trophyId: 'notched-token', trophyName: 'Зазубренный жетон' },
    { id: 'grave-crow', name: 'Могильный ворон', style: 'ranged', health: 11, difficulty: 2, trophyId: 'grave-feather', trophyName: 'Могильное перо' },
  ],
  'salt-marsh': [
    { id: 'brine-wight', name: 'Рассольный мертвец', style: 'melee', health: 19, difficulty: 3, trophyId: 'salt-crystal', trophyName: 'Мёртвый соляной кристалл' },
    { id: 'reed-stalker', name: 'Тростниковый ловчий', style: 'skirmisher', health: 17, difficulty: 3, trophyId: 'black-reed', trophyName: 'Чёрный тростник' },
    { id: 'bell-drowner', name: 'Колокольный утопленник', style: 'ranged', health: 21, difficulty: 4, trophyId: 'drowned-clapper', trophyName: 'Язык утонувшего колокола' },
  ],
}

const terrains = {
  'ash-road': [
    { id: 'burnt-causeway', name: 'Обгоревшая насыпь', maxDistance: 2, movementCost: 1 },
    { id: 'ruined-yard', name: 'Двор разрушенной заставы', maxDistance: 1, movementCost: 1 },
    { id: 'ash-field', name: 'Открытое пепельное поле', maxDistance: 3, movementCost: 1 },
  ],
  'salt-marsh': [
    { id: 'salt-causeway', name: 'Узкая соляная гать', maxDistance: 1, movementCost: 1 },
    { id: 'reed-maze', name: 'Тростниковый лабиринт', maxDistance: 3, movementCost: 2 },
    { id: 'sunken-chapel', name: 'Затопленная часовня', maxDistance: 2, movementCost: 1 },
  ],
}

const objectives = [
  { id: 'hunt', title: 'Выследить', text: 'След приводит туда, где пропадают одиночные путники.' },
  { id: 'recover', title: 'Вернуть пропавшее', text: 'Нужно забрать вещь, которую прежний владелец уже не отдаст добровольно.' },
  { id: 'clear-road', title: 'Очистить путь', text: 'Кто-то должен снова сделать дорогу проходимой хотя бы на одну ночь.' },
]

const complications = [
  { id: 'fog', name: 'слепой туман', health: 1, difficulty: 0, reward: 2, initialDistance: 1 },
  { id: 'bad-ground', name: 'неверная земля', health: 2, difficulty: 1, reward: 4, initialDistance: 1 },
  { id: 'blood-scent', name: 'запах свежей крови', health: 3, difficulty: 1, reward: 5, initialDistance: 0 },
  { id: 'distant-bells', name: 'зов далёких колоколов', health: 1, difficulty: 1, reward: 4, initialDistance: 2 },
]

const stableNumber = (value) => createHash('sha256').update(value).digest().readUInt32BE(0)
const stableId = (value) => `offer-${createHash('sha256').update(value).digest('hex').slice(0, 28)}`
const rotationStart = (now = Date.now()) => Math.floor(now / ROTATION_MS) * ROTATION_MS
const rotationKey = (now = Date.now()) => new Date(rotationStart(now)).toISOString().slice(0, 10)
const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value))

function parseSnapshot(value) {
  try { return JSON.parse(value || '{}') } catch { return {} }
}

function publicOffer(row) {
  const snapshot = parseSnapshot(row.snapshot_json)
  return {
    id: row.id,
    regionId: row.region_id,
    regionName: regions[row.region_id]?.name ?? row.region_id,
    title: row.title,
    description: row.description,
    enemyName: row.enemy_name,
    enemyHealth: Number(row.enemy_health),
    difficulty: Number(row.difficulty),
    rewardCoins: Number(row.reward_coins),
    rewardExperience: Number(row.reward_experience),
    terrainName: snapshot.terrainName,
    complication: snapshot.complicationName,
    objective: snapshot.objectiveName,
    initialDistance: Number(row.initial_distance),
    maxDistance: Number(row.max_distance),
    expiresAt: Number(row.expires_at),
    procedural: true,
  }
}

export class RegionStore {
  constructor(gameStore, players) {
    this.gameStore = gameStore
    this.players = players
    this.db = gameStore.db
    this.createSchema()
    this.patchPlayers()
  }

  createSchema() {
    applyMigration(this.db, '013_regions_and_positioning', () => {
      this.db.exec(`
        ALTER TABLE player_expeditions ADD COLUMN region_id TEXT NOT NULL DEFAULT 'ash-road';
        ALTER TABLE player_expeditions ADD COLUMN offer_id TEXT;
        ALTER TABLE player_expeditions ADD COLUMN distance INTEGER NOT NULL DEFAULT 1;
        ALTER TABLE player_expeditions ADD COLUMN max_distance INTEGER NOT NULL DEFAULT 2;
        ALTER TABLE player_expeditions ADD COLUMN terrain_id TEXT NOT NULL DEFAULT 'burnt-causeway';
        ALTER TABLE player_expeditions ADD COLUMN enemy_style TEXT NOT NULL DEFAULT 'melee';
        ALTER TABLE player_expeditions ADD COLUMN contract_snapshot_json TEXT NOT NULL DEFAULT '{}';

        CREATE TABLE player_region_progress (
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          region_id TEXT NOT NULL,
          unlocked_at INTEGER NOT NULL,
          victories INTEGER NOT NULL DEFAULT 0 CHECK(victories >= 0),
          PRIMARY KEY(user_id, region_id)
        ) STRICT;

        CREATE TABLE player_contract_offers (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          rotation_key TEXT NOT NULL,
          slot INTEGER NOT NULL,
          region_id TEXT NOT NULL,
          title TEXT NOT NULL,
          description TEXT NOT NULL,
          enemy_id TEXT NOT NULL,
          enemy_name TEXT NOT NULL,
          enemy_style TEXT NOT NULL,
          enemy_health INTEGER NOT NULL CHECK(enemy_health > 0),
          difficulty INTEGER NOT NULL CHECK(difficulty > 0),
          reward_coins INTEGER NOT NULL CHECK(reward_coins > 0),
          reward_experience INTEGER NOT NULL CHECK(reward_experience > 0),
          trophy_id TEXT NOT NULL,
          trophy_name TEXT NOT NULL,
          trophy_quantity INTEGER NOT NULL DEFAULT 1 CHECK(trophy_quantity > 0),
          terrain_id TEXT NOT NULL,
          initial_distance INTEGER NOT NULL CHECK(initial_distance >= 0),
          max_distance INTEGER NOT NULL CHECK(max_distance BETWEEN 1 AND 3),
          movement_cost INTEGER NOT NULL CHECK(movement_cost BETWEEN 1 AND 2),
          snapshot_json TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('available', 'accepted', 'won', 'fled', 'dead', 'expired')),
          created_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL,
          accepted_at INTEGER,
          closed_at INTEGER,
          UNIQUE(user_id, rotation_key, region_id, slot)
        ) STRICT;

        CREATE INDEX idx_contract_offers_user_status ON player_contract_offers(user_id, status, expires_at);
        CREATE INDEX idx_region_expeditions ON player_expeditions(user_id, region_id, status, updated_at DESC);
      `)
    })
  }

  unlockRegions(userId) {
    const character = this.db.prepare('SELECT level, completed_contracts FROM player_characters WHERE user_id = ?').get(userId)
    if (!character) return
    const story = this.db.prepare('SELECT chapter_complete FROM player_story_state WHERE user_id = ?').get(userId)
    if (Number(story?.chapter_complete)) {
      this.db.prepare('INSERT OR IGNORE INTO player_region_progress(user_id, region_id, unlocked_at) VALUES (?, ?, ?)').run(userId, 'ash-road', Date.now())
    }
    if (Number(story?.chapter_complete) && Number(character.level) >= 3 && Number(character.completed_contracts) >= 3) {
      this.db.prepare('INSERT OR IGNORE INTO player_region_progress(user_id, region_id, unlocked_at) VALUES (?, ?, ?)').run(userId, 'salt-marsh', Date.now())
    }
  }

  regionSnapshot(userId) {
    this.unlockRegions(userId)
    const unlocked = new Map(this.db.prepare('SELECT region_id, unlocked_at, victories FROM player_region_progress WHERE user_id = ?').all(userId).map((row) => [row.region_id, row]))
    const character = this.db.prepare('SELECT level, completed_contracts FROM player_characters WHERE user_id = ?').get(userId)
    return REGION_ORDER.map((id) => {
      const definition = regions[id]
      const progress = unlocked.get(id)
      let requirement = null
      if (!progress && id === 'ash-road') requirement = 'Заверши первую главу.'
      if (!progress && id === 'salt-marsh') requirement = `Нужны 3-й уровень и 3 контракта. Сейчас: уровень ${Number(character?.level ?? 0)}, контрактов ${Number(character?.completed_contracts ?? 0)}.`
      return {
        ...definition,
        unlocked: Boolean(progress),
        unlockedAt: progress ? Number(progress.unlocked_at) : null,
        victories: Number(progress?.victories ?? 0),
        requirement,
      }
    })
  }

  createOffers(userId, now = Date.now()) {
    const unlocked = this.regionSnapshot(userId).filter((region) => region.unlocked)
    const key = rotationKey(now)
    const expiresAt = rotationStart(now) + ROTATION_MS
    for (const region of unlocked) {
      for (let slot = 0; slot < 3; slot += 1) {
        const seed = `${userId}:${key}:${region.id}:${slot}`
        const enemy = enemies[region.id][stableNumber(`${seed}:enemy`) % enemies[region.id].length]
        const terrain = terrains[region.id][stableNumber(`${seed}:terrain`) % terrains[region.id].length]
        const objective = objectives[stableNumber(`${seed}:objective`) % objectives.length]
        const complication = complications[stableNumber(`${seed}:complication`) % complications.length]
        const difficulty = enemy.difficulty + complication.difficulty
        const health = enemy.health + complication.health + slot
        const rewardCoins = 6 + difficulty * 4 + complication.reward + slot
        const rewardExperience = 20 + difficulty * 13 + slot * 3
        const initialDistance = clamp(complication.initialDistance, 0, terrain.maxDistance)
        const title = `${objective.title}: ${enemy.name}`
        const description = `${objective.text} Место: ${terrain.name}; помеха: ${complication.name}.`
        const snapshot = {
          objectiveId: objective.id,
          objectiveName: objective.title,
          terrainName: terrain.name,
          complicationId: complication.id,
          complicationName: complication.name,
          movementCost: terrain.movementCost,
          enemyStyle: enemy.style,
        }
        this.db.prepare(`
          INSERT OR IGNORE INTO player_contract_offers(
            id, user_id, rotation_key, slot, region_id, title, description,
            enemy_id, enemy_name, enemy_style, enemy_health, difficulty,
            reward_coins, reward_experience, trophy_id, trophy_name, trophy_quantity,
            terrain_id, initial_distance, max_distance, movement_cost, snapshot_json,
            status, created_at, expires_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, 'available', ?, ?)
        `).run(
          stableId(seed), userId, key, slot, region.id, title, description,
          enemy.id, enemy.name, enemy.style, health, difficulty,
          rewardCoins, rewardExperience, enemy.trophyId, enemy.trophyName,
          terrain.id, initialDistance, terrain.maxDistance, terrain.movementCost,
          JSON.stringify(snapshot), now, expiresAt,
        )
      }
    }
  }

  expireOffers(now = Date.now()) {
    this.db.prepare("UPDATE player_contract_offers SET status = 'expired', closed_at = ? WHERE status = 'available' AND expires_at <= ?").run(now, now)
  }

  snapshot(userId) {
    this.expireOffers()
    this.createOffers(userId)
    const contracts = this.db.prepare(`
      SELECT * FROM player_contract_offers
      WHERE user_id = ? AND status = 'available' AND expires_at > ?
      ORDER BY region_id, difficulty, slot
    `).all(userId, Date.now()).map(publicOffer)
    return {
      regions: this.regionSnapshot(userId),
      contracts,
      rotationEndsAt: rotationStart() + ROTATION_MS,
    }
  }

  offer(userId, offerId) {
    return this.db.prepare('SELECT * FROM player_contract_offers WHERE id = ? AND user_id = ?').get(offerId, userId)
  }

  decorateRun(base, row) {
    if (!base || !row?.offer_id) return base
    const snapshot = parseSnapshot(row.contract_snapshot_json)
    return {
      ...base,
      regionId: row.region_id,
      regionName: regions[row.region_id]?.name ?? row.region_id,
      offerId: row.offer_id,
      distance: Number(row.distance),
      maxDistance: Number(row.max_distance),
      terrainId: row.terrain_id,
      terrainName: snapshot.terrainName ?? row.terrain_id,
      complication: snapshot.complicationName ?? null,
      objective: snapshot.objectiveName ?? null,
      enemyStyle: row.enemy_style,
      positional: true,
    }
  }

  patchPlayers() {
    const originalGetActiveRun = this.players.getActiveRun.bind(this.players)
    const originalStart = this.players.startExpedition.bind(this.players)
    const originalAct = this.players.actExpedition.bind(this.players)

    this.players.getActiveRun = (userId) => {
      const base = originalGetActiveRun(userId)
      if (!base) return null
      const row = this.db.prepare("SELECT * FROM player_expeditions WHERE id = ? AND status = 'active'").get(base.id)
      return this.decorateRun(base, row)
    }

    this.players.startExpedition = (userId, input) => {
      const offer = this.offer(userId, String(input.contractId ?? ''))
      if (!offer) return originalStart(userId, input)
      return this.startOffer(userId, offer, input)
    }

    this.players.actExpedition = (userId, input) => {
      const run = this.db.prepare("SELECT offer_id FROM player_expeditions WHERE id = ? AND user_id = ? AND status = 'active'").get(String(input.expeditionId ?? ''), userId)
      if (!run?.offer_id) return originalAct(userId, input)
      return this.actOffer(userId, input)
    }
  }

  startOffer(userId, offer, input) {
    return this.players.withReceipt(userId, input.requestId, `start-expedition:${offer.id}`, () => {
      const character = this.db.prepare('SELECT * FROM player_characters WHERE user_id = ?').get(userId)
      if (!character) throw new StoreError('character-required', 'Сначала создай серверного героя.', 404)
      if (!character.alive) throw new StoreError('character-dead', 'Этот герой погиб. Создай наследника.', 409)
      if (this.players.getActiveRun(userId)) throw new StoreError('expedition-active', 'Сначала закончи текущий поход.', 409)
      const current = this.offer(userId, offer.id)
      if (!current || current.status !== 'available' || Number(current.expires_at) <= Date.now()) throw new StoreError('contract-expired', 'Предложение контракта уже недоступно.', 409)
      if (Number(character.stamina) < 2) throw new StoreError('not-enough-stamina', 'Для похода нужно хотя бы 2 единицы сил.', 409)
      const id = randomUUID()
      const now = Date.now()
      const snapshot = parseSnapshot(current.snapshot_json)
      this.db.prepare('UPDATE player_characters SET stamina = stamina - 2, updated_at = ? WHERE user_id = ?').run(now, userId)
      this.db.prepare("UPDATE player_contract_offers SET status = 'accepted', accepted_at = ? WHERE id = ? AND status = 'available'").run(now, current.id)
      this.db.prepare(`
        INSERT INTO player_expeditions(
          id, user_id, contract_id, status, turn, enemy_id, enemy_name,
          enemy_health, enemy_max_health, enemy_intent, last_log_json, started_at, updated_at,
          region_id, offer_id, distance, max_distance, terrain_id, enemy_style, contract_snapshot_json
        ) VALUES (?, ?, ?, 'active', 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id, userId, current.id, current.enemy_id, current.enemy_name,
        current.enemy_health, current.enemy_health, this.nextIntent(id, 1, Number(current.difficulty), current.enemy_style),
        JSON.stringify([
          `Ты принимаешь контракт «${current.title}».`,
          `${regions[current.region_id]?.name}: ${snapshot.terrainName}; ${snapshot.complicationName}.`,
          `Начальная дистанция: ${this.distanceName(Number(current.initial_distance))}.`,
        ]), now, now, current.region_id, current.id, current.initial_distance, current.max_distance,
        current.terrain_id, current.enemy_style, current.snapshot_json,
      )
      return { character: this.players.getCharacter(userId) }
    })
  }

  distanceName(distance) {
    return distance <= 0 ? 'вплотную' : distance === 1 ? 'средняя' : distance === 2 ? 'дальняя' : 'предельная'
  }

  nextIntent(runId, turn, difficulty, style) {
    const intents = style === 'ranged'
      ? ['attack', 'attack', 'guard', 'hex']
      : style === 'skirmisher'
        ? ['attack', 'heavy', 'guard', 'attack']
        : difficulty >= 4
          ? ['attack', 'heavy', 'heavy', 'hex']
          : ['attack', 'attack', 'heavy', 'guard']
    return intents[stableNumber(`${runId}:${turn}:region`) % intents.length]
  }

  equippedType(userId) {
    return this.db.prepare('SELECT item_type FROM unique_items WHERE owner_user_id = ? AND equipped = 1 LIMIT 1').get(userId)?.item_type ?? 'tool'
  }

  closeOffer(offerId, status, now) {
    this.db.prepare('UPDATE player_contract_offers SET status = ?, closed_at = ? WHERE id = ?').run(status, now, offerId)
  }

  actOffer(userId, input) {
    const action = String(input.action ?? '')
    if (!ACTIONS.has(action)) throw new StoreError('invalid-combat-action', 'Неизвестное боевое действие.')
    return this.players.withReceipt(userId, input.requestId, `expedition:${action}`, () => {
      const character = this.db.prepare('SELECT * FROM player_characters WHERE user_id = ?').get(userId)
      const run = this.db.prepare("SELECT * FROM player_expeditions WHERE id = ? AND user_id = ? AND status = 'active'").get(String(input.expeditionId ?? ''), userId)
      if (!character || !run || !run.offer_id) throw new StoreError('expedition-not-found', 'Активный поход не найден.', 404)
      if (!character.alive) throw new StoreError('character-dead', 'Герой уже погиб.', 409)
      const offer = this.offer(userId, run.offer_id)
      if (!offer) throw new StoreError('contract-not-found', 'Сервер потерял запись контракта.', 500)
      const snapshot = parseSnapshot(run.contract_snapshot_json)
      let enemyHealth = Number(run.enemy_health)
      let health = Number(character.health)
      let stamina = Number(character.stamina)
      let guard = Number(run.guard)
      let prepared = Boolean(run.prepared)
      let distance = Number(run.distance)
      const maxDistance = Number(run.max_distance)
      const movementCost = Number(snapshot.movementCost ?? 1)
      let skipEnemy = false
      const log = []
      const levelBonus = Math.floor(Number(character.level) / 4)
      const weaponBonus = this.equippedType(userId) === 'weapon' ? 1 : 0

      if (action === 'advance' || action === 'retreat') {
        if (stamina < movementCost) throw new StoreError('not-enough-stamina', `Для движения нужно ${movementCost} силы.`, 409)
        if (action === 'advance') {
          if (distance <= 0) throw new StoreError('already-close', 'Ты уже находишься вплотную к врагу.', 409)
          distance -= 1
          log.push(`Ты сближаешься. Дистанция: ${this.distanceName(distance)}.`)
        } else {
          if (distance >= maxDistance) throw new StoreError('already-far', 'Дальше отойти не позволяет местность.', 409)
          distance += 1
          log.push(`Ты разрываешь дистанцию. Теперь она ${this.distanceName(distance)}.`)
        }
        stamina -= movementCost
      } else if (action === 'attack') {
        const rangeDamage = distance === 0 ? 3 : distance === 1 ? 2 : 1
        const damage = rangeDamage + levelBonus + weaponBonus + (prepared ? 2 : 0)
        enemyHealth -= damage
        prepared = false
        log.push(`Ты наносишь ${damage} урона с дистанции «${this.distanceName(distance)}».`)
      } else if (action === 'guard') {
        guard = Math.min(7, guard + 3)
        log.push('Ты закрепляешь позицию и готовишься принять удар.')
      } else if (action === 'prepare') {
        prepared = true
        stamina = Math.min(Number(character.max_stamina), stamina + 1)
        log.push('Ты вымеряешь расстояние и восстанавливаешь 1 силу.')
      } else if (action === 'flee') {
        const chance = 15 + distance * 22 + stamina * 3 + Number(character.insight) * 2 - Number(offer.difficulty) * 4 + (distance === maxDistance ? 12 : 0)
        const escaped = stableNumber(`${run.id}:flee:${run.turn}`) % 100 < chance
        if (escaped) {
          const now = Date.now()
          this.db.prepare("UPDATE player_expeditions SET status = 'fled', turn = turn + 1, last_log_json = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(['Ты используешь расстояние и уходишь живым.']), now, run.id)
          this.db.prepare('UPDATE player_characters SET stamina = MAX(0, stamina - 1), updated_at = ? WHERE user_id = ?').run(now, userId)
          this.closeOffer(run.offer_id, 'fled', now)
          return { character: this.players.getCharacter(userId) }
        }
        stamina = Math.max(0, stamina - 1)
        log.push('Противник не даёт разорвать бой.')
      } else {
        const profession = character.profession
        if (profession === 'blacksmith') {
          if (distance !== 0) throw new StoreError('wrong-distance', 'Кузнечный замах работает только вплотную.', 409)
          if (stamina < 1) throw new StoreError('not-enough-stamina', 'Не хватает сил для ремесленного приёма.', 409)
          const damage = 6 + levelBonus + weaponBonus
          enemyHealth -= damage; stamina -= 1; prepared = false
          log.push(`Кузнечный замах наносит ${damage} урона.`)
        } else if (profession === 'herbalist') {
          const healed = Math.min(3, Number(character.max_health) - health)
          health += healed; enemyHealth -= distance <= 1 ? 1 : 0
          log.push(`Горькая настойка восстанавливает ${healed} здоровья${distance <= 1 ? ' и обжигает врага на 1 урон' : ''}.`)
        } else if (profession === 'hunter') {
          const damage = distance >= 2 ? 6 + levelBonus : distance === 1 ? 5 + levelBonus : 2 + levelBonus
          enemyHealth -= damage
          log.push(`Выверенный выстрел наносит ${damage} урона.`)
        } else if (profession === 'scribe') {
          enemyHealth -= 2
          if (['heavy', 'hex'].includes(run.enemy_intent)) { skipEnemy = true; log.push('Ты читаешь знаки местности и срываешь замысел врага.') }
          else log.push('Ты предугадываешь движение и наносишь 2 урона.')
        } else if (profession === 'carter') {
          enemyHealth -= 1; guard = Math.min(8, guard + 4)
          if (distance > 0) distance -= 1
          log.push('Дорожный крюк тянет врага ближе: 1 урон и усиленная защита.')
        } else {
          const change = stableNumber(`${run.id}:wanderer:${run.turn}`) % 2 === 0 ? -1 : 1
          distance = clamp(distance + change, 0, maxDistance)
          const damage = 2 + (stableNumber(`${run.id}:wanderer-damage:${run.turn}`) % 4)
          enemyHealth -= damage
          log.push(`Страннический приём меняет дистанцию и наносит ${damage} урона.`)
        }
      }

      const now = Date.now()
      if (enemyHealth <= 0) {
        const guild = this.gameStore.getGuildForUser(userId)
        const rewardCoins = Math.floor(Number(offer.reward_coins) * (1 + Number(guild?.branches?.treasury ?? 0) * 0.02))
        const rewardExperience = Math.floor(Number(offer.reward_experience) * (1 + Number(guild?.branches?.chronicle ?? 0) * 0.03))
        const progression = this.players.grantExperience(character, rewardExperience)
        this.db.prepare(`
          UPDATE player_characters SET level = ?, experience = ?, max_health = ?, health = MIN(?, health + 2),
            max_stamina = ?, stamina = MIN(?, ?), coins = coins + ?, reputation = reputation + ?,
            completed_contracts = completed_contracts + 1, updated_at = ? WHERE user_id = ?
        `).run(progression.level, progression.experience, progression.maxHealth, progression.maxHealth, progression.maxStamina, progression.maxStamina, stamina + 1, rewardCoins, offer.difficulty, now, userId)
        this.players.addInventory(userId, offer.trophy_id, offer.trophy_name, Number(offer.trophy_quantity))
        log.push(`Победа: ${rewardCoins} монет, ${rewardExperience} опыта и трофей «${offer.trophy_name}».`)
        log.push(...progression.messages)
        this.db.prepare("UPDATE player_expeditions SET status = 'won', enemy_health = 0, turn = turn + 1, prepared = 0, guard = 0, distance = ?, last_log_json = ?, updated_at = ? WHERE id = ?").run(distance, JSON.stringify(log), now, run.id)
        this.closeOffer(run.offer_id, 'won', now)
        this.db.prepare('UPDATE player_region_progress SET victories = victories + 1 WHERE user_id = ? AND region_id = ?').run(userId, run.region_id)
        const role = this.gameStore.getRoleForUser(userId)
        if (role) {
          this.gameStore.progressTaskByGuild(role.guild_id, 'contracts', 1)
          this.gameStore.progressTaskByGuild(role.guild_id, 'victories', 1)
        }
        this.unlockRegions(userId)
        return { character: this.players.getCharacter(userId) }
      }

      if (!skipEnemy) {
        if (run.enemy_intent === 'guard') {
          const recovered = Math.min(Number(run.enemy_max_health), enemyHealth + 1) - enemyHealth
          enemyHealth += recovered
          log.push(`Враг укрывается и восстанавливает ${recovered} здоровье.`)
        } else if (run.enemy_intent === 'hex') {
          const damage = Math.max(0, 2 + Number(offer.difficulty) - guard)
          health -= damage; stamina = Math.max(0, stamina - 1); guard = 0
          log.push(`Порча проходит через расстояние: ${damage} урона и −1 сила.`)
        } else if (run.enemy_style === 'ranged' && distance === 0 && maxDistance > 0) {
          distance += 1
          log.push('Враг отскакивает назад, возвращая себе пространство для выстрела.')
        } else if (run.enemy_style !== 'ranged' && distance > 0) {
          distance -= 1
          log.push(`Враг сближается. Дистанция: ${this.distanceName(distance)}.`)
        } else {
          const heavy = run.enemy_intent === 'heavy'
          const baseDamage = heavy ? 5 + Number(offer.difficulty) : 3 + Number(offer.difficulty)
          const rangedPenalty = run.enemy_style === 'ranged' && distance === 0 ? 2 : 0
          const damage = Math.max(0, baseDamage - rangedPenalty - guard)
          health -= damage; guard = 0
          log.push(`Враг наносит ${damage} урона.`)
        }
      }

      const nextTurn = Number(run.turn) + 1
      if (health <= 0) {
        const glory = Number(character.level) + Math.floor(Number(character.reputation) / 5) + Number(offer.difficulty)
        log.push('Герой погиб. Дорога запомнила место его последнего шага.')
        this.db.prepare('UPDATE player_characters SET health = 0, stamina = ?, alive = 0, deaths = deaths + 1, legacy_glory = legacy_glory + ?, updated_at = ? WHERE user_id = ?').run(stamina, glory, now, userId)
        this.db.prepare("UPDATE player_expeditions SET status = 'dead', enemy_health = ?, turn = ?, distance = ?, guard = 0, prepared = 0, last_log_json = ?, updated_at = ? WHERE id = ?").run(Math.max(0, enemyHealth), nextTurn, distance, JSON.stringify(log), now, run.id)
        this.closeOffer(run.offer_id, 'dead', now)
        return { character: this.players.getCharacter(userId) }
      }

      this.db.prepare('UPDATE player_characters SET health = ?, stamina = ?, updated_at = ? WHERE user_id = ?').run(health, stamina, now, userId)
      this.db.prepare(`
        UPDATE player_expeditions SET enemy_health = ?, enemy_intent = ?, turn = ?, distance = ?,
          guard = ?, prepared = ?, last_log_json = ?, updated_at = ? WHERE id = ?
      `).run(enemyHealth, this.nextIntent(run.id, nextTurn, Number(offer.difficulty), run.enemy_style), nextTurn, distance, guard, prepared ? 1 : 0, JSON.stringify(log), now, run.id)
      return { character: this.players.getCharacter(userId) }
    })
  }
}
