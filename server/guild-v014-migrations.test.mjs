import test from 'node:test'
import assert from 'node:assert/strict'
import { installGuildV014Migrations } from './guild-v014-migrations.mjs'
import { GameStore } from './store.mjs'

function createExistingGuild(game) {
  const account = game.register({
    username: 'guild_migration_v014',
    password: '12345678',
    displayName: 'Старый глава',
  })
  const guild = game.createGuild(account.user.id, { name: 'Старая артель', tag: 'СА' })
  return { user: account.user, guild }
}

test('migration gives existing members a fresh activity grace period and is replay-safe', () => {
  const game = new GameStore(':memory:')
  try {
    const existing = createExistingGuild(game)
    const first = installGuildV014Migrations(game.db)
    const second = installGuildV014Migrations(game.db)
    const member = game.db.prepare('SELECT last_active_at FROM guild_members WHERE guild_id = ? AND user_id = ?').get(existing.guild.id, existing.user.id)
    const migrationCount = game.db.prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE id = '017_guild_resources_leadership_and_raids'").get()
    assert.equal(first, true)
    assert.equal(second, false)
    assert.ok(Number(member.last_active_at) > 0)
    assert.equal(Number(migrationCount.count), 1)
  } finally { game.close() }
})

test('exhausted participant actions close an otherwise active raid', () => {
  const game = new GameStore(':memory:')
  try {
    const existing = createExistingGuild(game)
    installGuildV014Migrations(game.db)
    const now = Date.now()
    game.db.prepare(`
      INSERT INTO guild_raid_projects(
        guild_id, boss_id, status, health, max_health, shield, max_shield,
        morale, max_morale, round, intent, requirements_json, updated_at
      ) VALUES (?, 'ash-crowned-devourer', 'active', 80, 120, 0, 40, 60, 140, 1, 'crush', '{}', ?)
    `).run(existing.guild.id, now)
    game.db.prepare(`
      INSERT INTO guild_raid_participants(guild_id, boss_id, user_id, joined_at, actions)
      VALUES (?, 'ash-crowned-devourer', ?, ?, 12)
    `).run(existing.guild.id, existing.user.id, now)
    game.db.prepare(`
      UPDATE guild_raid_projects SET round = 2
      WHERE guild_id = ? AND boss_id = 'ash-crowned-devourer'
    `).run(existing.guild.id)

    const project = game.db.prepare(`
      SELECT status, morale, cooldown_until FROM guild_raid_projects
      WHERE guild_id = ? AND boss_id = 'ash-crowned-devourer'
    `).get(existing.guild.id)
    const log = game.db.prepare(`
      SELECT event_type FROM guild_raid_log
      WHERE guild_id = ? AND boss_id = 'ash-crowned-devourer'
    `).get(existing.guild.id)
    assert.equal(project.status, 'failed')
    assert.equal(Number(project.morale), 0)
    assert.ok(Number(project.cooldown_until) > now)
    assert.equal(log.event_type, 'failure')
  } finally { game.close() }
})
