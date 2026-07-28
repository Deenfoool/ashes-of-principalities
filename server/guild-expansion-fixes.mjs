import { guildResourceDefinitions } from './guild-expansion-store.mjs'
import { StoreError } from './store.mjs'

const BOSS_ID = 'ash-crowned-devourer'
const REQUIREMENTS = {
  'scrap-iron': 12,
  'black-reed': 10,
  'drowned-brass': 6,
  'salt-moss': 8,
  'brine-crystal': 4,
  'white-bell-heart': 1,
}

function hasReceipt(expansion, userId, requestId) {
  return Boolean(expansion.db.prepare(`
    SELECT 1 FROM player_action_receipts WHERE user_id = ? AND request_id = ?
  `).get(userId, String(requestId ?? '')))
}

export function installGuildExpansionFixes(expansion) {
  guildResourceDefinitions['ash-crown-fragment'] = 'Осколок пепельного венца'

  expansion.expansionSnapshot = (userId) => {
    const role = expansion.requireRole(userId)
    expansion.checkAutomaticTransfer(role.guild_id)
    const leadership = expansion.leadershipSnapshot(userId)
    return {
      resources: expansion.resourceSnapshot(userId),
      leadership,
      raid: expansion.raidSnapshot(userId),
    }
  }

  const originalJoinRaid = expansion.joinRaid.bind(expansion)
  expansion.joinRaid = (userId, input) => {
    if (hasReceipt(expansion, userId, input.requestId)) return originalJoinRaid(userId, input)
    const role = expansion.requireRole(userId)
    const existing = expansion.db.prepare(`
      SELECT 1 FROM guild_raid_participants
      WHERE guild_id = ? AND boss_id = ? AND user_id = ?
    `).get(role.guild_id, BOSS_ID, userId)
    if (existing) throw new StoreError('raid-already-joined', 'Герой уже записан в эту дружину.', 409)
    return originalJoinRaid(userId, input)
  }

  const originalStartRaid = expansion.startRaid.bind(expansion)
  expansion.startRaid = (userId, input) => {
    if (hasReceipt(expansion, userId, input.requestId)) return originalStartRaid(userId, input)
    const role = expansion.requireRole(userId)
    const guild = expansion.db.prepare(`
      SELECT (SELECT COUNT(*) FROM guild_members member WHERE member.guild_id = guild.id) AS member_count
      FROM guilds guild WHERE guild.id = ?
    `).get(role.guild_id)
    const participantCount = Number(expansion.db.prepare(`
      SELECT COUNT(*) AS count FROM guild_raid_participants participant
      JOIN guild_members member
        ON member.guild_id = participant.guild_id AND member.user_id = participant.user_id
      WHERE participant.guild_id = ? AND participant.boss_id = ?
    `).get(role.guild_id, BOSS_ID).count)
    const minimum = Number(guild?.member_count ?? 0) <= 1 ? 1 : 2
    if (participantCount < minimum) {
      throw new StoreError('raid-party-small', `Для начала нужно действующих участников: ${minimum}. Сейчас: ${participantCount}.`, 409)
    }
    return originalStartRaid(userId, input)
  }

  const originalFinishVictory = expansion.finishRaidVictory.bind(expansion)
  expansion.finishRaidVictory = (guildId, project, now) => {
    expansion.db.prepare(`
      DELETE FROM guild_raid_participants
      WHERE guild_id = ? AND boss_id = ? AND actions = 0
    `).run(guildId, BOSS_ID)
    originalFinishVictory(guildId, project, now)
    const actorId = project.started_by
      ?? expansion.db.prepare(`
        SELECT user_id FROM guild_raid_participants
        WHERE guild_id = ? AND boss_id = ? ORDER BY actions DESC, damage DESC LIMIT 1
      `).get(guildId, BOSS_ID)?.user_id
    if (actorId) expansion.addResourceLog(guildId, actorId, 'reward', 'ash-crown-fragment', 3, now)
  }

  expansion.cancelRaid = (userId, input) => expansion.players.withReceipt(
    userId,
    input.requestId,
    `guild-raid:cancel:${BOSS_ID}`,
    () => {
      const role = expansion.requireRole(userId)
      if (!role.can_use_treasury) throw new StoreError('forbidden', 'Отменить подготовку может участник с правом распоряжаться казной.', 403)
      const project = expansion.ensureRaidProject(role.guild_id)
      if (project.status !== 'ready') throw new StoreError('raid-not-cancellable', 'Отменить можно только подготовленный, но ещё не начатый рейд.', 409)
      const now = Date.now()
      for (const [itemId, quantity] of Object.entries(REQUIREMENTS)) {
        const result = expansion.db.prepare(`
          UPDATE guild_resource_stock SET reserved = reserved - ?, updated_at = ?
          WHERE guild_id = ? AND item_id = ? AND reserved >= ?
        `).run(quantity, now, role.guild_id, itemId, quantity)
        if (Number(result.changes) !== 1) throw new StoreError('raid-reservation-lost', 'Резерв подготовки повреждён. Отмена остановлена.', 409)
        expansion.addResourceLog(role.guild_id, userId, 'release', itemId, quantity, now)
      }
      const participants = expansion.db.prepare(`
        SELECT user_id FROM guild_raid_participants WHERE guild_id = ? AND boss_id = ?
      `).all(role.guild_id, BOSS_ID)
      for (const participant of participants) {
        expansion.db.prepare(`
          UPDATE player_characters SET stamina = MIN(max_stamina, stamina + 3), updated_at = ?
          WHERE user_id = ?
        `).run(now, participant.user_id)
      }
      expansion.db.prepare('DELETE FROM guild_raid_participants WHERE guild_id = ? AND boss_id = ?').run(role.guild_id, BOSS_ID)
      expansion.db.prepare(`
        UPDATE guild_raid_projects SET status = 'preparing', prepared_by = NULL, prepared_at = NULL,
          started_by = NULL, started_at = NULL, round = 1, intent = 'crush', updated_at = ?
        WHERE guild_id = ? AND boss_id = ?
      `).run(now, role.guild_id, BOSS_ID)
      expansion.addRaidLog(role.guild_id, userId, 'cancelled', 'Подготовка отменена: резерв снят, силы записавшихся героев возвращены.', 1, now)
      return {
        character: expansion.players.getCharacter(userId),
        raid: expansion.raidSnapshot(userId),
        resources: expansion.resourceSnapshot(userId),
      }
    },
  )
}
