import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { installEquipmentPresentation } from './equipment-presentation.mjs'

test('artifact listings expose equipment slot and combat properties before purchase', () => {
  const db = new DatabaseSync(':memory:')
  try {
    db.exec(`
      CREATE TABLE unique_items (
        id TEXT PRIMARY KEY,
        template_id TEXT NOT NULL,
        equipment_slot TEXT NOT NULL,
        quality TEXT NOT NULL
      ) STRICT;
      INSERT INTO unique_items(id, template_id, equipment_slot, quality)
      VALUES ('armor-1', 'reed-lamellar', 'body', 'good');
    `)
    const artifacts = {
      listingRows: () => [{
        id: 'listing-1',
        item: { id: 'armor-1', name: 'Тростниковый ламелляр' },
      }],
      history: () => {},
    }
    const equipment = {
      players: {},
      survival: {},
      statsFor: () => ({
        armor: 4,
        zoneResistance: 1,
        movementDiscount: 0,
        hexResistance: 0,
        elevationBonus: 0,
      }),
    }
    installEquipmentPresentation(db, artifacts, equipment)
    const listing = artifacts.listingRows('buyer-1')[0]
    assert.equal(listing.item.equipmentSlot, 'body')
    assert.equal(listing.item.armor, 4)
    assert.equal(listing.item.zoneResistance, 1)
    assert.equal(typeof equipment.survival.unequipSlot, 'function')
  } finally { db.close() }
})
