import { createHash, randomUUID } from 'node:crypto'
import { StoreError } from './store.mjs'

const BOSS_ID = 'salt-bell-warden'
const WEEK = 7 * 24 * 60 * 60 * 1000
const ACTIONS = new Set(['attack', 'guard', 'prepare', 'profession', 'flee', 'advance', 'retreat', 'climb', 'descend'])
const NATURAL_COVER = new Set(['reed-maze', 'sunken-chapel', 'white-bell-tower'])

const stableNumber = (value) => createHash('sha256').update(value).digest().readUInt32BE(0)
const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value))

function parseSnapshot(value) {
  try { return JSON.parse(value || '{}') } catch { return {} }
}

function publicEnemy(row) {
  return {
    id: row.id,
    key: row.enemy_key,
    name: row.enemy_name,
    role: row.enemy_role,
    health: Number(row.health),
    maxHealth: Number(row.max_health),
    distance: Number(row.distance),
    elevation: Number(row.elevation),
    intent: row.intent,
    zonePower: Number(row.zone_power),
    status: row.status,
    defeated: row.status === 'defeated' || Number(row.health) <= 0,
  }
}

export class SquadCombatStore {
  constructor(gameStore, players, regions, equipment, marshSystem, marshCrafting) {
    this.gameStore = gameStore
    this.players = players
    this.regions = regions
    this.equipment = equipment
    this.marshSystem = marshSystem
    this.marshCrafting = marshCrafting
    this.db = gameStore.db
    this.patchPlayers()
    this.patchTactics()
  }

  enemyRows(expeditionId) {
    return this.db.prepare(`
      SELECT * FROM player_expedition_enemies
      WHERE expedition_id = ? ORDER BY priority, created_at
    `).all(expeditionId)
  }

  activeEnemyRows(expeditionId) {
    return this.db.prepare(`
      SELECT * FROM player_expedition_enemies
      WHERE expedition_id = ? AND status = 'active' AND health > 0
      ORDER BY priority, created_at
    `).all(expeditionId)
  }

  decorateRun(base, row) {
    if (!base || !row || !['group', 'boss'].includes(row.encounter_type)) return base
    const enemies = this.enemyRows(row.id).map(publicEnemy)
    const active = enemies.filter((enemy) => !enemy.defeated)
    const target = active.find((enemy) => enemy.id === row.target_enemy_id) ?? active[0] ?? null
    const totalHealth = active.reduce((sum, enemy) => sum + enemy.health, 0)
    const totalMax = enemies.reduce((sum, enemy) => sum + enemy.maxHealth, 0)
    return {
      ...base,
      encounterType: row.encounter_type,
      bossId: row.boss_id ?? null,
      bossPhase: Number(row.boss_phase),
      heroElevation: Number(row.hero_elevation),
      maxElevation: Number(row.max_elevation),
      zoneControl: Number(row.zone_control),
      targetEnemyId: target?.id ?? null,
      enemies,
      enemyName: row.encounter_type === 'boss' ? 'Глухобор и свита' : 'Отряд Соляных топей',
      enemyHealth: totalHealth,
      enemyMaxHealth: totalMax,
      enemyIntent: target?.intent ?? base.enemyIntent,
      distance: target?.distance ?? base.distance,
    }
  }

  patchPlayers() {
    const originalGetActiveRun = this.players.getActiveRun.bind(this.players)
    const originalAct = this.players.actExpedition.bind(this.players)

    this.players.getActiveRun = (userId) => {
      const base = originalGetActiveRun(userId)
      if (!base) return null
      const row = this.db.prepare("SELECT * FROM player_expeditions WHERE id = ? AND status = 'active'").get(base.id)
      return this.decorateRun(base, row)
    }

    this.players.actExpedition = (userId, input) => {
      const row = this.db.prepare(`
        SELECT encounter_type FROM player_expeditions
        WHERE id = ? AND user_id = ? AND status = 'active'
      `).get(String(input.expeditionId ?? ''), userId)
      if (!row || !['group', 'boss'].includes(row.encounter_type)) return originalAct(userId, input)
      const result = this.actSquad(userId, input)
      this.marshCrafting?.claimRegionalMaterials?.(userId, String(input.expeditionId ?? ''))
      return { ...result, character: this.players.getCharacter(userId) }
    }
  }

