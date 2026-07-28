import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { installV013Runtime } from './v013-runtime.mjs'

function setup() {
  const db = new DatabaseSync(':memory:')
  db.exec(`
    CREATE TABLE unique_items (
      id TEXT PRIMARY KEY,
      template_id TEXT NOT NULL,
      item_name TEXT NOT NULL,
      item_type TEXT NOT NULL,
      quality TEXT NOT NULL,
      durability INTEGER NOT NULL,
      max_durability INTEGER NOT NULL,
      equipment_slot TEXT NOT NULL,
      equipped INTEGER NOT NULL,
      repair_count INTEGER NOT NULL,
      owner_user_id TEXT,
      lineage_user_id TEXT,
      maker_user_id TEXT,
      origin_type TEXT NOT NULL,
      origin_detail TEXT NOT NULL,
      serial_number INTEGER NOT NULL,
      trade_count INTEGER NOT NULL,
      tradable INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE player_loadouts (
      user_id TEXT NOT NULL,
      slot TEXT NOT NULL,
      item_id TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(user_id, slot)
    ) STRICT;
    CREATE TABLE player_action_receipts (
      user_id TEXT NOT NULL,
      request_id TEXT NOT NULL,
      action TEXT NOT NULL,
      result_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY(user_id, request_id)
    ) STRICT;
    CREATE TABLE player_characters (
      user_id TEXT PRIMARY KEY,
      generation INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE player_inventory (
      user_id TEXT NOT NULL,
      item_id TEXT NOT NULL,
      item_name TEXT NOT NULL,
      quantity INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY(user_id, item_id)
    ) STRICT;
    INSERT INTO player_characters(user_id, generation) VALUES ('user-1', 2);
  `)
  const insertItem = db.prepare(`
    INSERT INTO unique_items(
      id, template_id, item_name, item_type, quality, durability, max_durability,
      equipment_slot, equipped, repair_count, owner_user_id, lineage_user_id,
      maker_user_id, origin_type, origin_detail, serial_number, trade_count,
      tradable, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'common', ?, ?, ?, ?, 0, 'user-1', 'user-1', NULL, 'test', ?, ?, 0, 1, 0, 0)
  `)
  insertItem.run('hand', 'test-hand', 'Старый тесак', 'weapon', 10, 50, 'main-hand', 1, 'hand', 1)
  insertItem.run('body', 'test-body', 'Старая броня', 'armor', 20, 60, 'body', 0, 'body', 2)
  insertItem.run('charm', 'test-charm', 'Старый оберег', 'tool', 30, 40, 'charm', 0, 'charm', 3)
  const insertLoadout = db.prepare("INSERT INTO player_loadouts(user_id, slot, item_id, updated_at) VALUES ('user-1', ?, ?, 0)")
  insertLoadout.run('main-hand', 'hand')
  insertLoadout.run('body', 'body')
  insertLoadout.run('charm', 'charm')
  db.exec(`
    CREATE TRIGGER trg_unique_tool_wear
    AFTER INSERT ON player_action_receipts
    BEGIN
      UPDATE unique_items SET durability = durability - 1 WHERE owner_user_id = NEW.user_id AND equipped = 1;
    END;
    CREATE TRIGGER trg_unique_craft_repair
    AFTER INSERT ON player_action_receipts
    WHEN NEW.action = 'craft:use-repair-kit'
    BEGIN
      UPDATE unique_items SET durability = MIN(max_durability, durability + 20)
      WHERE owner_user_id = NEW.user_id AND equipped = 1;
    END;
  `)
  return db
}

test('runtime restores three slots and remains safe across repeated server starts', () => {
  const db = setup()
  try {
    installV013Runtime(db)
    installV013Runtime(db)
    const equipped = db.prepare("SELECT id FROM unique_items WHERE owner_user_id = 'user-1' AND equipped = 1 ORDER BY equipment_slot").all()
    const oldTriggers = db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'trg_unique_%'").get()
    const newTriggers = db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'trg_v013_%'").get()
    assert.deepEqual(equipped.map((row) => row.id), ['body', 'charm', 'hand'])
    assert.equal(Number(oldTriggers.count), 0)
    assert.equal(Number(newTriggers.count), 7)
  } finally { db.close() }
})

test('first upgrade captures an equipped main hand even when old loadout is missing', () => {
  const db = setup()
  try {
    db.prepare("DELETE FROM player_loadouts WHERE slot = 'main-hand'").run()
    installV013Runtime(db)
    const hand = db.prepare("SELECT equipped FROM unique_items WHERE id = 'hand'").get()
    const loadout = db.prepare("SELECT item_id FROM player_loadouts WHERE user_id = 'user-1' AND slot = 'main-hand'").get()
    assert.equal(Number(hand.equipped), 1)
    assert.equal(loadout.item_id, 'hand')
  } finally { db.close() }
})

test('combat wear and repair kit affect main hand only', () => {
  const db = setup()
  try {
    installV013Runtime(db)
    db.prepare(`
      INSERT INTO player_action_receipts(user_id, request_id, action, result_json, created_at)
      VALUES ('user-1', 'attack-1', 'expedition:attack:enemy', '{}', 1)
    `).run()
    let items = Object.fromEntries(db.prepare('SELECT id, durability FROM unique_items').all().map((row) => [row.id, Number(row.durability)]))
    assert.deepEqual(items, { hand: 9, body: 20, charm: 30 })

    db.prepare(`
      INSERT INTO player_action_receipts(user_id, request_id, action, result_json, created_at)
      VALUES ('user-1', 'repair-1', 'craft:use-repair-kit', '{}', 2)
    `).run()
    items = Object.fromEntries(db.prepare('SELECT id, durability FROM unique_items').all().map((row) => [row.id, Number(row.durability)]))
    assert.deepEqual(items, { hand: 29, body: 20, charm: 30 })
  } finally { db.close() }
})

test('new heir starter replaces main hand without unequipping inherited armor and charm', () => {
  const db = setup()
  try {
    installV013Runtime(db)
    db.prepare(`
      INSERT INTO player_inventory(user_id, item_id, item_name, quantity)
      VALUES ('user-1', 'smith-hammer', 'Кузнечный молоток', 1)
    `).run()
    const equipped = db.prepare(`
      SELECT template_id, equipment_slot FROM unique_items
      WHERE owner_user_id = 'user-1' AND equipped = 1 ORDER BY equipment_slot
    `).all()
    const loadout = Object.fromEntries(db.prepare("SELECT slot, item_id FROM player_loadouts WHERE user_id = 'user-1'").all().map((row) => [row.slot, row.item_id]))
    const newHand = db.prepare("SELECT id FROM unique_items WHERE owner_user_id = 'user-1' AND template_id = 'smith-hammer'").get()
    assert.deepEqual(equipped.map((row) => [row.template_id, row.equipment_slot]), [
      ['test-body', 'body'],
      ['test-charm', 'charm'],
      ['smith-hammer', 'main-hand'],
    ])
    assert.equal(loadout['main-hand'], newHand.id)
    assert.equal(loadout.body, 'body')
    assert.equal(loadout.charm, 'charm')
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM player_inventory WHERE user_id = 'user-1'").get().count, 0)
  } finally { db.close() }
})
