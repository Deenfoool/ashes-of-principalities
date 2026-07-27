export function installMarshSystemFixes(db, marshSystem) {
  if (marshSystem.__healingFixInstalled) return
  marshSystem.__healingFixInstalled = true

  const originalAdvanceHealing = marshSystem.advanceHealing.bind(marshSystem)
  marshSystem.advanceHealing = (userId, now = Date.now()) => {
    const active = db.prepare(`
      SELECT 1 FROM player_expeditions WHERE user_id = ? AND status = 'active'
    `).get(userId)
    if (active) return 0
    return originalAdvanceHealing(userId, now)
  }
}
