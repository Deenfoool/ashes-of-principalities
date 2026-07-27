import { StoreError } from './store.mjs'

export function installRegionFixes(db, regions, players = regions.players) {
  if (regions.__compatibilityFixesInstalled) return
  regions.__compatibilityFixesInstalled = true

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