  patchTactics() {
    const originalTactic = this.marshSystem.tactic.bind(this.marshSystem)
    this.marshSystem.tactic = (userId, input) => {
      const row = this.db.prepare(`
        SELECT encounter_type FROM player_expeditions
        WHERE id = ? AND user_id = ? AND status = 'active'
      `).get(String(input.expeditionId ?? ''), userId)
      if (!row || !['group', 'boss'].includes(row.encounter_type)) return originalTactic(userId, input)
      const tactic = String(input.tactic ?? '')
      if (!['cover', 'trap'].includes(tactic)) throw new StoreError('unknown-tactic', 'Неизвестная полевая тактика.', 404)
      const result = this.actSquad(userId, { ...input, action: tactic }, true)
      this.marshCrafting?.claimRegionalMaterials?.(userId, String(input.expeditionId ?? ''))
      return { ...result, character: this.players.getCharacter(userId) }
    }
  }

  bossSnapshot(userId) {
    const character = this.db.prepare('SELECT * FROM player_characters WHERE user_id = ?').get(userId)
    const marsh = this.db.prepare('SELECT chapter_complete FROM player_marsh_story_state WHERE user_id = ?').get(userId)
    const progress = this.db.prepare('SELECT * FROM player_boss_progress WHERE user_id = ? AND boss_id = ?').get(userId, BOSS_ID)
    const unlocked = Boolean(character?.alive && Number(marsh?.chapter_complete) && Number(character.level) >= 5)
    const cooldownEndsAt = Number(progress?.victories ?? 0) > 0 ? Number(progress.last_defeated_at) + WEEK : null
    const activeRun = this.db.prepare("SELECT boss_id FROM player_expeditions WHERE user_id = ? AND status = 'active'").get(userId)
    const available = unlocked && !activeRun && (!cooldownEndsAt || cooldownEndsAt <= Date.now())
    let requirement = null
    if (!character) requirement = 'Сначала создай героя.'
    else if (!character.alive) requirement = 'Погибшему герою нужен наследник.'
    else if (!Number(marsh?.chapter_complete)) requirement = 'Заверши вторую главу Соляных топей.'
    else if (Number(character.level) < 5) requirement = `Нужен 5-й уровень. Сейчас: ${Number(character.level)}.`
    else if (activeRun) requirement = 'Сначала заверши текущий поход.'
    else if (cooldownEndsAt && cooldownEndsAt > Date.now()) requirement = `Колокольня снова откроется ${new Date(cooldownEndsAt).toISOString()}.`
    return {
      id: BOSS_ID,
      title: 'Соляной воевода Глухобор',
      description: 'Мёртвый воевода держит затопленную колокольню вместе с загонщиком и певчим. На половине здоровья он поднимает соляную тень.',
      regionId: 'salt-marsh',
      difficulty: 6,
      recommendedLevel: 5,
      unlocked,
      available,
      requirement,
      attempts: Number(progress?.attempts ?? 0),
      victories: Number(progress?.victories ?? 0),
      cooldownEndsAt,
      firstReward: 'Мастерский Белопанцирь Глухобора',
      repeatReward: 'Сердце белого колокола и обычные награды',
    }
  }

