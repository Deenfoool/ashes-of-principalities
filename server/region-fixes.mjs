import { StoreError } from './store.mjs'

export function installRegionFixes(db, regions, players = regions.players) {
  if (regions.__compatibilityFixesInstalled) return
  regions.__compatibilityFixesInstalled = true

  regions.unlockRegions = (userId) => {
    const character = db.prepare('SELECT level FROM player_characters WHERE user_id = ?').get(userId)
    if (!character) return
    const story = db.prepare('SELECT chapter_complete FROM player_story_state WHERE user_id = ?').get(userId)
    if (!Number(story?.chapter_complete)) return

    db.prepare('INSERT OR IGNORE INTO player_region_progress(user_id, region_id, unlocked_at) VALUES (?, ?, ?)')
      .run(userId, 'ash-road', Date.now())
    const ashVictories = Number(db.prepare(`
      SELECT victories FROM player_region_progress WHERE user_id = ? AND region_id = 'ash-road'
    `).get(userId)?.victories ?? 0)
    if (Number(character.level) >= 3 && ashVictories >= 3) {
      db.prepare('INSERT OR IGNORE INTO player_region_progress(user_id, region_id, unlocked_at) VALUES (?, ?, ?)')
        .run(userId, 'salt-marsh', Date.now())
    }
  }

  const originalRegionSnapshot = regions.regionSnapshot.bind(regions)
  regions.regionSnapshot = (userId) => {
    const snapshot = originalRegionSnapshot(userId)
    const character = db.prepare('SELECT level FROM player_characters WHERE user_id = ?').get(userId)
    const ashVictories = Number(db.prepare(`
      SELECT victories FROM player_region_progress WHERE user_id = ? AND region_id = 'ash-road'
    `).get(userId)?.victories ?? 0)
    return snapshot.map((region) => region.id === 'salt-marsh' && !region.unlocked
      ? { ...region, requirement: `Нужны 3-й уровень и 3 победы на Пепельном тракте. Сейчас: уровень ${Number(character?.level ?? 0)}, побед ${ashVictories}.` }
      : region)
  }

  const originalPlayerAct = players.actExpedition.bind(players)
  players.actExpedition = (userId, input) => {
    const requestId = String(input.requestId ?? '').trim()
    const expectedAction = `expedition:${String(input.action ?? '')}`
    const existing = requestId
      ? db.prepare('SELECT action, result_json FROM player_action_receipts WHERE user_id = ? AND request_id = ?').get(userId, requestId)
      : null
    if (existing?.action === expectedAction) return JSON.parse(existing.result_json)
    return originalPlayerAct(userId, input)
  }

  const originalActOffer = regions.actOffer.bind(regions)
  regions.actOffer = (userId, input) => {
    const requestId = String(input.requestId ?? '').trim()
    const existing = requestId
      ? db.prepare('SELECT action FROM player_action_receipts WHERE user_id = ? AND request_id = ?').get(userId, requestId)
      : null
    if (!existing && String(input.action ?? '') === 'profession') {
      const equipped = db.prepare(`
        SELECT durability FROM unique_items
        WHERE owner_user_id = ? AND equipped = 1
        LIMIT 1
      `).get(userId)
      if (equipped && Number(equipped.durability) <= 0) {
        throw new StoreError('tool-broken', 'Ремесленный инструмент сломан. Сначала отремонтируй его.', 409)
      }
    }
    return originalActOffer(userId, input)
  }
}
