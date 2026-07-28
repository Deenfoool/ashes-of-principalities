import { applyMigration } from './migrations.mjs'
import { installV013Runtime } from './v013-runtime.mjs'
import { installV013SaltGroupTrigger } from './v013-salt-group-trigger.mjs'

export function installV013Migrations(db) {
  const applied = applyMigration(db, '016_equipment_slots_and_squad_combat', () => {
    db.exec(`
      ALTER TABLE unique_items ADD COLUMN equipment_slot TEXT NOT NULL DEFAULT 'main-hand'
        CHECK(equipment_slot IN ('main-hand', 'body', 'charm'));

      UPDATE unique_items SET equipment_slot = 'body' WHERE item_type = 'armor';
      UPDATE player_loadouts SET slot = 'main-hand' WHERE slot = 'tool';

      CREATE UNIQUE INDEX idx_unique_equipped_slot
        ON unique_items(owner_user_id, equipment_slot)
        WHERE equipped = 1 AND owner_user_id IS NOT NULL;

      ALTER TABLE player_expeditions ADD COLUMN encounter_type TEXT NOT NULL DEFAULT 'single'
        CHECK(encounter_type IN ('single', 'group', 'boss'));
      ALTER TABLE player_expeditions ADD COLUMN hero_elevation INTEGER NOT NULL DEFAULT 0
        CHECK(hero_elevation BETWEEN 0 AND 2);
      ALTER TABLE player_expeditions ADD COLUMN max_elevation INTEGER NOT NULL DEFAULT 1
        CHECK(max_elevation BETWEEN 0 AND 2);
      ALTER TABLE player_expeditions ADD COLUMN zone_control INTEGER NOT NULL DEFAULT 0
        CHECK(zone_control >= 0);
      ALTER TABLE player_expeditions ADD COLUMN boss_phase INTEGER NOT NULL DEFAULT 0
        CHECK(boss_phase BETWEEN 0 AND 3);
      ALTER TABLE player_expeditions ADD COLUMN target_enemy_id TEXT;
      ALTER TABLE player_expeditions ADD COLUMN boss_id TEXT;

      CREATE TABLE player_expedition_enemies (
        id TEXT PRIMARY KEY,
        expedition_id TEXT NOT NULL REFERENCES player_expeditions(id) ON DELETE CASCADE,
        enemy_key TEXT NOT NULL,
        enemy_name TEXT NOT NULL,
        enemy_role TEXT NOT NULL CHECK(enemy_role IN ('brute', 'controller', 'ranged', 'skirmisher', 'boss')),
        health INTEGER NOT NULL CHECK(health >= 0),
        max_health INTEGER NOT NULL CHECK(max_health > 0),
        distance INTEGER NOT NULL DEFAULT 1 CHECK(distance BETWEEN 0 AND 3),
        elevation INTEGER NOT NULL DEFAULT 0 CHECK(elevation BETWEEN 0 AND 2),
        intent TEXT NOT NULL DEFAULT 'attack',
        zone_power INTEGER NOT NULL DEFAULT 0 CHECK(zone_power BETWEEN 0 AND 4),
        status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'defeated')),
        priority INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(expedition_id, enemy_key)
      ) STRICT;

      CREATE INDEX idx_expedition_enemies_active
        ON player_expedition_enemies(expedition_id, status, priority, created_at);

      CREATE TABLE player_boss_progress (
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        boss_id TEXT NOT NULL,
        unlocked_at INTEGER NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
        victories INTEGER NOT NULL DEFAULT 0 CHECK(victories >= 0),
        first_defeated_at INTEGER,
        last_attempt_at INTEGER,
        last_defeated_at INTEGER,
        PRIMARY KEY(user_id, boss_id)
      ) STRICT;

      DROP TRIGGER IF EXISTS trg_unique_tool_wear;
      DROP TRIGGER IF EXISTS trg_unique_persist_loadout;
    `)
    installV013SaltGroupTrigger(db)
  })
  installV013Runtime(db)
  installV013SaltGroupTrigger(db)
  return applied
}