  startBoss(userId, input) {
    return this.players.withReceipt(userId, input.requestId, `boss:start:${BOSS_ID}`, () => {
      const boss = this.bossSnapshot(userId)
      if (!boss.available) throw new StoreError('boss-unavailable', boss.requirement ?? 'Босс сейчас недоступен.', 409)
      const character = this.db.prepare('SELECT * FROM player_characters WHERE user_id = ?').get(userId)
      if (Number(character.stamina) < 4) throw new StoreError('not-enough-stamina', 'Для подъёма к колокольне нужно 4 силы.', 409)
      const id = randomUUID()
      const now = Date.now()
      const snapshot = {
        terrainName: 'Затопленная колокольня',
        movementCost: 1,
        difficulty: 6,
        rewardCoins: 52,
        rewardExperience: 125,
        complicationName: 'три высоты и замкнутая лестница',
        objectiveName: 'Сломить свиту и воеводу',
      }
      this.db.prepare('UPDATE player_characters SET stamina = stamina - 4, updated_at = ? WHERE user_id = ?').run(now, userId)
      this.db.prepare(`
        INSERT INTO player_expeditions(
          id, user_id, contract_id, status, turn, enemy_id, enemy_name,
          enemy_health, enemy_max_health, enemy_intent, guard, prepared,
          last_log_json, started_at, updated_at, region_id, offer_id, distance,
          max_distance, terrain_id, enemy_style, contract_snapshot_json,
          encounter_type, hero_elevation, max_elevation, zone_control,
          boss_phase, target_enemy_id, boss_id
        ) VALUES (?, ?, ?, 'active', 1, ?, ?, 64, 64, 'heavy', 0, 0, ?, ?, ?,
          'salt-marsh', NULL, 0, 3, 'white-bell-tower', 'boss', ?,
          'boss', 0, 2, 2, 1, NULL, ?)
      `).run(
        id, userId, BOSS_ID, BOSS_ID, 'Соляной воевода Глухобор',
        JSON.stringify([
          'Ты входишь в затопленную колокольню. Над водой три лестничных яруса.',
          'Глухобор ждёт наверху, пока загонщик перекрывает гать, а певчий начинает мёртвый распев.',
        ]), now, now, JSON.stringify(snapshot), BOSS_ID,
      )
      const insert = this.db.prepare(`
        INSERT INTO player_expedition_enemies(
          id, expedition_id, enemy_key, enemy_name, enemy_role, health, max_health,
          distance, elevation, intent, zone_power, status, priority, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)
      `)
      const guardId = randomUUID()
      insert.run(guardId, id, 'gate-keeper', 'Тростниковый загонщик', 'controller', 14, 14, 0, 0, 'attack', 2, 10, now, now)
      insert.run(randomUUID(), id, 'drowned-cantor', 'Утопленный певчий', 'ranged', 12, 12, 3, 1, 'hex', 0, 20, now, now)
      insert.run(randomUUID(), id, 'warden', 'Соляной воевода Глухобор', 'boss', 38, 38, 2, 2, 'heavy', 1, 30, now, now)
      this.db.prepare('UPDATE player_expeditions SET target_enemy_id = ? WHERE id = ?').run(guardId, id)
      this.db.prepare(`
        INSERT INTO player_boss_progress(user_id, boss_id, unlocked_at, attempts, last_attempt_at)
        VALUES (?, ?, ?, 1, ?)
        ON CONFLICT(user_id, boss_id) DO UPDATE SET attempts = attempts + 1, last_attempt_at = excluded.last_attempt_at
      `).run(userId, BOSS_ID, now, now)
      return { character: this.players.getCharacter(userId), boss: this.bossSnapshot(userId) }
    })
  }

  nextIntent(runId, enemy, turn, phase) {
    const patterns = enemy.enemy_role === 'boss'
      ? phase >= 2 ? ['heavy', 'hex', 'attack', 'heavy'] : ['heavy', 'attack', 'guard', 'hex']
      : enemy.enemy_role === 'ranged'
        ? ['attack', 'hex', 'guard', 'attack']
        : enemy.enemy_role === 'controller'
          ? ['attack', 'heavy', 'attack', 'guard']
          : ['attack', 'guard', 'heavy', 'attack']
    return patterns[stableNumber(`${runId}:${enemy.id}:${turn}:v013`) % patterns.length]
  }

  mainHandType(userId) {
    return this.db.prepare(`
      SELECT item_type FROM unique_items
      WHERE owner_user_id = ? AND equipment_slot = 'main-hand' AND equipped = 1 AND durability > 0
    `).get(userId)?.item_type ?? 'tool'
  }

  movementCost(userId, snapshot, injuries, profile) {
    const fever = Number(injuries.get('marsh-fever') ?? 0)
    return Math.max(1, Number(snapshot.movementCost ?? 1) + fever - Number(profile.movementDiscount ?? 0))
  }

  attackCost(injuries) {
    return Number(injuries.get('wounded-arm') ?? 0) + Number(injuries.get('deep-cut') ?? 0)
  }

  zonePower(enemies) {
    return enemies
      .filter((enemy) => enemy.status === 'active' && Number(enemy.health) > 0 && Number(enemy.distance) === 0)
      .reduce((sum, enemy) => sum + Number(enemy.zone_power), 0)
  }

  chooseTarget(enemies, requestedId, fallbackId) {
    const active = enemies.filter((enemy) => enemy.status === 'active' && Number(enemy.health) > 0)
    const target = active.find((enemy) => enemy.id === requestedId)
      ?? active.find((enemy) => enemy.id === fallbackId)
      ?? active[0]
    if (!target) throw new StoreError('enemy-not-found', 'В бою не осталось доступной цели.', 404)
    return target
  }

  markDefeated(enemies, log) {
    for (const enemy of enemies) {
      if (enemy.status === 'active' && Number(enemy.health) <= 0) {
        enemy.health = 0
        enemy.status = 'defeated'
        log.push(`${enemy.enemy_name} выведен из боя.`)
      }
    }
  }

