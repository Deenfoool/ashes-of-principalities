import assert from 'node:assert/strict'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { installV013SaltGroupTrigger } from './v013-salt-group-trigger.mjs'

const insertExpeditionSql = `
  INSERT INTO player_expeditions(
    id, region_id, offer_id, terrain_id, enemy_name, enemy_style,
    enemy_health, enemy_max_health, distance, max_distance, enemy_intent,
    started_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`

function createFixture() {
  const db = new DatabaseSync(':memory:')
  db.exec(`
    CREATE TABLE player_expeditions (
      id TEXT PRIMARY KEY,
      region_id TEXT NOT NULL,
      offer_id TEXT,
      terrain_id TEXT NOT NULL,
      enemy_name TEXT NOT NULL,
      enemy_style TEXT NOT NULL,
      enemy_health INTEGER NOT NULL,
      enemy_max_health INTEGER NOT NULL,
      distance INTEGER NOT NULL,
      max_distance INTEGER NOT NULL,
      enemy_intent TEXT NOT NULL,
      encounter_type TEXT NOT NULL DEFAULT 'single',
      max_elevation INTEGER NOT NULL DEFAULT 1,
      target_enemy_id TEXT,
      started_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    ) STRICT;

    CREATE TABLE player_contract_offers (
      id TEXT PRIMARY KEY
    ) STRICT;

    CREATE TABLE player_expedition_enemies (
      id TEXT PRIMARY KEY,
      expedition_id TEXT NOT NULL,
      enemy_key TEXT NOT NULL,
      enemy_name TEXT NOT NULL,
      enemy_role TEXT NOT NULL,
      health INTEGER NOT NULL,
      max_health INTEGER NOT NULL,
      distance INTEGER NOT NULL,
      elevation INTEGER NOT NULL,
      intent TEXT NOT NULL,
      zone_power INTEGER NOT NULL,
      status TEXT NOT NULL,
      priority INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(expedition_id, enemy_key)
    ) STRICT;

    CREATE TRIGGER trg_v013_seed_salt_group
    AFTER INSERT ON player_expeditions
    WHEN NEW.region_id = 'salt-marsh'
    BEGIN
      SELECT NEW.created_at;
    END;
  `)
  return db
}

test('repairs NEW.created_at before an ordinary story encounter is prepared', () => {
  const db = createFixture()
  assert.throws(() => db.prepare(insertExpeditionSql), /no such column: NEW\.created_at/i)

  installV013SaltGroupTrigger(db)
  const insert = db.prepare(insertExpeditionSql)
  insert.run(
    'story-encounter', 'ash-road', null, 'burnt-causeway', 'Утопленник', 'melee',
    18, 18, 1, 2, 'attack', 1000, 1001,
  )

  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM player_expedition_enemies').get().count, 0)
  db.close()
})

test('uses expedition started_at when seeding a Salt Marsh enemy group', () => {
  const db = createFixture()
  installV013SaltGroupTrigger(db)
  db.prepare('INSERT INTO player_contract_offers(id) VALUES (?)').run('offer-1')

  db.prepare(insertExpeditionSql).run(
    'salt-group', 'salt-marsh', 'offer-1', 'sunken-chapel', 'Рассольный мертвец', 'ranged',
    20, 20, 1, 2, 'attack', 2000, 2001,
  )

  const expedition = db.prepare(`
    SELECT encounter_type, max_elevation, target_enemy_id
    FROM player_expeditions WHERE id = 'salt-group'
  `).get()
  assert.equal(expedition.encounter_type, 'group')
  assert.equal(expedition.max_elevation, 2)
  assert.ok(expedition.target_enemy_id)

  const enemies = db.prepare(`
    SELECT enemy_key, created_at, updated_at
    FROM player_expedition_enemies
    ORDER BY priority
  `).all()
  assert.deepEqual(enemies.map((row) => row.enemy_key), ['leader', 'support'])
  assert.deepEqual(enemies.map((row) => Number(row.created_at)), [2000, 2000])
  assert.deepEqual(enemies.map((row) => Number(row.updated_at)), [2001, 2001])
  db.close()
})
