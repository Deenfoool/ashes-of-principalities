import { createHash, randomUUID } from 'node:crypto'
import { StoreError } from './store.mjs'

const BOSS_ID = 'ash-crowned-devourer'
const LEADER_INACTIVITY = 14 * 24 * 60 * 60 * 1000
const SUCCESSOR_ACTIVITY = 7 * 24 * 60 * 60 * 1000
const RAID_COOLDOWN = 7 * 24 * 60 * 60 * 1000
const FAILED_COOLDOWN = 24 * 60 * 60 * 1000
const MAX_RAID_ACTIONS = 12

export const guildResourceDefinitions = {
  'scrap-iron': 'Лом железа',
  charcoal: 'Древесный уголь',
  'burnt-hide': 'Обожжённая шкура',
  cloth: 'Грубая ткань',
  'river-bone': 'Речная кость',
  'bitter-herb': 'Горькая трава',
  'salt-moss': 'Соляной мох',
  'black-reed': 'Чёрный тростник',
  'brine-crystal': 'Рассольный кристалл',
  'drowned-brass': 'Утопленная бронза',
  'white-bell-heart': 'Сердце белого колокола',
}

const RAID_REQUIREMENTS = {
  'scrap-iron': 12,
  'black-reed': 10,
  'drowned-brass': 6,
  'salt-moss': 8,
  'brine-crystal': 4,
  'white-bell-heart': 1,
}

const RAID_INTENTS = ['crush', 'ash-breath', 'devour', 'summon']
const stableNumber = (value) => createHash('sha256').update(value).digest().readUInt32BE(0)
const cleanAmount = (value, maximum = 1000) => {
  const amount = Math.floor(Number(value))
  if (!Number.isFinite(amount) || amount < 1 || amount > maximum) {
    throw new StoreError('invalid-amount', `Количество должно быть целым числом от 1 до ${maximum}.`)
  }
  return amount
}

function publicResource(row) {
  return {
    id: row.item_id,
    name: row.item_name,
    quantity: Number(row.quantity),
    reserved: Number(row.reserved),
    available: Number(row.quantity) - Number(row.reserved),
    updatedAt: Number(row.updated_at),
  }
}

export class GuildExpansionStore {
  constructor(gameStore, players) {
    this.gameStore = gameStore
    this.players = players
    this.db = gameStore.db
    this.patchActivitySnapshot()
  }

  patchActivitySnapshot() {
    const originalSnapshot = this.gameStore.getSnapshot.bind(this.gameStore)
    this.gameStore.getSnapshot = (userId) => {
      this.touchActivity(userId)
      const role = this.gameStore.getRoleForUser(userId)
      if (role) this.checkAutomaticTransfer(role.guild_id)
      return originalSnapshot(userId)
    }
  }

  requireRole(userId) {
    const role = this.gameStore.getRoleForUser(userId)
    if (!role) throw new StoreError('not-in-guild', 'Ты не состоишь в гильдии.', 404)
    this.touchActivity(userId)
    return role
  }

  touchActivity(userId, now = Date.now()) {
    this.db.prepare('UPDATE guild_members SET last_active_at = ? WHERE user_id = ?').run(now, userId)
  }

  syncResourceTotal(guildId) {
    const total = Number(this.db.prepare('SELECT COALESCE(SUM(quantity), 0) AS total FROM guild_resource_stock WHERE guild_id = ?').get(guildId).total)
    this.db.prepare('UPDATE guilds SET treasury_resources = ? WHERE id = ?').run(total, guildId)
    return total
  }

  stockRows(guildId) {
    return this.db.prepare(`
      SELECT * FROM guild_resource_stock WHERE guild_id = ?
      ORDER BY item_name COLLATE NOCASE
    `).all(guildId)
  }

  resourceLog(guildId, limit = 40) {
    return this.db.prepare(`
      SELECT l.id, l.operation, l.item_id AS itemId, l.item_name AS itemName,
        l.quantity, l.created_at AS createdAt, u.display_name AS playerName
      FROM guild_resource_log l
      JOIN users u ON u.id = l.user_id
      WHERE l.guild_id = ? ORDER BY l.created_at DESC LIMIT ?
    `).all(guildId, Math.min(100, Math.max(1, Number(limit) || 40))).map((row) => ({
      ...row,
      quantity: Number(row.quantity),
      createdAt: Number(row.createdAt),
    }))
  }

