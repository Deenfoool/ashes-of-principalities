import { randomBytes, randomUUID, scryptSync, timingSafeEqual, createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const SESSION_LIFETIME = 30 * 24 * 60 * 60 * 1000
const GUILD_MEMBER_LIMIT = 20
const GUILD_BRANCHES = new Set(['warband', 'treasury', 'workshops', 'foraging', 'chronicle'])

export class StoreError extends Error {
  constructor(code, message, status = 400) {
    super(message)
    this.name = 'StoreError'
    this.code = code
    this.status = status
  }
}

const normalizeUsername = (value) => String(value ?? '').trim().toLocaleLowerCase('ru-RU')
const cleanDisplayName = (value) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, 24)
const cleanGuildName = (value) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, 28)
const cleanGuildTag = (value) => String(value ?? '').toUpperCase().replace(/[^А-ЯЁA-Z0-9]/g, '').slice(0, 5)
const tokenHash = (token) => createHash('sha256').update(token).digest('hex')
const seasonKey = (date = new Date()) => `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`
const weekKey = (date = new Date()) => {
  const utc = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()))
  const day = utc.getUTCDay() || 7
  utc.setUTCDate(utc.getUTCDate() + 4 - day)
  const yearStart = new Date(Date.UTC(utc.getUTCFullYear(), 0, 1))
  const week = Math.ceil((((utc.getTime() - yearStart.getTime()) / 86400000) + 1) / 7)
  return `${utc.getUTCFullYear()}-W${String(week).padStart(2, '0')}`
}
const defaultTasks = [
  { id: 'contracts', title: 'Завершить 3 контракта', target: 3, reward: 50 },
  { id: 'victories', title: 'Победить 8 опасных противников', target: 8, reward: 45 },
  { id: 'donations', title: 'Внести 60 монет в казну', target: 60, reward: 55 },
]

function validateCredentials(username, password, displayName) {
  const normalized = normalizeUsername(username)
  if (!/^[a-zа-яё0-9_]{3,20}$/iu.test(normalized)) {
    throw new StoreError('invalid-username', 'Логин должен содержать от 3 до 20 букв, цифр или знаков подчёркивания.')
  }
  if (String(password ?? '').length < 8 || String(password ?? '').length > 128) {
    throw new StoreError('invalid-password', 'Пароль должен содержать от 8 до 128 символов.')
  }
  const display = cleanDisplayName(displayName)
  if (display.length < 2) throw new StoreError('invalid-display-name', 'Имя должно содержать хотя бы 2 символа.')
  return { username: normalized, password: String(password), displayName: display }
}

function hashPassword(password, salt = randomBytes(16).toString('hex')) {
  return { salt, hash: scryptSync(password, salt, 64).toString('hex') }
}

function publicUser(row) {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    createdAt: Number(row.created_at),
  }
}

function publicGuild(row) {
  if (!row) return null
  return {
    id: row.id,
    name: row.name,
    tag: row.tag,
    level: Number(row.level),
    experience: Number(row.experience),
    treePoints: Number(row.tree_points),
    treasuryCoins: Number(row.treasury_coins),
    treasuryResources: Number(row.treasury_resources),
    joinedAt: Number(row.joined_at),
    memberCount: Number(row.member_count),
    role: {
      id: row.role_id,
      name: row.role_name,
      permissions: {
        invite: Boolean(row.can_invite),
        kick: Boolean(row.can_kick),
        treasury: Boolean(row.can_use_treasury),
        tree: Boolean(row.can_manage_tree),
        roles: Boolean(row.can_manage_roles),
      },
    },
    branches: {
      warband: Number(row.warband),
      treasury: Number(row.treasury),
      workshops: Number(row.workshops),
      foraging: Number(row.foraging),
      chronicle: Number(row.chronicle),
    },
    seasonKey: row.season_key,
    lastTreeResetSeason: row.last_tree_reset_season,
  }
}

export class GameStore {
  constructor(path = ':memory:') {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.db = new DatabaseSync(path, { timeout: 5000 })
    this.db.exec('PRAGMA foreign_keys = ON;')
    if (path !== ':memory:') this.db.exec('PRAGMA journal_mode = WAL;')
    this.createSchema()
    this.cleanupSessions()
  }

  createSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL UNIQUE COLLATE NOCASE,
        display_name TEXT NOT NULL,
        password_salt TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        created_at INTEGER NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS guilds (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE COLLATE NOCASE,
        tag TEXT NOT NULL UNIQUE COLLATE NOCASE,
        leader_id TEXT NOT NULL REFERENCES users(id),
        level INTEGER NOT NULL DEFAULT 1,
        experience INTEGER NOT NULL DEFAULT 0,
        tree_points INTEGER NOT NULL DEFAULT 1,
        treasury_coins INTEGER NOT NULL DEFAULT 0,
        treasury_resources INTEGER NOT NULL DEFAULT 0,
        warband INTEGER NOT NULL DEFAULT 0,
        treasury INTEGER NOT NULL DEFAULT 0,
        workshops INTEGER NOT NULL DEFAULT 0,
        foraging INTEGER NOT NULL DEFAULT 0,
        chronicle INTEGER NOT NULL DEFAULT 0,
        season_key TEXT NOT NULL,
        last_tree_reset_season TEXT,
        created_at INTEGER NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS guild_roles (
        id TEXT PRIMARY KEY,
        guild_id TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        position INTEGER NOT NULL,
        can_invite INTEGER NOT NULL DEFAULT 0,
        can_kick INTEGER NOT NULL DEFAULT 0,
        can_use_treasury INTEGER NOT NULL DEFAULT 0,
        can_manage_tree INTEGER NOT NULL DEFAULT 0,
        can_manage_roles INTEGER NOT NULL DEFAULT 0,
        UNIQUE(guild_id, name COLLATE NOCASE)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS guild_members (
        guild_id TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
        role_id TEXT NOT NULL REFERENCES guild_roles(id),
        joined_at INTEGER NOT NULL,
        PRIMARY KEY(guild_id, user_id)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS guild_invites (
        id TEXT PRIMARY KEY,
        guild_id TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
        inviter_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        invitee_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        status TEXT NOT NULL CHECK(status IN ('pending', 'accepted', 'declined', 'expired')),
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS guild_tasks (
        guild_id TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
        week_key TEXT NOT NULL,
        task_id TEXT NOT NULL,
        title TEXT NOT NULL,
        current INTEGER NOT NULL DEFAULT 0,
        target INTEGER NOT NULL,
        reward INTEGER NOT NULL,
        completed INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(guild_id, week_key, task_id)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS treasury_log (
        id TEXT PRIMARY KEY,
        guild_id TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        operation TEXT NOT NULL,
        amount INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      ) STRICT;

      CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
      CREATE INDEX IF NOT EXISTS idx_invites_user_status ON guild_invites(invitee_id, status);
      CREATE INDEX IF NOT EXISTS idx_treasury_guild_time ON treasury_log(guild_id, created_at DESC);
    `)
  }

  transaction(callback) {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = callback()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  cleanupSessions(now = Date.now()) {
    this.db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now)
    this.db.prepare("UPDATE guild_invites SET status = 'expired' WHERE status = 'pending' AND expires_at <= ?").run(now)
  }

  createSession(userId) {
    const token = randomBytes(32).toString('base64url')
    const now = Date.now()
    this.db.prepare('INSERT INTO sessions(token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)')
      .run(tokenHash(token), userId, now + SESSION_LIFETIME, now)
    return token
  }

  register(input) {
    const credentials = validateCredentials(input.username, input.password, input.displayName)
    const existing = this.db.prepare('SELECT id FROM users WHERE username = ? COLLATE NOCASE').get(credentials.username)
    if (existing) throw new StoreError('username-taken', 'Такой логин уже занят.', 409)
    const id = randomUUID()
    const createdAt = Date.now()
    const password = hashPassword(credentials.password)
    this.db.prepare('INSERT INTO users(id, username, display_name, password_salt, password_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, credentials.username, credentials.displayName, password.salt, password.hash, createdAt)
    return { token: this.createSession(id), user: { id, username: credentials.username, displayName: credentials.displayName, createdAt } }
  }

  login(input) {
    const username = normalizeUsername(input.username)
    const row = this.db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE').get(username)
    if (!row) throw new StoreError('invalid-login', 'Неверный логин или пароль.', 401)
    const candidate = hashPassword(String(input.password ?? ''), row.password_salt).hash
    const expectedBuffer = Buffer.from(row.password_hash, 'hex')
    const candidateBuffer = Buffer.from(candidate, 'hex')
    if (candidateBuffer.length !== expectedBuffer.length || !timingSafeEqual(candidateBuffer, expectedBuffer)) {
      throw new StoreError('invalid-login', 'Неверный логин или пароль.', 401)
    }
    return { token: this.createSession(row.id), user: publicUser(row) }
  }

  authenticate(token) {
    if (!token) return null
    const row = this.db.prepare(`
      SELECT u.* FROM sessions s
      JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ? AND s.expires_at > ?
    `).get(tokenHash(token), Date.now())
    return row ? publicUser(row) : null
  }

  logout(token) {
    if (token) this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash(token))
  }

  getGuildForUser(userId) {
    const row = this.db.prepare(`
      SELECT g.*, gm.joined_at, gr.id AS role_id, gr.name AS role_name,
        gr.can_invite, gr.can_kick, gr.can_use_treasury, gr.can_manage_tree, gr.can_manage_roles,
        (SELECT COUNT(*) FROM guild_members count_members WHERE count_members.guild_id = g.id) AS member_count
      FROM guild_members gm
      JOIN guilds g ON g.id = gm.guild_id
      JOIN guild_roles gr ON gr.id = gm.role_id
      WHERE gm.user_id = ?
    `).get(userId)
    const guild = publicGuild(row)
    if (guild) guild.tasks = this.getGuildTasks(guild.id)
    return guild
  }

  getRoleForUser(userId) {
    return this.db.prepare(`
      SELECT g.id AS guild_id, gr.*
      FROM guild_members gm
      JOIN guilds g ON g.id = gm.guild_id
      JOIN guild_roles gr ON gr.id = gm.role_id
      WHERE gm.user_id = ?
    `).get(userId)
  }

  ensureGuildTasks(guildId) {
    const currentWeek = weekKey()
    const insert = this.db.prepare(`
      INSERT OR IGNORE INTO guild_tasks(guild_id, week_key, task_id, title, current, target, reward, completed)
      VALUES (?, ?, ?, ?, 0, ?, ?, 0)
    `)
    for (const task of defaultTasks) insert.run(guildId, currentWeek, task.id, task.title, task.target, task.reward)
    return currentWeek
  }

  getGuildTasks(guildId) {
    const currentWeek = this.ensureGuildTasks(guildId)
    return this.db.prepare(`
      SELECT task_id AS id, title, current, target, reward, completed
      FROM guild_tasks WHERE guild_id = ? AND week_key = ? ORDER BY task_id
    `).all(guildId, currentWeek).map((task) => ({
      ...task,
      current: Number(task.current),
      target: Number(task.target),
      reward: Number(task.reward),
      completed: Boolean(task.completed),
    }))
  }

  addGuildExperience(guildId, amount) {
    const guild = this.db.prepare('SELECT level, experience, tree_points FROM guilds WHERE id = ?').get(guildId)
    let level = Number(guild.level)
    let experience = Number(guild.experience) + Math.max(0, Math.floor(amount))
    let treePoints = Number(guild.tree_points)
    let threshold = 80 + level * 40
    while (experience >= threshold) {
      experience -= threshold
      level += 1
      treePoints += 1
      threshold = 80 + level * 40
    }
    this.db.prepare('UPDATE guilds SET level = ?, experience = ?, tree_points = ? WHERE id = ?')
      .run(level, experience, treePoints, guildId)
  }

  progressTaskByGuild(guildId, taskId, amount) {
    const currentWeek = this.ensureGuildTasks(guildId)
    const task = this.db.prepare(`
      SELECT * FROM guild_tasks WHERE guild_id = ? AND week_key = ? AND task_id = ?
    `).get(guildId, currentWeek, taskId)
    if (!task || task.completed) return
    const current = Math.min(Number(task.target), Number(task.current) + Math.max(0, Math.floor(amount)))
    const completed = current >= Number(task.target)
    this.db.prepare(`
      UPDATE guild_tasks SET current = ?, completed = ? WHERE guild_id = ? AND week_key = ? AND task_id = ?
    `).run(current, completed ? 1 : 0, guildId, currentWeek, taskId)
    if (completed) this.addGuildExperience(guildId, Number(task.reward))
  }

  progressTask(userId, taskId, amount) {
    if (!['contracts', 'victories'].includes(taskId)) throw new StoreError('invalid-task', 'Неизвестное задание гильдии.')
    const cleanAmount = Math.min(10, Math.max(1, Math.floor(Number(amount) || 1)))
    const role = this.getRoleForUser(userId)
    if (!role) throw new StoreError('not-in-guild', 'Ты не состоишь в гильдии.', 404)
    this.transaction(() => this.progressTaskByGuild(role.guild_id, taskId, cleanAmount))
    return this.getGuildForUser(userId)
  }

  getInvites(userId) {
    this.cleanupSessions()
    return this.db.prepare(`
      SELECT i.id, i.guild_id AS guildId, g.name AS guildName, g.tag AS guildTag,
        u.display_name AS inviterName, i.created_at AS createdAt, i.expires_at AS expiresAt
      FROM guild_invites i
      JOIN guilds g ON g.id = i.guild_id
      JOIN users u ON u.id = i.inviter_id
      WHERE i.invitee_id = ? AND i.status = 'pending'
      ORDER BY i.created_at DESC
    `).all(userId).map((invite) => ({ ...invite, createdAt: Number(invite.createdAt), expiresAt: Number(invite.expiresAt) }))
  }

  getSnapshot(userId) {
    const row = this.db.prepare('SELECT * FROM users WHERE id = ?').get(userId)
    if (!row) throw new StoreError('user-not-found', 'Аккаунт не найден.', 404)
    return { user: publicUser(row), guild: this.getGuildForUser(userId), invites: this.getInvites(userId) }
  }

  createGuild(userId, input) {
    const name = cleanGuildName(input.name)
    const tag = cleanGuildTag(input.tag)
    if (name.length < 3) throw new StoreError('invalid-guild-name', 'Название гильдии должно содержать хотя бы 3 символа.')
    if (tag.length < 2) throw new StoreError('invalid-guild-tag', 'Тег гильдии должен содержать от 2 до 5 букв или цифр.')
    if (this.getGuildForUser(userId)) throw new StoreError('already-in-guild', 'Ты уже состоишь в гильдии.', 409)

    return this.transaction(() => {
      if (this.db.prepare('SELECT id FROM guilds WHERE name = ? COLLATE NOCASE OR tag = ? COLLATE NOCASE').get(name, tag)) {
        throw new StoreError('guild-name-taken', 'Название или тег уже заняты.', 409)
      }
      const now = Date.now()
      const guildId = randomUUID()
      const leaderRole = randomUUID()
      const deputyRole = randomUUID()
      const memberRole = randomUUID()
      this.db.prepare(`
        INSERT INTO guilds(id, name, tag, leader_id, season_key, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(guildId, name, tag, userId, seasonKey(), now)
      const insertRole = this.db.prepare(`
        INSERT INTO guild_roles(id, guild_id, name, position, can_invite, can_kick, can_use_treasury, can_manage_tree, can_manage_roles)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      insertRole.run(leaderRole, guildId, 'Глава', 100, 1, 1, 1, 1, 1)
      insertRole.run(deputyRole, guildId, 'Заместитель', 80, 1, 1, 1, 1, 0)
      insertRole.run(memberRole, guildId, 'Участник', 10, 0, 0, 0, 0, 0)
      this.db.prepare('INSERT INTO guild_members(guild_id, user_id, role_id, joined_at) VALUES (?, ?, ?, ?)')
        .run(guildId, userId, leaderRole, now)
      this.ensureGuildTasks(guildId)
      return this.getGuildForUser(userId)
    })
  }

  inviteToGuild(userId, username) {
    const role = this.getRoleForUser(userId)
    if (!role?.can_invite) throw new StoreError('forbidden', 'У твоей роли нет права приглашать игроков.', 403)
    const invitee = this.db.prepare('SELECT id, display_name FROM users WHERE username = ? COLLATE NOCASE').get(normalizeUsername(username))
    if (!invitee) throw new StoreError('invitee-not-found', 'Игрок с таким логином не найден.', 404)
    if (invitee.id === userId) throw new StoreError('cannot-invite-self', 'Нельзя пригласить самого себя.')
    if (this.getGuildForUser(invitee.id)) throw new StoreError('invitee-in-guild', 'Этот игрок уже состоит в гильдии.', 409)
    const count = Number(this.db.prepare('SELECT COUNT(*) AS count FROM guild_members WHERE guild_id = ?').get(role.guild_id).count)
    if (count >= GUILD_MEMBER_LIMIT) throw new StoreError('guild-full', 'В гильдии уже 20 участников.', 409)
    const existing = this.db.prepare("SELECT id FROM guild_invites WHERE guild_id = ? AND invitee_id = ? AND status = 'pending' AND expires_at > ?")
      .get(role.guild_id, invitee.id, Date.now())
    if (existing) throw new StoreError('invite-exists', 'Приглашение этому игроку уже отправлено.', 409)
    const id = randomUUID()
    const now = Date.now()
    this.db.prepare(`
      INSERT INTO guild_invites(id, guild_id, inviter_id, invitee_id, status, created_at, expires_at)
      VALUES (?, ?, ?, ?, 'pending', ?, ?)
    `).run(id, role.guild_id, userId, invitee.id, now, now + 7 * 24 * 60 * 60 * 1000)
    return { id, inviteeName: invitee.display_name }
  }

  acceptInvite(userId, inviteId) {
    if (this.getGuildForUser(userId)) throw new StoreError('already-in-guild', 'Сначала покинь текущую гильдию.', 409)
    return this.transaction(() => {
      const invite = this.db.prepare(`
        SELECT i.*, (SELECT COUNT(*) FROM guild_members gm WHERE gm.guild_id = i.guild_id) AS member_count
        FROM guild_invites i WHERE i.id = ? AND i.invitee_id = ? AND i.status = 'pending'
      `).get(inviteId, userId)
      if (!invite || Number(invite.expires_at) <= Date.now()) throw new StoreError('invite-invalid', 'Приглашение не найдено или истекло.', 404)
      if (Number(invite.member_count) >= GUILD_MEMBER_LIMIT) throw new StoreError('guild-full', 'В гильдии уже 20 участников.', 409)
      const role = this.db.prepare("SELECT id FROM guild_roles WHERE guild_id = ? AND name = 'Участник'").get(invite.guild_id)
      this.db.prepare('INSERT INTO guild_members(guild_id, user_id, role_id, joined_at) VALUES (?, ?, ?, ?)')
        .run(invite.guild_id, userId, role.id, Date.now())
      this.db.prepare("UPDATE guild_invites SET status = 'accepted' WHERE id = ?").run(inviteId)
      this.db.prepare("UPDATE guild_invites SET status = 'declined' WHERE invitee_id = ? AND status = 'pending' AND id <> ?").run(userId, inviteId)
      return this.getGuildForUser(userId)
    })
  }

  depositCoins(userId, amount) {
    const cleanAmount = Math.floor(Number(amount))
    if (!Number.isFinite(cleanAmount) || cleanAmount <= 0 || cleanAmount > 1_000_000) {
      throw new StoreError('invalid-amount', 'Сумма взноса должна быть положительным целым числом.')
    }
    const role = this.getRoleForUser(userId)
    if (!role) throw new StoreError('not-in-guild', 'Ты не состоишь в гильдии.', 404)
    this.transaction(() => {
      this.db.prepare('UPDATE guilds SET treasury_coins = treasury_coins + ? WHERE id = ?').run(cleanAmount, role.guild_id)
      this.db.prepare('INSERT INTO treasury_log(id, guild_id, user_id, operation, amount, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(randomUUID(), role.guild_id, userId, 'deposit-coins', cleanAmount, Date.now())
      this.progressTaskByGuild(role.guild_id, 'donations', cleanAmount)
    })
    return this.getGuildForUser(userId)
  }

  getTreasuryLog(userId, limit = 30) {
    const role = this.getRoleForUser(userId)
    if (!role) throw new StoreError('not-in-guild', 'Ты не состоишь в гильдии.', 404)
    return this.db.prepare(`
      SELECT t.id, t.operation, t.amount, t.created_at AS createdAt, u.display_name AS playerName
      FROM treasury_log t JOIN users u ON u.id = t.user_id
      WHERE t.guild_id = ? ORDER BY t.created_at DESC LIMIT ?
    `).all(role.guild_id, Math.min(100, Math.max(1, Number(limit) || 30)))
      .map((entry) => ({ ...entry, amount: Number(entry.amount), createdAt: Number(entry.createdAt) }))
  }

  upgradeBranch(userId, branch) {
    if (!GUILD_BRANCHES.has(branch)) throw new StoreError('invalid-branch', 'Неизвестная ветка дерева.')
    const role = this.getRoleForUser(userId)
    if (!role?.can_manage_tree) throw new StoreError('forbidden', 'У твоей роли нет права изменять дерево.', 403)
    return this.transaction(() => {
      const guild = this.db.prepare(`SELECT tree_points, ${branch} AS branch_rank FROM guilds WHERE id = ?`).get(role.guild_id)
      if (Number(guild.tree_points) < 1) throw new StoreError('no-tree-points', 'Нет свободных очков дерева.', 409)
      if (Number(guild.branch_rank) >= 5) throw new StoreError('branch-maxed', 'Ветка уже достигла максимального ранга.', 409)
      this.db.prepare(`UPDATE guilds SET ${branch} = ${branch} + 1, tree_points = tree_points - 1 WHERE id = ?`).run(role.guild_id)
      return this.getGuildForUser(userId)
    })
  }

  resetTree(userId) {
    const role = this.getRoleForUser(userId)
    if (!role?.can_manage_tree) throw new StoreError('forbidden', 'У твоей роли нет права изменять дерево.', 403)
    return this.transaction(() => {
      const guild = this.db.prepare('SELECT * FROM guilds WHERE id = ?').get(role.guild_id)
      const currentSeason = seasonKey()
      if (guild.last_tree_reset_season === currentSeason) throw new StoreError('reset-used', 'Бесплатный сброс в этом сезоне уже использован.', 409)
      const spent = ['warband', 'treasury', 'workshops', 'foraging', 'chronicle'].reduce((sum, key) => sum + Number(guild[key]), 0)
      this.db.prepare(`
        UPDATE guilds SET tree_points = tree_points + ?, warband = 0, treasury = 0, workshops = 0,
          foraging = 0, chronicle = 0, season_key = ?, last_tree_reset_season = ? WHERE id = ?
      `).run(spent, currentSeason, currentSeason, role.guild_id)
      return this.getGuildForUser(userId)
    })
  }

  createRole(userId, input) {
    const actor = this.getRoleForUser(userId)
    if (!actor?.can_manage_roles) throw new StoreError('forbidden', 'Только глава может создавать роли.', 403)
    const name = String(input.name ?? '').replace(/\s+/g, ' ').trim().slice(0, 20)
    if (name.length < 2) throw new StoreError('invalid-role-name', 'Название роли слишком короткое.')
    const count = Number(this.db.prepare('SELECT COUNT(*) AS count FROM guild_roles WHERE guild_id = ?').get(actor.guild_id).count)
    if (count >= 10) throw new StoreError('role-limit', 'В гильдии может быть не более 10 ролей.', 409)
    const permissions = input.permissions ?? {}
    this.db.prepare(`
      INSERT INTO guild_roles(id, guild_id, name, position, can_invite, can_kick, can_use_treasury, can_manage_tree, can_manage_roles)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)
    `).run(
      randomUUID(), actor.guild_id, name, 20,
      permissions.invite ? 1 : 0,
      permissions.kick ? 1 : 0,
      permissions.treasury ? 1 : 0,
      permissions.tree ? 1 : 0,
    )
    return this.getRoles(userId)
  }

  getMembers(userId) {
    const actor = this.getRoleForUser(userId)
    if (!actor) throw new StoreError('not-in-guild', 'Ты не состоишь в гильдии.', 404)
    return this.db.prepare(`
      SELECT u.id, u.username, u.display_name AS displayName, gm.joined_at AS joinedAt,
        gr.id AS roleId, gr.name AS roleName, gr.position AS rolePosition,
        CASE WHEN g.leader_id = u.id THEN 1 ELSE 0 END AS isLeader
      FROM guild_members gm
      JOIN users u ON u.id = gm.user_id
      JOIN guild_roles gr ON gr.id = gm.role_id
      JOIN guilds g ON g.id = gm.guild_id
      WHERE gm.guild_id = ? ORDER BY gr.position DESC, gm.joined_at ASC
    `).all(actor.guild_id).map((member) => ({
      ...member,
      joinedAt: Number(member.joinedAt),
      rolePosition: Number(member.rolePosition),
      isLeader: Boolean(member.isLeader),
    }))
  }

  assignMemberRole(userId, targetUserId, roleId) {
    const actor = this.getRoleForUser(userId)
    if (!actor?.can_manage_roles) throw new StoreError('forbidden', 'Только глава может назначать роли.', 403)
    const target = this.db.prepare(`
      SELECT gm.user_id, gm.role_id, g.leader_id FROM guild_members gm
      JOIN guilds g ON g.id = gm.guild_id WHERE gm.guild_id = ? AND gm.user_id = ?
    `).get(actor.guild_id, targetUserId)
    if (!target) throw new StoreError('member-not-found', 'Участник не найден.', 404)
    if (target.leader_id === targetUserId) throw new StoreError('leader-protected', 'Роль главы нельзя изменить.', 409)
    const role = this.db.prepare('SELECT id, position FROM guild_roles WHERE id = ? AND guild_id = ?').get(roleId, actor.guild_id)
    if (!role || Number(role.position) >= 100) throw new StoreError('role-invalid', 'Эту роль нельзя назначить.', 409)
    this.db.prepare('UPDATE guild_members SET role_id = ? WHERE guild_id = ? AND user_id = ?').run(roleId, actor.guild_id, targetUserId)
    return this.getMembers(userId)
  }

  kickMember(userId, targetUserId) {
    const actor = this.getRoleForUser(userId)
    if (!actor?.can_kick) throw new StoreError('forbidden', 'У твоей роли нет права исключать участников.', 403)
    const target = this.db.prepare(`
      SELECT gm.user_id, gr.position, g.leader_id FROM guild_members gm
      JOIN guild_roles gr ON gr.id = gm.role_id
      JOIN guilds g ON g.id = gm.guild_id
      WHERE gm.guild_id = ? AND gm.user_id = ?
    `).get(actor.guild_id, targetUserId)
    if (!target) throw new StoreError('member-not-found', 'Участник не найден.', 404)
    if (target.leader_id === targetUserId) throw new StoreError('leader-protected', 'Главу нельзя исключить из собственной гильдии.', 409)
    if (Number(actor.position) <= Number(target.position)) throw new StoreError('rank-protected', 'Нельзя исключить участника с равной или более высокой ролью.', 403)
    this.db.prepare('DELETE FROM guild_members WHERE guild_id = ? AND user_id = ?').run(actor.guild_id, targetUserId)
    return this.getMembers(userId)
  }

  getRoles(userId) {
    const actor = this.getRoleForUser(userId)
    if (!actor) throw new StoreError('not-in-guild', 'Ты не состоишь в гильдии.', 404)
    return this.db.prepare(`
      SELECT id, name, position, can_invite AS canInvite, can_kick AS canKick,
        can_use_treasury AS canUseTreasury, can_manage_tree AS canManageTree,
        can_manage_roles AS canManageRoles
      FROM guild_roles WHERE guild_id = ? ORDER BY position DESC, name
    `).all(actor.guild_id).map((role) => ({
      ...role,
      position: Number(role.position),
      canInvite: Boolean(role.canInvite),
      canKick: Boolean(role.canKick),
      canUseTreasury: Boolean(role.canUseTreasury),
      canManageTree: Boolean(role.canManageTree),
      canManageRoles: Boolean(role.canManageRoles),
    }))
  }

  close() {
    this.db.close()
  }
}
