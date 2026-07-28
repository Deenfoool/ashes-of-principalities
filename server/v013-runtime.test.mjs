import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { installV013Runtime } from './v013-runtime.mjs'

function setup() {
  const db = new DatabaseSync(':memory:')
  db.exec(`
    CREATE TABLE unique_items (
      id TEXT PRIMARY KEY,
      owner_user_id TEXT,
      equipment_slot TEXT NOT NULL,
      equipped INTEGER NOT NULL,
      durability INTEGER NOT NULL,
      max_durability INTEGER NOT NULL,
      quality TEXT NOT NULL,
      repair_count INTEGER NOT NULL,
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
  `)
  const insertItem = db.prepare(`
    INSERT INTO unique_items(id, owner_user_id, equipment_slot, equipped, durability, max_durability, quality, repair_count, updated_at)
    VALUES (?, 'user-1', ?, ?, ?, ?, 'common', 0, 0)
  `)
  insertItem.run('hand', 'main-hand', 1, 10, 50)
  insertItem.run('body', 'body', 0, 20, 60)
  insertItem.run('charm', 'charm', 0, 30, 40)
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

test('runtime restores three slots and removes legacy triggers', () => {
  const db = setup()
  try {
    installV013Runtime(db)
    const equipped = db.prepare("SELECT id FROM unique_items WHERE owner_user_id = 'user-1' AND equipped = 1 ORDER BY equipment_slot").all()
    const oldTriggers = db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'trg_unique_%'").get()
    assert.deepEqual(equipped.map((row) => row.id), ['body', 'charm', 'hand'])
    assert.equal(Number(oldTriggers.count), 0)
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
