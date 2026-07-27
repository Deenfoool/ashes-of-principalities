import { StoreError } from './store.mjs'

export function installRegionFixes(db, regions) {
  if (regions.__compatibilityFixesInstalled) return
  regions.__compatibilityFixesInstalled = true

  const originalActOffer = regions.actOffer.bind(regions)
  regions.actOffer = (userId, input) => {
    if (String(input.action ?? '') === 'profession') {
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
