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

export function installGuildExpansionFixes(expansion) {
  guildResourceDefinitions['ash-crown-fragment'] = 'Осколок пепельного венца'

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