  resourceSnapshot(userId) {
    const role = this.requireRole(userId)
    const character = this.players.getCharacter(userId)
    const inventory = new Map((character?.inventory ?? []).map((item) => [item.id, Number(item.quantity)]))
    return {
      stock: this.stockRows(role.guild_id).map(publicResource),
      log: this.resourceLog(role.guild_id),
      allowed: Object.entries(guildResourceDefinitions).map(([id, name]) => ({
        id,
        name,
        owned: inventory.get(id) ?? 0,
      })),
      canWithdraw: Boolean(role.can_use_treasury),
      total: this.syncResourceTotal(role.guild_id),
    }
  }

  addResourceLog(guildId, userId, operation, itemId, quantity, now = Date.now()) {
    this.db.prepare(`
      INSERT INTO guild_resource_log(id, guild_id, user_id, operation, item_id, item_name, quantity, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(randomUUID(), guildId, userId, operation, itemId, guildResourceDefinitions[itemId] ?? itemId, quantity, now)
  }

  depositResource(userId, input) {
    const itemId = String(input.itemId ?? '')
    const itemName = guildResourceDefinitions[itemId]
    if (!itemName) throw new StoreError('resource-not-allowed', 'Этот предмет нельзя хранить в ресурсной казне.', 409)
    const quantity = cleanAmount(input.quantity)
    return this.players.withReceipt(userId, input.requestId, `guild-resource:deposit:${itemId}:${quantity}`, () => {
      const role = this.requireRole(userId)
      const owned = this.db.prepare('SELECT quantity FROM player_inventory WHERE user_id = ? AND item_id = ?').get(userId, itemId)
      if (Number(owned?.quantity ?? 0) < quantity) throw new StoreError('not-enough-resources', `Не хватает ресурса «${itemName}».`, 409)
      const now = Date.now()
      this.db.prepare('UPDATE player_inventory SET quantity = quantity - ? WHERE user_id = ? AND item_id = ?').run(quantity, userId, itemId)
      this.db.prepare('DELETE FROM player_inventory WHERE user_id = ? AND item_id = ? AND quantity <= 0').run(userId, itemId)
      this.db.prepare(`
        INSERT INTO guild_resource_stock(guild_id, item_id, item_name, quantity, reserved, updated_at)
        VALUES (?, ?, ?, ?, 0, ?)
        ON CONFLICT(guild_id, item_id) DO UPDATE SET
          quantity = quantity + excluded.quantity,
          item_name = excluded.item_name,
          updated_at = excluded.updated_at
      `).run(role.guild_id, itemId, itemName, quantity, now)
      this.addResourceLog(role.guild_id, userId, 'deposit', itemId, quantity, now)
      this.syncResourceTotal(role.guild_id)
      return { character: this.players.getCharacter(userId), resources: this.resourceSnapshot(userId) }
    })
  }

  withdrawResource(userId, input) {
    const itemId = String(input.itemId ?? '')
    const itemName = guildResourceDefinitions[itemId]
    if (!itemName) throw new StoreError('resource-not-allowed', 'Этот предмет не относится к ресурсной казне.', 409)
    const quantity = cleanAmount(input.quantity, 100)
    return this.players.withReceipt(userId, input.requestId, `guild-resource:withdraw:${itemId}:${quantity}`, () => {
      const role = this.requireRole(userId)
      if (!role.can_use_treasury) throw new StoreError('forbidden', 'У твоей роли нет права выдавать ресурсы из казны.', 403)
      const stock = this.db.prepare('SELECT quantity, reserved FROM guild_resource_stock WHERE guild_id = ? AND item_id = ?').get(role.guild_id, itemId)
      const available = Number(stock?.quantity ?? 0) - Number(stock?.reserved ?? 0)
      if (available < quantity) throw new StoreError('resource-reserved', `В казне доступно только ${available} ед. ресурса «${itemName}».`, 409)
      const now = Date.now()
      this.db.prepare('UPDATE guild_resource_stock SET quantity = quantity - ?, updated_at = ? WHERE guild_id = ? AND item_id = ?')
        .run(quantity, now, role.guild_id, itemId)
      this.players.addInventory(userId, itemId, itemName, quantity)
      this.addResourceLog(role.guild_id, userId, 'withdraw', itemId, quantity, now)
      this.syncResourceTotal(role.guild_id)
      return { character: this.players.getCharacter(userId), resources: this.resourceSnapshot(userId) }
    })
  }

  roleIds(guildId) {
    const roles = this.db.prepare('SELECT id, name, position FROM guild_roles WHERE guild_id = ? ORDER BY position DESC').all(guildId)
    return {
      leader: roles.find((role) => Number(role.position) >= 100)?.id,
      deputy: roles.find((role) => Number(role.position) < 100 && Number(role.position) >= 80)?.id
        ?? roles.find((role) => Number(role.position) < 100)?.id,
    }
  }

  transferRows(guildId, previousLeaderId, nextLeaderId, reason, now = Date.now()) {
    const roles = this.roleIds(guildId)
    if (!roles.leader || !roles.deputy) throw new StoreError('leadership-roles-missing', 'Сервер не нашёл роли главы и заместителя.', 500)
    this.db.prepare('UPDATE guilds SET leader_id = ? WHERE id = ?').run(nextLeaderId, guildId)
    this.db.prepare('UPDATE guild_members SET role_id = ?, last_active_at = ? WHERE guild_id = ? AND user_id = ?')
      .run(roles.leader, now, guildId, nextLeaderId)
    this.db.prepare('UPDATE guild_members SET role_id = ?, last_active_at = ? WHERE guild_id = ? AND user_id = ?')
      .run(roles.deputy, now, guildId, previousLeaderId)
    this.db.prepare(`
      INSERT INTO guild_leadership_log(id, guild_id, previous_leader_id, next_leader_id, reason, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(randomUUID(), guildId, previousLeaderId, nextLeaderId, reason, now)
  }

  checkAutomaticTransfer(guildId, now = Date.now()) {
    const leader = this.db.prepare(`
      SELECT g.leader_id AS id, gm.last_active_at AS lastActiveAt
      FROM guilds g JOIN guild_members gm ON gm.guild_id = g.id AND gm.user_id = g.leader_id
      WHERE g.id = ?
    `).get(guildId)
    if (!leader || Number(leader.lastActiveAt) > now - LEADER_INACTIVITY) return null
    const successor = this.db.prepare(`
      SELECT gm.user_id AS id, gm.last_active_at AS lastActiveAt, gr.position
      FROM guild_members gm JOIN guild_roles gr ON gr.id = gm.role_id
      WHERE gm.guild_id = ? AND gm.user_id <> ? AND gm.last_active_at >= ?
      ORDER BY gr.position DESC, gm.last_active_at DESC, gm.joined_at ASC LIMIT 1
    `).get(guildId, leader.id, now - SUCCESSOR_ACTIVITY)
    if (!successor) return null
    this.gameStore.transaction(() => this.transferRows(guildId, leader.id, successor.id, 'inactivity', now))
    return successor.id
  }

  leadershipSnapshot(userId) {
    let role = this.requireRole(userId)
    this.checkAutomaticTransfer(role.guild_id)
    role = this.gameStore.getRoleForUser(userId)
    const guild = this.db.prepare('SELECT leader_id FROM guilds WHERE id = ?').get(role.guild_id)
    const members = this.db.prepare(`
      SELECT u.id, u.username, u.display_name AS displayName, gm.joined_at AS joinedAt,
        gm.last_active_at AS lastActiveAt, gr.name AS roleName, gr.position AS rolePosition,
        CASE WHEN u.id = ? THEN 1 ELSE 0 END AS isLeader
      FROM guild_members gm
      JOIN users u ON u.id = gm.user_id
      JOIN guild_roles gr ON gr.id = gm.role_id
      WHERE gm.guild_id = ? ORDER BY gr.position DESC, gm.joined_at ASC
    `).all(guild.leader_id, role.guild_id).map((member) => ({
      ...member,
      joinedAt: Number(member.joinedAt),
      lastActiveAt: Number(member.lastActiveAt),
      rolePosition: Number(member.rolePosition),
      isLeader: Boolean(member.isLeader),
    }))
    const history = this.db.prepare(`
      SELECT l.id, l.reason, l.created_at AS createdAt,
        previous.display_name AS previousLeaderName, next.display_name AS nextLeaderName
      FROM guild_leadership_log l
      JOIN users previous ON previous.id = l.previous_leader_id
      JOIN users next ON next.id = l.next_leader_id
      WHERE l.guild_id = ? ORDER BY l.created_at DESC LIMIT 20
    `).all(role.guild_id).map((entry) => ({ ...entry, createdAt: Number(entry.createdAt) }))
    return {
      leaderId: guild.leader_id,
      canTransfer: guild.leader_id === userId,
      inactivityDays: 14,
      successorActivityDays: 7,
      members,
      history,
    }
  }

  transferLeadership(userId, input) {
    const targetUserId = String(input.targetUserId ?? '')
    return this.players.withReceipt(userId, input.requestId, `guild-leadership:transfer:${targetUserId}`, () => {
      const role = this.requireRole(userId)
      const guild = this.db.prepare('SELECT leader_id FROM guilds WHERE id = ?').get(role.guild_id)
      if (guild.leader_id !== userId) throw new StoreError('forbidden', 'Только действующий глава может добровольно передать власть.', 403)
      if (!targetUserId || targetUserId === userId) throw new StoreError('invalid-successor', 'Выбери другого участника гильдии.', 409)
      const target = this.db.prepare('SELECT user_id FROM guild_members WHERE guild_id = ? AND user_id = ?').get(role.guild_id, targetUserId)
      if (!target) throw new StoreError('member-not-found', 'Преемник не состоит в этой гильдии.', 404)
      this.transferRows(role.guild_id, userId, targetUserId, 'voluntary')
      return { leadership: this.leadershipSnapshot(userId) }
    })
  }

  ensureRaidProject(guildId) {
    const now = Date.now()
    this.db.prepare(`
      INSERT OR IGNORE INTO guild_raid_projects(
        guild_id, boss_id, status, health, max_health, shield, max_shield,
        morale, max_morale, round, intent, requirements_json, updated_at
      ) VALUES (?, ?, 'preparing', 120, 120, 40, 40, 140, 140, 1, 'crush', ?, ?)
    `).run(guildId, BOSS_ID, JSON.stringify(RAID_REQUIREMENTS), now)
    const project = this.db.prepare('SELECT * FROM guild_raid_projects WHERE guild_id = ? AND boss_id = ?').get(guildId, BOSS_ID)
    if (['won', 'failed', 'cooldown'].includes(project.status) && Number(project.cooldown_until ?? 0) <= now) {
      this.db.prepare('DELETE FROM guild_raid_participants WHERE guild_id = ? AND boss_id = ?').run(guildId, BOSS_ID)
      this.db.prepare(`
        UPDATE guild_raid_projects SET status = 'preparing', health = max_health, shield = max_shield,
          morale = max_morale, round = 1, intent = 'crush', prepared_by = NULL, started_by = NULL,
          prepared_at = NULL, started_at = NULL, ended_at = NULL, cooldown_until = NULL, updated_at = ?
        WHERE guild_id = ? AND boss_id = ?
      `).run(now, guildId, BOSS_ID)
      return this.db.prepare('SELECT * FROM guild_raid_projects WHERE guild_id = ? AND boss_id = ?').get(guildId, BOSS_ID)
    }
    return project
  }

  raidLog(guildId) {
    return this.db.prepare(`
      SELECT l.id, l.event_type AS type, l.message, l.round, l.created_at AS createdAt,
        u.display_name AS playerName
      FROM guild_raid_log l LEFT JOIN users u ON u.id = l.user_id
      WHERE l.guild_id = ? AND l.boss_id = ? ORDER BY l.created_at DESC LIMIT 40
    `).all(guildId, BOSS_ID).map((entry) => ({
      ...entry,
      round: Number(entry.round),
      createdAt: Number(entry.createdAt),
    }))
  }

  addRaidLog(guildId, userId, type, message, round, now = Date.now()) {
    this.db.prepare(`
      INSERT INTO guild_raid_log(id, guild_id, boss_id, user_id, event_type, message, round, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(randomUUID(), guildId, BOSS_ID, userId ?? null, type, message, round, now)
  }

  raidSnapshot(userId) {
    const role = this.requireRole(userId)
    const project = this.ensureRaidProject(role.guild_id)
    const stock = new Map(this.stockRows(role.guild_id).map((row) => [row.item_id, row]))
    const requirements = Object.entries(RAID_REQUIREMENTS).map(([id, required]) => {
      const row = stock.get(id)
      return {
        id,
        name: guildResourceDefinitions[id],
        required,
        quantity: Number(row?.quantity ?? 0),
        reserved: Number(row?.reserved ?? 0),
        available: Number(row?.quantity ?? 0) - Number(row?.reserved ?? 0),
        ready: Number(row?.reserved ?? 0) >= required || (project.status === 'preparing' && Number(row?.quantity ?? 0) - Number(row?.reserved ?? 0) >= required),
      }
    })
    const participants = this.db.prepare(`
      SELECT p.user_id AS userId, u.display_name AS playerName, c.profession, c.level,
        p.joined_at AS joinedAt, p.actions, p.damage, p.support, p.reward_claimed AS rewardClaimed
      FROM guild_raid_participants p
      JOIN users u ON u.id = p.user_id
      LEFT JOIN player_characters c ON c.user_id = p.user_id
      WHERE p.guild_id = ? AND p.boss_id = ? ORDER BY p.damage DESC, p.support DESC, p.joined_at
    `).all(role.guild_id, BOSS_ID).map((participant) => ({
      ...participant,
      level: Number(participant.level ?? 0),
      joinedAt: Number(participant.joinedAt),
      actions: Number(participant.actions),
      damage: Number(participant.damage),
      support: Number(participant.support),
      rewardClaimed: Boolean(participant.rewardClaimed),
      isSelf: participant.userId === userId,
    }))
    const guild = this.db.prepare('SELECT leader_id, warband, workshops, member_count FROM (SELECT g.*, (SELECT COUNT(*) FROM guild_members gm WHERE gm.guild_id = g.id) AS member_count FROM guilds g) WHERE id = ?').get(role.guild_id)
    const self = participants.find((participant) => participant.userId === userId)
    return {
      boss: {
        id: BOSS_ID,
        title: 'Пепельный князеглод Чернопол',
        description: 'Тварь из княжеской курганной золы пожирает имена родов и ломает общинные знамёна. Её чешуйчатый венец сначала нужно расколоть, не дав дружине потерять боевой дух.',
        status: project.status,
        health: Number(project.health),
        maxHealth: Number(project.max_health),
        shield: Number(project.shield),
        maxShield: Number(project.max_shield),
        morale: Number(project.morale),
        maxMorale: Number(project.max_morale),
        round: Number(project.round),
        intent: project.intent,
        attempts: Number(project.attempts),
        victories: Number(project.victories),
        cooldownUntil: project.cooldown_until ? Number(project.cooldown_until) : null,
        maxActionsPerMember: MAX_RAID_ACTIONS,
      },
      requirements,
      participants,
      log: this.raidLog(role.guild_id),
      permissions: {
        canPrepare: Boolean(role.can_use_treasury),
        canStart: guild.leader_id === userId || Number(role.position) >= 80,
        canJoin: project.status === 'ready' && !self,
        canAct: project.status === 'active' && Boolean(self) && Number(self.actions) < MAX_RAID_ACTIONS,
      },
      minimumParticipants: Number(guild.member_count) <= 1 ? 1 : 2,
    }
  }

  expansionSnapshot(userId) {
    return {
      resources: this.resourceSnapshot(userId),
      leadership: this.leadershipSnapshot(userId),
      raid: this.raidSnapshot(userId),
    }
  }

  reserveRaidResources(guildId, userId, now) {
    for (const [itemId, quantity] of Object.entries(RAID_REQUIREMENTS)) {
      const row = this.db.prepare('SELECT quantity, reserved FROM guild_resource_stock WHERE guild_id = ? AND item_id = ?').get(guildId, itemId)
      if (Number(row?.quantity ?? 0) - Number(row?.reserved ?? 0) < quantity) {
        throw new StoreError('raid-resources-missing', `Для подготовки не хватает ресурса «${guildResourceDefinitions[itemId]}».`, 409)
      }
    }
    for (const [itemId, quantity] of Object.entries(RAID_REQUIREMENTS)) {
      this.db.prepare('UPDATE guild_resource_stock SET reserved = reserved + ?, updated_at = ? WHERE guild_id = ? AND item_id = ?')
        .run(quantity, now, guildId, itemId)
      this.addResourceLog(guildId, userId, 'reserve', itemId, quantity, now)
    }
  }

  prepareRaid(userId, input) {
    return this.players.withReceipt(userId, input.requestId, `guild-raid:prepare:${BOSS_ID}`, () => {
      const role = this.requireRole(userId)
      if (!role.can_use_treasury) throw new StoreError('forbidden', 'Для подготовки рейда нужно право распоряжаться казной.', 403)
      const project = this.ensureRaidProject(role.guild_id)
      if (project.status !== 'preparing') throw new StoreError('raid-not-preparing', 'Подготовка этого рейда уже завершена.', 409)
      const now = Date.now()
      this.reserveRaidResources(role.guild_id, userId, now)
      this.db.prepare(`
        UPDATE guild_raid_projects SET status = 'ready', prepared_by = ?, prepared_at = ?, updated_at = ?
        WHERE guild_id = ? AND boss_id = ?
      `).run(userId, now, now, role.guild_id, BOSS_ID)
      this.addRaidLog(role.guild_id, userId, 'prepared', 'Ресурсы запечатаны. Дружина может записываться на выход.', 1, now)
      return { raid: this.raidSnapshot(userId), resources: this.resourceSnapshot(userId) }
    })
  }

  joinRaid(userId, input) {
    return this.players.withReceipt(userId, input.requestId, `guild-raid:join:${BOSS_ID}`, () => {
      const role = this.requireRole(userId)
      const project = this.ensureRaidProject(role.guild_id)
      if (project.status !== 'ready') throw new StoreError('raid-not-ready', 'Записаться можно только после подготовки и до начала боя.', 409)
      const character = this.db.prepare('SELECT * FROM player_characters WHERE user_id = ?').get(userId)
      if (!character?.alive) throw new StoreError('character-required', 'Для рейда нужен живой серверный герой.', 409)
      if (Number(character.level) < 4) throw new StoreError('raid-level-required', 'Для гильдейского босса нужен хотя бы 4-й уровень.', 409)
      if (this.players.getActiveRun(userId)) throw new StoreError('expedition-active', 'Сначала заверши личный поход.', 409)
      if (Number(character.stamina) < 3) throw new StoreError('not-enough-stamina', 'Для вступления в рейд нужно 3 силы.', 409)
      const now = Date.now()
      this.db.prepare('UPDATE player_characters SET stamina = stamina - 3, updated_at = ? WHERE user_id = ?').run(now, userId)
      this.db.prepare(`
        INSERT INTO guild_raid_participants(guild_id, boss_id, user_id, joined_at)
        VALUES (?, ?, ?, ?)
      `).run(role.guild_id, BOSS_ID, userId, now)
      this.addRaidLog(role.guild_id, userId, 'joined', `${character.name} входит в состав дружины.`, 1, now)
      return { character: this.players.getCharacter(userId), raid: this.raidSnapshot(userId) }
    })
  }

  consumeReservedResources(guildId, userId, now) {
    for (const [itemId, quantity] of Object.entries(RAID_REQUIREMENTS)) {
      const result = this.db.prepare(`
        UPDATE guild_resource_stock SET quantity = quantity - ?, reserved = reserved - ?, updated_at = ?
        WHERE guild_id = ? AND item_id = ? AND reserved >= ? AND quantity >= ?
      `).run(quantity, quantity, now, guildId, itemId, quantity, quantity)
      if (Number(result.changes) !== 1) throw new StoreError('raid-reservation-lost', 'Резерв подготовки повреждён. Рейд не начат.', 409)
      this.addResourceLog(guildId, userId, 'consume', itemId, quantity, now)
    }
    this.syncResourceTotal(guildId)
  }

  startRaid(userId, input) {
    return this.players.withReceipt(userId, input.requestId, `guild-raid:start:${BOSS_ID}`, () => {
      const role = this.requireRole(userId)
      const guild = this.db.prepare(`
        SELECT g.leader_id, (SELECT COUNT(*) FROM guild_members gm WHERE gm.guild_id = g.id) AS member_count
        FROM guilds g WHERE g.id = ?
      `).get(role.guild_id)
      if (guild.leader_id !== userId && Number(role.position) < 80) throw new StoreError('forbidden', 'Начать рейд может глава или заместитель.', 403)
      const project = this.ensureRaidProject(role.guild_id)
      if (project.status !== 'ready') throw new StoreError('raid-not-ready', 'Рейд ещё не подготовлен или уже начался.', 409)
      const participantCount = Number(this.db.prepare('SELECT COUNT(*) AS count FROM guild_raid_participants WHERE guild_id = ? AND boss_id = ?').get(role.guild_id, BOSS_ID).count)
      const minimum = Number(guild.member_count) <= 1 ? 1 : 2
      if (participantCount < minimum) throw new StoreError('raid-party-small', `Для начала нужно участников: ${minimum}. Сейчас: ${participantCount}.`, 409)
      const now = Date.now()
      this.consumeReservedResources(role.guild_id, userId, now)
      this.db.prepare(`
        UPDATE guild_raid_projects SET status = 'active', health = max_health, shield = max_shield,
          morale = max_morale, round = 1, intent = 'crush', attempts = attempts + 1,
          started_by = ?, started_at = ?, ended_at = NULL, cooldown_until = NULL, updated_at = ?
        WHERE guild_id = ? AND boss_id = ?
      `).run(userId, now, now, role.guild_id, BOSS_ID)
      this.addRaidLog(role.guild_id, userId, 'started', 'Знамя поднято. Чернопол выходит из курганного дыма.', 1, now)
      return { raid: this.raidSnapshot(userId), resources: this.resourceSnapshot(userId) }
    })
  }

  nextRaidIntent(guildId, round) {
    return RAID_INTENTS[stableNumber(`${guildId}:${BOSS_ID}:${round}`) % RAID_INTENTS.length]
  }

  raidActionValues(character, action, project, guild) {
    const level = Number(character.level)
    const warband = Number(guild.warband)
    const workshops = Number(guild.workshops)
    const roll = stableNumber(`${project.guild_id}:${character.user_id}:${project.round}:${action}`) % 4
    let damage = 0
    let support = 0
    let retaliationReduction = 0
    if (action === 'assault') {
      damage = 7 + level + warband + roll
    } else if (action === 'guard') {
      damage = 2 + Math.floor(level / 2)
      support = 10 + warband * 2
      retaliationReduction = 4
    } else {
      const profession = character.profession
      if (profession === 'blacksmith') {
        damage = 10 + level + workshops + roll
        retaliationReduction = 1
      } else if (profession === 'herbalist') {
        damage = 4 + level
        support = 12 + workshops
        retaliationReduction = 2
      } else if (profession === 'hunter') {
        damage = 12 + level + roll
      } else if (profession === 'scribe') {
        damage = 6 + level
        support = 7
        retaliationReduction = 4
      } else if (profession === 'carter') {
        damage = 6 + level
        support = 9 + warband
        retaliationReduction = 3
      } else {
        damage = 8 + level + roll
        support = roll >= 2 ? 4 : 0
        retaliationReduction = 1
      }
    }
    return { damage, support, retaliationReduction }
  }

  finishRaidVictory(guildId, project, now) {
    const participants = this.db.prepare('SELECT * FROM guild_raid_participants WHERE guild_id = ? AND boss_id = ?').all(guildId, BOSS_ID)
    const firstVictory = Number(project.victories) === 0
    for (const participant of participants) {
      this.db.prepare(`
        UPDATE player_characters SET coins = coins + 35, reputation = reputation + 6, updated_at = ?
        WHERE user_id = ?
      `).run(now, participant.user_id)
      this.players.addInventory(participant.user_id, 'ash-crown-scale', 'Чёрная чешуя князеглода', 1)
      this.db.prepare(`
        UPDATE guild_raid_participants SET reward_claimed = 1
        WHERE guild_id = ? AND boss_id = ? AND user_id = ?
      `).run(guildId, BOSS_ID, participant.user_id)
    }
    this.db.prepare(`
      UPDATE guild_raid_projects SET status = 'won', health = 0, victories = victories + 1,
        ended_at = ?, cooldown_until = ?, updated_at = ? WHERE guild_id = ? AND boss_id = ?
    `).run(now, now + RAID_COOLDOWN, now, guildId, BOSS_ID)
    this.db.prepare(`
      UPDATE guilds SET treasury_coins = treasury_coins + 120,
        tree_points = tree_points + ? WHERE id = ?
    `).run(firstVictory ? 1 : 0, guildId)
    this.db.prepare(`
      INSERT INTO guild_resource_stock(guild_id, item_id, item_name, quantity, reserved, updated_at)
      VALUES (?, 'ash-crown-fragment', 'Осколок пепельного венца', 3, 0, ?)
      ON CONFLICT(guild_id, item_id) DO UPDATE SET quantity = quantity + 3, updated_at = excluded.updated_at
    `).run(guildId, now)
    this.syncResourceTotal(guildId)
    this.gameStore.addGuildExperience(guildId, 140)
    this.addRaidLog(guildId, null, 'victory', 'Чернопол повержен. Каждый участник получает 35 монет, 6 репутации и Чёрную чешую князеглода.', Number(project.round), now)
  }

  finishRaidFailure(guildId, project, now) {
    this.db.prepare(`
      UPDATE guild_raid_projects SET status = 'failed', morale = 0, ended_at = ?, cooldown_until = ?, updated_at = ?
      WHERE guild_id = ? AND boss_id = ?
    `).run(now, now + FAILED_COOLDOWN, now, guildId, BOSS_ID)
    this.addRaidLog(guildId, null, 'failure', 'Знамя падает, дружина отступает. Новую подготовку можно начать через сутки.', Number(project.round), now)
  }

  actRaid(userId, input) {
    const action = String(input.action ?? '')
    if (!['assault', 'guard', 'profession'].includes(action)) throw new StoreError('raid-action-invalid', 'Неизвестное рейдовое действие.')
    return this.players.withReceipt(userId, input.requestId, `guild-raid:action:${BOSS_ID}:${action}`, () => {
      const role = this.requireRole(userId)
      const project = this.ensureRaidProject(role.guild_id)
      if (project.status !== 'active') throw new StoreError('raid-not-active', 'Сейчас нет активного гильдейского боя.', 409)
      const participant = this.db.prepare('SELECT * FROM guild_raid_participants WHERE guild_id = ? AND boss_id = ? AND user_id = ?').get(role.guild_id, BOSS_ID, userId)
      if (!participant) throw new StoreError('raid-not-participant', 'Ты не записан в эту дружину.', 403)
      if (Number(participant.actions) >= MAX_RAID_ACTIONS) throw new StoreError('raid-actions-spent', 'Личный предел действий в этом рейде исчерпан.', 409)
      const character = this.db.prepare('SELECT * FROM player_characters WHERE user_id = ?').get(userId)
      if (!character?.alive) throw new StoreError('character-dead', 'Погибший герой не может продолжать рейд.', 409)
      if (this.players.getActiveRun(userId)) throw new StoreError('expedition-active', 'Заверши личный поход перед рейдовым действием.', 409)
      const guild = this.db.prepare('SELECT warband, workshops FROM guilds WHERE id = ?').get(role.guild_id)
      const values = this.raidActionValues(character, action, project, guild)
      let shield = Number(project.shield)
      let health = Number(project.health)
      let morale = Math.min(Number(project.max_morale), Number(project.morale) + values.support)
      const shieldDamage = Math.min(shield, values.damage)
      shield -= shieldDamage
      health = Math.max(0, health - Math.max(0, values.damage - shieldDamage))
      const intentBase = project.intent === 'devour' ? 10 : project.intent === 'ash-breath' ? 8 : project.intent === 'summon' ? 7 : 6
      const retaliation = Math.max(1, intentBase - Number(guild.warband) - values.retaliationReduction)
      morale = Math.max(0, morale - retaliation)
      const nextRound = Number(project.round) + 1
      const nextIntent = this.nextRaidIntent(role.guild_id, nextRound)
      const now = Date.now()
      this.db.prepare(`
        UPDATE guild_raid_participants SET actions = actions + 1, damage = damage + ?, support = support + ?
        WHERE guild_id = ? AND boss_id = ? AND user_id = ?
      `).run(values.damage, values.support, role.guild_id, BOSS_ID, userId)
      this.db.prepare(`
        UPDATE guild_raid_projects SET health = ?, shield = ?, morale = ?, round = ?, intent = ?, updated_at = ?
        WHERE guild_id = ? AND boss_id = ?
      `).run(health, shield, morale, nextRound, nextIntent, now, role.guild_id, BOSS_ID)
      this.addRaidLog(
        role.guild_id,
        userId,
        action,
        `${character.name}: ${values.damage} урона, ${values.support} поддержки; ответ Чернопола отнимает ${retaliation} боевого духа.`,
        Number(project.round),
        now,
      )
      const fresh = this.db.prepare('SELECT * FROM guild_raid_projects WHERE guild_id = ? AND boss_id = ?').get(role.guild_id, BOSS_ID)
      if (health <= 0) this.finishRaidVictory(role.guild_id, fresh, now)
      else if (morale <= 0) this.finishRaidFailure(role.guild_id, fresh, now)
      return { character: this.players.getCharacter(userId), raid: this.raidSnapshot(userId) }
    })
  }
}