  maybeChangeBossPhase(run, enemies, log) {
    if (run.encounter_type !== 'boss' || Number(run.boss_phase) >= 2) return Number(run.boss_phase)
    const boss = enemies.find((enemy) => enemy.enemy_role === 'boss' && enemy.status === 'active')
    if (!boss || Number(boss.health) > Math.floor(Number(boss.max_health) / 2)) return Number(run.boss_phase)
    const now = Date.now()
    boss.health = Math.min(Number(boss.max_health), Number(boss.health) + 5)
    boss.elevation = 2
    this.db.prepare(`
      INSERT OR IGNORE INTO player_expedition_enemies(
        id, expedition_id, enemy_key, enemy_name, enemy_role, health, max_health,
        distance, elevation, intent, zone_power, status, priority, created_at, updated_at
      ) VALUES (?, ?, 'salt-shadow', 'Соляная тень', 'skirmisher', 10, 10, 1, 1, 'attack', 1, 'active', 25, ?, ?)
    `).run(randomUUID(), run.id, now, now)
    const shadow = this.db.prepare("SELECT * FROM player_expedition_enemies WHERE expedition_id = ? AND enemy_key = 'salt-shadow'").get(run.id)
    if (shadow && !enemies.some((enemy) => enemy.id === shadow.id)) enemies.push(shadow)
    log.push('Глухобор раскалывает белую корку на доспехе и поднимает соляную тень. Начинается вторая фаза.')
    return 2
  }

  enemyPhase(run, offer, enemies, state, profile, log) {
    let { health, stamina, guard, heroElevation } = state
    let physicalDamage = 0
    let hexDamage = 0
    const difficulty = Number(offer?.difficulty ?? parseSnapshot(run.contract_snapshot_json).difficulty ?? 4)

    for (const enemy of enemies.filter((item) => item.status === 'active' && Number(item.health) > 0)) {
      const role = enemy.enemy_role
      const distance = Number(enemy.distance)
      if (enemy.intent === 'guard') {
        const recovered = Math.min(Number(enemy.max_health), Number(enemy.health) + 2) - Number(enemy.health)
        enemy.health = Number(enemy.health) + recovered
        log.push(`${enemy.enemy_name} укрепляет позицию и восстанавливает ${recovered} здоровья.`)
      } else if (role === 'ranged' && distance === 0) {
        enemy.distance = Math.min(Number(run.max_distance), distance + 1)
        log.push(`${enemy.enemy_name} отходит, сохраняя линию для выстрела.`)
      } else if (['brute', 'controller', 'boss'].includes(role) && distance > 0) {
        enemy.distance = distance - 1
        log.push(`${enemy.enemy_name} сближается.`)
      } else {
        const highGround = Number(enemy.elevation) > heroElevation ? 1 : 0
        if (enemy.intent === 'hex') {
          const base = 2 + Math.floor(difficulty / 2) + (role === 'boss' ? 1 : 0)
          const damage = Math.max(0, base - Number(profile.hexResistance ?? 0) - Math.floor(guard / 2))
          health -= damage
          stamina = Math.max(0, stamina - Math.max(0, 1 - Number(profile.hexResistance ?? 0)))
          guard = Math.max(0, guard - 2)
          hexDamage += damage
          log.push(`${enemy.enemy_name} проводит порчу: ${damage} урона.`)
        } else {
          const heavy = enemy.intent === 'heavy'
          const base = (role === 'boss' ? 5 : role === 'brute' ? 4 : 3) + (heavy ? 2 : 0) + highGround
          const absorbed = Math.min(guard, base)
          guard -= absorbed
          const damage = Math.max(0, base - absorbed - Number(profile.armor ?? 0))
          health -= damage
          physicalDamage += damage
          log.push(`${enemy.enemy_name} наносит ${damage} урона${highGround ? ' с преимущества высоты' : ''}.`)
        }
      }
      enemy.intent = this.nextIntent(run.id, enemy, Number(run.turn) + 1, Number(run.boss_phase))
    }

    if (physicalDamage > 0) this.equipment.damageSlot(run.user_id, 'body', 1)
    if (hexDamage > 0) this.equipment.damageSlot(run.user_id, 'charm', 1)
    return { health, stamina, guard, heroElevation }
  }

