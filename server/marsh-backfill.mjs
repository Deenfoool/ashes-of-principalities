export function backfillRegionalMaterials(db, marshCrafting) {
  if (!marshCrafting?.claimRegionalMaterials) return 0
  const rows = db.prepare(`
    SELECT id, user_id FROM player_expeditions
    WHERE status = 'won' AND offer_id IS NOT NULL AND region_id IN ('ash-road', 'salt-marsh')
    ORDER BY updated_at
  `).all()
  let processed = 0
  for (const row of rows) {
    marshCrafting.claimRegionalMaterials(row.user_id, row.id)
    processed += 1
  }
  return processed
}
