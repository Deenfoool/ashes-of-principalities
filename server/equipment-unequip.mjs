import { StoreError } from './store.mjs'

const SLOTS = new Set(['main-hand', 'body', 'charm'])

export function installEquipmentUnequip(db, players, survival, artifacts) {
  survival.unequipSlot = (userId, slotValue, input) => {
    const slot = String(slotValue ?? '')
    if (!SLOTS.has(slot)) throw new StoreError('equipment-slot-not-found', 'Неизвестный слот экипировки.', 404)
    return players.withReceipt(userId, input.requestId, `unequip:${slot}`, () => {
      if (players.getActiveRun(userId)) throw new StoreError('expedition-active', 'Нельзя менять снаряжение во время боя.', 409)
      const item = db.prepare(`
        SELECT id FROM unique_items
        WHERE owner_user_id = ? AND equipment_slot = ? AND equipped = 1
      `).get(userId, slot)
      if (!item) throw new StoreError('equipment-slot-empty', 'В этом слоте уже ничего не надето.', 409)
      const now = Date.now()
      db.prepare('UPDATE unique_items SET equipped = 0, updated_at = ? WHERE id = ?').run(now, item.id)
      db.prepare('DELETE FROM player_loadouts WHERE user_id = ? AND slot = ?').run(userId, slot)
      artifacts.history(item.id, 'unequipped', userId, userId, userId, { slot })
      return { character: players.getCharacter(userId), slot }
    })
  }
}