  finishVictory(userId, character, run, offer, enemies, state, log, now) {
    const snapshot = parseSnapshot(run.contract_snapshot_json)
    const guild = this.gameStore.getGuildForUser(userId)
    const baseCoins = run.encounter_type === 'boss' ? Number(snapshot.rewardCoins ?? 52) : Number(offer.reward_coins)
    const baseExperience = run.encounter_type === 'boss' ? Number(snapshot.rewardExperience ?? 125) : Number(offer.reward_experience)
    const groupMultiplier = run.encounter_type === 'group' ? 1.2 : 1
    const rewardCoins = Math.floor(baseCoins * groupMultiplier * (1 + Number(guild?.branches?.treasury ?? 0) * 0.02))
    const rewardExperience = Math.floor(baseExperience * groupMultiplier * (1 + Number(guild?.branches?.chronicle ?? 0) * 0.03))
    const progression = this.players.grantExperience(character, rewardExperience)
    const reputation = run.encounter_type === 'boss' ? 8 : Number(offer.difficulty) + 1
    this.db.prepare(`
      UPDATE player_characters SET level = ?, experience = ?, max_health = ?, health = MIN(?, health + 3),
        max_stamina = ?, stamina = MIN(?, ?), coins = coins + ?, reputation = reputation + ?,
        completed_contracts = completed_contracts + 1, updated_at = ? WHERE user_id = ?
    `).run(
      progression.level, progression.experience, progression.maxHealth, progression.maxHealth,
      progression.maxStamina, progression.maxStamina, state.stamina + 1,
      rewardCoins, reputation, now, userId,
    )

    if (run.encounter_type === 'boss') {
      this.players.addInventory(userId, 'white-bell-heart', 'Сердце белого колокола', 1)
      const progress = this.db.prepare('SELECT victories FROM player_boss_progress WHERE user_id = ? AND boss_id = ?').get(userId, BOSS_ID)
      const firstVictory = Number(progress?.victories ?? 0) === 0
      this.db.prepare(`
        UPDATE player_boss_progress SET victories = victories + 1,
          first_defeated_at = COALESCE(first_defeated_at, ?), last_defeated_at = ?
        WHERE user_id = ? AND boss_id = ?
      `).run(now, now, userId, BOSS_ID)
      if (firstVictory) {
        const armor = this.equipment.grantBossArmor(userId)
        log.push(`Первая победа принесла ${armor?.name ?? 'Белопанцирь Глухобора'}.`)
      }
      log.push(`Глухобор повержен: ${rewardCoins} монет, ${rewardExperience} опыта и Сердце белого колокола.`)
    } else {
      this.players.addInventory(userId, offer.trophy_id, offer.trophy_name, Number(offer.trophy_quantity))
      this.db.prepare("UPDATE player_contract_offers SET status = 'won', closed_at = ? WHERE id = ?").run(now, run.offer_id)
      this.db.prepare('UPDATE player_region_progress SET victories = victories + 1 WHERE user_id = ? AND region_id = ?').run(userId, run.region_id)
      log.push(`Отряд разбит: ${rewardCoins} монет, ${rewardExperience} опыта и трофей «${offer.trophy_name}».`)
    }
    log.push(...progression.messages)
    this.db.prepare(`
      UPDATE player_expeditions SET status = 'won', enemy_health = 0, turn = turn + 1,
        guard = 0, prepared = 0, zone_control = 0, last_log_json = ?, updated_at = ? WHERE id = ?
    `).run(JSON.stringify(log), now, run.id)
    const role = this.gameStore.getRoleForUser(userId)
    if (role) {
      this.gameStore.progressTaskByGuild(role.guild_id, 'contracts', 1)
      this.gameStore.progressTaskByGuild(role.guild_id, 'victories', 1)
    }
    this.regions.unlockRegions(userId)
    return { character: this.players.getCharacter(userId), boss: this.bossSnapshot(userId) }
  }

  persistEnemies(enemies, now) {
    const update = this.db.prepare(`
      UPDATE player_expedition_enemies SET health = ?, distance = ?, elevation = ?,
        intent = ?, status = ?, updated_at = ? WHERE id = ?
    `)
    for (const enemy of enemies) {
      update.run(Math.max(0, Number(enemy.health)), Number(enemy.distance), Number(enemy.elevation), enemy.intent, enemy.status, now, enemy.id)
    }
  }

