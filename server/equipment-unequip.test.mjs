import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { installEquipmentUnequip } from './equipment-unequip.mjs'

test('unequip removes only the selected slot and its persistent loadout', () => {
  const db = new DatabaseSync(':memory:')
  try {
    db.exec(`
      CREATE TABLE unique_items (
        id TEXT PRIMARY KEY,
        owner_user_id TEXT,
        equipment_slot TEXT NOT NULL,
        equipped INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE player_loadouts (
        user_id TEXT NOT NULL,
        slot TEXT NOT NULL,
        item_id TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY(user_id, slot)
      ) STRICT;
      INSERT INTO unique_items VALUES
        ('hand', 'user-1', 'main-hand', 1, 0),
        ('body', 'user-1', 'body', 1, 0),
        ('charm', 'user-1', 'charm', 1, 0);
      INSERT INTO player_loadouts VALUES
        ('user-1', 'main-hand', 'hand', 0),
        ('user-1', 'body', 'body', 0),
        ('user-1', 'charm', 'charm', 0);
    `)
    const events = []
    const players = {
      getActiveRun: () => null,
      getCharacter: () => ({ userId: 'user-1' }),
      withReceipt: (_userId, _requestId, _action, operation) => operation(),
    }
    const survival = {}
    const artifacts = { history: (...args) => events.push(args) }
    installEquipmentUnequip(db, players, survival, artifacts)
    const result = survival.unequipSlot('user-1', 'body', { requestId: 'unequip-body-1' })

    const equipped = Object.fromEntries(db.prepare('SELECT id, equipped FROM unique_items').all().map((row) => [row.id, Number(row.equipped)]))
    const loadouts = db.prepare("SELECT slot FROM player_loadouts WHERE user_id = 'user-1' ORDER BY slot").all().map((row) => row.slot)
    assert.deepEqual(equipped, { hand: 1, body: 0, charm: 1 })
    assert.deepEqual(loadouts, ['charm', 'main-hand'])
    assert.equal(result.slot, 'body')
    assert.equal(events.length, 1)
  } finally { db.close() }
})
