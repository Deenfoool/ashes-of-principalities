export function installEquipmentPresentation(db, artifacts, equipment) {
  const decorate = (item) => {
    if (!item?.id) return item
    const row = db.prepare(`
      SELECT template_id, equipment_slot, quality
      FROM unique_items WHERE id = ?
    `).get(item.id)
    if (!row) return item
    const stats = equipment.statsFor(row)
    return {
      ...item,
      equipmentSlot: row.equipment_slot,
      armor: stats.armor,
      zoneResistance: stats.zoneResistance,
      movementDiscount: stats.movementDiscount,
      hexResistance: stats.hexResistance,
      elevationBonus: stats.elevationBonus,
    }
  }

  const originalListingRows = artifacts.listingRows.bind(artifacts)
  artifacts.listingRows = (userId, own = false) => originalListingRows(userId, own).map((listing) => ({
    ...listing,
    item: decorate(listing.item),
  }))
}