  actSquad(userId, input, tacticMode = false) {
    const action = String(input.action ?? '')
    const valid = tacticMode ? ['cover', 'trap'].includes(action) : ACTIONS.has(action)
    if (!valid) throw new StoreError('invalid-combat-action', 'Неизвестное боевое действие.')
    const targetId = String(input.targetId ?? '').slice(0, 96)
    const receiptAction = tacticMode ? `expedition:tactic:${action}` : `expedition:${action}:${targetId || 'auto'}`

    return this.players.withReceipt(userId, input.requestId, receiptAction, () => {
      const character = this.db.prepare('SELECT * FROM player_characters WHERE user_id = ?').get(userId)
      const run = this.db.prepare(`
        SELECT * FROM player_expeditions WHERE id = ? AND user_id = ? AND status = 'active'
      `).get(String(input.expeditionId ?? ''), userId)
      if (!character || !run || !['group', 'boss'].includes(run.encounter_type)) throw new StoreError('expedition-not-found', 'Групповой бой не найден.', 404)
      if (!character.alive) throw new StoreError('character-dead', 'Герой уже погиб.', 409)
      const offer = run.encounter_type === 'group'
        ? this.db.prepare('SELECT * FROM player_contract_offers WHERE id = ? AND user_id = ?').get(run.offer_id, userId)
        : null
      if (run.encounter_type === 'group' && !offer) throw new StoreError('contract-not-found', 'Сервер потерял контракт группы.', 500)

      const snapshot = parseSnapshot(run.contract_snapshot_json)
      const enemies = this.enemyRows(run.id)
      const active = enemies.filter((enemy) => enemy.status === 'active' && Number(enemy.health) > 0)
      const target = this.chooseTarget(active, targetId, run.target_enemy_id)
      const injuries = new Map(this.db.prepare(`
        SELECT kind, MAX(severity) AS severity FROM player_injuries
        WHERE user_id = ? AND status = 'active' GROUP BY kind
      `).all(userId).map((row) => [row.kind, Number(row.severity)]))
      const profile = this.equipment.profile(userId)
      let health = Number(character.health)
      let stamina = Number(character.stamina)
      let guard = Number(run.guard)
      let prepared = Boolean(run.prepared)
      let heroElevation = Number(run.hero_elevation)
      let bossPhase = Number(run.boss_phase)
      let skipEnemy = false
      const log = []
      const levelBonus = Math.floor(Number(character.level) / 4)
      const weaponBonus = this.mainHandType(userId) === 'weapon' ? 1 : 0
      const attackCost = this.attackCost(injuries)
      const moveCost = this.movementCost(userId, snapshot, injuries, profile)
      const zone = this.zonePower(active)
      const opportunity = Math.max(0, zone - Number(profile.zoneResistance ?? 0))

      if (action === 'advance' || action === 'retreat') {
        if (stamina < moveCost) throw new StoreError('not-enough-stamina', `Для движения нужно ${moveCost} силы.`, 409)
        if (action === 'advance') {
          if (active.every((enemy) => Number(enemy.distance) <= 0)) throw new StoreError('already-close', 'Все живые враги уже рядом.', 409)
          active.forEach((enemy) => { enemy.distance = Math.max(0, Number(enemy.distance) - 1) })
          log.push('Ты продвигаешься через строй врагов.')
        } else {
          if (active.every((enemy) => Number(enemy.distance) >= Number(run.max_distance))) throw new StoreError('already-far', 'Местность не позволяет отойти дальше.', 409)
          active.forEach((enemy) => { enemy.distance = Math.min(Number(run.max_distance), Number(enemy.distance) + 1) })
          if (opportunity > 0) {
            health -= opportunity
            log.push(`Зона контроля наносит ${opportunity} урона при отходе.`)
          }
          log.push('Ты разрываешь строй и увеличиваешь дистанцию.')
        }
        stamina -= moveCost
      } else if (action === 'climb' || action === 'descend') {
        const cost = action === 'climb' ? moveCost + 1 : moveCost
        if (stamina < cost) throw new StoreError('not-enough-stamina', `Для смены высоты нужно ${cost} силы.`, 409)
        if (action === 'climb') {
          if (heroElevation >= Number(run.max_elevation)) throw new StoreError('maximum-elevation', 'Выше подняться нельзя.', 409)
          heroElevation += 1
          log.push(`Ты поднимаешься на высоту ${heroElevation}.`)
        } else {
          if (heroElevation <= 0) throw new StoreError('minimum-elevation', 'Ты уже находишься внизу.', 409)
          heroElevation -= 1
          log.push(`Ты спускаешься на высоту ${heroElevation}.`)
        }
        if (opportunity > 0) {
          health -= opportunity
          log.push(`Враги удерживают проход и наносят ${opportunity} урона.`)
        }
        stamina -= cost
      } else if (action === 'attack') {
        if (stamina < attackCost) throw new StoreError('not-enough-stamina', `Травмы требуют ${attackCost} дополнительной силы.`, 409)
        stamina -= attackCost
        const highGround = heroElevation - Number(target.elevation)
        const rangeDamage = Number(target.distance) === 0 ? 3 : Number(target.distance) === 1 ? 2 : 1
        const heightDamage = highGround > 0 ? 1 + Number(profile.elevationBonus ?? 0) : highGround < 0 ? -1 : 0
        const damage = Math.max(1, rangeDamage + levelBonus + weaponBonus + heightDamage + (prepared ? 2 : 0))
        target.health = Number(target.health) - damage
        prepared = false
        log.push(`Ты атакуешь «${target.enemy_name}» и наносишь ${damage} урона.`)
      } else if (action === 'guard') {
        guard = Math.min(10, guard + 4 + Number(profile.armor > 0))
        log.push('Ты удерживаешь позицию против нескольких направлений атаки.')
      } else if (action === 'prepare') {
        prepared = true
        stamina = Math.min(Number(character.max_stamina), stamina + 1)
        log.push('Ты выбираешь цель и восстанавливаешь 1 силу.')
      } else if (action === 'flee') {
        const minimumDistance = Math.min(...active.map((enemy) => Number(enemy.distance)))
        const chance = 12 + minimumDistance * 18 + stamina * 3 + Number(character.insight) * 2 - zone * 8
        const escaped = stableNumber(`${run.id}:group-flee:${run.turn}`) % 100 < chance
        if (escaped) {
          const now = Date.now()
          this.db.prepare("UPDATE player_expeditions SET status = 'fled', turn = turn + 1, last_log_json = ?, updated_at = ? WHERE id = ?")
            .run(JSON.stringify(['Ты находишь разрыв между врагами и уходишь.']), now, run.id)
          this.db.prepare('UPDATE player_characters SET stamina = MAX(0, stamina - 1), updated_at = ? WHERE user_id = ?').run(now, userId)
          if (run.offer_id) this.db.prepare("UPDATE player_contract_offers SET status = 'fled', closed_at = ? WHERE id = ?").run(now, run.offer_id)
          return { character: this.players.getCharacter(userId), boss: this.bossSnapshot(userId) }
        }
        stamina = Math.max(0, stamina - 1)
        log.push('Отряд закрывает путь к отступлению.')
      } else if (action === 'cover') {
        const natural = NATURAL_COVER.has(run.terrain_id)
        if (!natural) this.marshSystem.consume(userId, 'reed-screen', 1)
        const tacticPenalty = Number(injuries.get('salt-burn') ?? 0)
        if (stamina < tacticPenalty) throw new StoreError('not-enough-stamina', `Соляной ожог требует ${tacticPenalty} силы.`, 409)
        stamina -= tacticPenalty
        guard = Math.min(12, guard + (natural ? 5 : 7))
        log.push(natural ? 'Ты используешь естественное укрытие.' : 'Ты разворачиваешь тростниковый экран.')
      } else if (action === 'trap') {
        const tacticPenalty = Number(injuries.get('salt-burn') ?? 0)
        if (stamina < tacticPenalty) throw new StoreError('not-enough-stamina', `Соляной ожог требует ${tacticPenalty} силы.`, 409)
        stamina -= tacticPenalty
        this.marshSystem.consume(userId, 'reed-snare', 1)
        const spikes = this.marshSystem.inventoryQuantity(userId, 'brine-spikes') > 0
        if (spikes) this.marshSystem.consume(userId, 'brine-spikes', 1)
        const damage = spikes ? 8 : 5
        target.health = Number(target.health) - damage
        target.distance = Math.min(Number(run.max_distance), Number(target.distance) + 1)
        skipEnemy = true
        log.push(`Ловушка удерживает «${target.enemy_name}» и наносит ${damage} урона${spikes ? ' усиленными шипами' : ''}.`)
      } else {
        if (stamina < attackCost) throw new StoreError('not-enough-stamina', `Травмы требуют ${attackCost} дополнительной силы.`, 409)
        stamina -= attackCost
        const profession = character.profession
        const distance = Number(target.distance)
        const height = heroElevation - Number(target.elevation)
        if (profession === 'blacksmith') {
          if (distance !== 0) throw new StoreError('wrong-distance', 'Кузнечный замах работает только вплотную.', 409)
          if (stamina < 1) throw new StoreError('not-enough-stamina', 'Не хватает сил для замаха.', 409)
          const damage = 6 + levelBonus + weaponBonus + (height > 0 ? 1 : 0)
          target.health = Number(target.health) - damage
          stamina -= 1
          log.push(`Кузнечный замах поражает «${target.enemy_name}» на ${damage}.`)
        } else if (profession === 'herbalist') {
          const healed = Math.min(3, Number(character.max_health) - health)
          health += healed
          target.health = Number(target.health) - (distance <= 1 ? 2 : 0)
          log.push(`Настойка восстанавливает ${healed} здоровья и обжигает цель.`)
        } else if (profession === 'hunter') {
          const damage = distance >= 2 ? 7 + levelBonus : distance === 1 ? 5 + levelBonus : 2 + levelBonus
          target.health = Number(target.health) - damage
          log.push(`Охотничий выстрел наносит «${target.enemy_name}» ${damage} урона.`)
        } else if (profession === 'scribe') {
          target.health = Number(target.health) - 2
          if (['heavy', 'hex'].includes(target.intent)) {
            target.intent = 'guard'
            skipEnemy = true
            log.push('Писарь срывает опасное намерение выбранной цели.')
          } else log.push('Писарь отмечает слабое место цели.')
        } else if (profession === 'carter') {
          target.health = Number(target.health) - 2
          target.distance = Math.max(0, distance - 1)
          guard = Math.min(11, guard + 4)
          log.push('Дорожный крюк вытягивает цель из строя и усиливает защиту.')
        } else {
          const change = stableNumber(`${run.id}:wanderer:${run.turn}`) % 2 === 0 ? -1 : 1
          target.distance = clamp(distance + change, 0, Number(run.max_distance))
          const damage = 3 + stableNumber(`${run.id}:wanderer-damage:${run.turn}`) % 4
          target.health = Number(target.health) - damage
          log.push(`Странник ломает строй и наносит ${damage} урона.`)
        }
      }

      this.markDefeated(enemies, log)
      bossPhase = this.maybeChangeBossPhase(run, enemies, log)
      const refreshed = this.activeEnemyRows(run.id)
      const merged = enemies.map((enemy) => refreshed.find((row) => row.id === enemy.id) ?? enemy)
      for (const extra of refreshed) if (!merged.some((enemy) => enemy.id === extra.id)) merged.push(extra)
      const aliveAfterAction = merged.filter((enemy) => enemy.status === 'active' && Number(enemy.health) > 0)
      const now = Date.now()

      if (aliveAfterAction.length === 0) {
        this.persistEnemies(merged, now)
        return this.finishVictory(userId, character, run, offer, merged, { health, stamina, guard, heroElevation }, log, now)
      }

      if (!skipEnemy) {
        const enemyResult = this.enemyPhase({ ...run, boss_phase: bossPhase }, offer, aliveAfterAction, { health, stamina, guard, heroElevation }, profile, log)
        health = enemyResult.health
        stamina = enemyResult.stamina
        guard = enemyResult.guard
      }

      this.markDefeated(merged, log)
      const nextTurn = Number(run.turn) + 1
      if (health <= 0) {
        const difficulty = Number(offer?.difficulty ?? snapshot.difficulty ?? 6)
        const glory = Number(character.level) + Math.floor(Number(character.reputation) / 5) + difficulty
        log.push('Герой погиб под ударами отряда.')
        this.db.prepare(`
          UPDATE player_characters SET health = 0, stamina = ?, alive = 0, deaths = deaths + 1,
            legacy_glory = legacy_glory + ?, updated_at = ? WHERE user_id = ?
        `).run(stamina, glory, now, userId)
        this.persistEnemies(merged, now)
        this.db.prepare(`
          UPDATE player_expeditions SET status = 'dead', turn = ?, guard = 0, prepared = 0,
            hero_elevation = ?, boss_phase = ?, last_log_json = ?, updated_at = ? WHERE id = ?
        `).run(nextTurn, heroElevation, bossPhase, JSON.stringify(log), now, run.id)
        if (run.offer_id) this.db.prepare("UPDATE player_contract_offers SET status = 'dead', closed_at = ? WHERE id = ?").run(now, run.offer_id)
        return { character: this.players.getCharacter(userId), boss: this.bossSnapshot(userId) }
      }

      const alive = merged.filter((enemy) => enemy.status === 'active' && Number(enemy.health) > 0)
      const selected = alive.find((enemy) => enemy.id === target.id) ?? alive[0]
      const totalHealth = alive.reduce((sum, enemy) => sum + Number(enemy.health), 0)
      const totalMax = merged.reduce((sum, enemy) => sum + Number(enemy.max_health), 0)
      const zoneControl = this.zonePower(alive)
      this.persistEnemies(merged, now)
      this.db.prepare('UPDATE player_characters SET health = ?, stamina = ?, updated_at = ? WHERE user_id = ?').run(health, stamina, now, userId)
      this.db.prepare(`
        UPDATE player_expeditions SET enemy_health = ?, enemy_max_health = ?, enemy_name = ?, enemy_intent = ?,
          turn = ?, distance = ?, guard = ?, prepared = ?, hero_elevation = ?, zone_control = ?,
          boss_phase = ?, target_enemy_id = ?, last_log_json = ?, updated_at = ? WHERE id = ?
      `).run(
        totalHealth, totalMax, run.encounter_type === 'boss' ? 'Глухобор и свита' : 'Отряд Соляных топей',
        selected?.intent ?? 'attack', nextTurn, Number(selected?.distance ?? 0), guard, prepared ? 1 : 0,
        heroElevation, zoneControl, bossPhase, selected?.id ?? null, JSON.stringify(log), now, run.id,
      )
      return { character: this.players.getCharacter(userId), boss: this.bossSnapshot(userId) }
    })
  }
}
