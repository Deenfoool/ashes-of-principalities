import { applyMigration } from './migrations.mjs'

export function installV013Migrations(db) {
  return applyMigration(db, '016_equipment_slots_and_squad_combat', () => {
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

      CREATE TRIGGER trg_v013_main_hand_wear
      AFTER INSERT ON player_action_receipts
      WHEN NEW.action LIKE 'expedition:attack%' OR NEW.action LIKE 'expedition:profession%'
      BEGIN
        UPDATE unique_items SET durability = max(0, durability - 1), updated_at = unixepoch('subsec') * 1000
        WHERE owner_user_id = NEW.user_id AND equipment_slot = 'main-hand' AND equipped = 1;
      END;

      CREATE TRIGGER trg_v013_persist_loadout
      AFTER INSERT ON player_action_receipts
      WHEN NEW.action LIKE 'equip:%'
      BEGIN
        INSERT INTO player_loadouts(user_id, slot, item_id, updated_at)
        SELECT NEW.user_id, equipment_slot, id, unixepoch('subsec') * 1000
        FROM unique_items
        WHERE id = substr(NEW.action, 7) AND owner_user_id = NEW.user_id AND equipped = 1
        ON CONFLICT(user_id, slot) DO UPDATE SET
          item_id = excluded.item_id,
          updated_at = excluded.updated_at;
      END;

      CREATE TRIGGER trg_v013_seed_salt_group
      AFTER INSERT ON player_expeditions
      WHEN NEW.region_id = 'salt-marsh'
        AND NEW.offer_id IS NOT NULL
        AND EXISTS (SELECT 1 FROM player_contract_offers WHERE id = NEW.offer_id)
      BEGIN
        UPDATE player_expeditions SET
          encounter_type = 'group',
          max_elevation = CASE NEW.terrain_id
            WHEN 'sunken-chapel' THEN 2
            WHEN 'reed-maze' THEN 1
            ELSE 1
          END
        WHERE id = NEW.id;

        INSERT INTO player_expedition_enemies(
          id, expedition_id, enemy_key, enemy_name, enemy_role,
          health, max_health, distance, elevation, intent, zone_power,
          status, priority, created_at, updated_at
        ) VALUES (
          lower(hex(randomblob(16))), NEW.id, 'leader', NEW.enemy_name,
          CASE NEW.enemy_style WHEN 'ranged' THEN 'ranged' WHEN 'skirmisher' THEN 'skirmisher' ELSE 'brute' END,
          NEW.enemy_health, NEW.enemy_max_health, NEW.distance,
          CASE WHEN NEW.terrain_id = 'sunken-chapel' AND NEW.enemy_style = 'ranged' THEN 1 ELSE 0 END,
          NEW.enemy_intent, CASE WHEN NEW.enemy_style = 'melee' THEN 1 ELSE 0 END,
          'active', 10, NEW.created_at, NEW.updated_at
        );

        INSERT INTO player_expedition_enemies(
          id, expedition_id, enemy_key, enemy_name, enemy_role,
          health, max_health, distance, elevation, intent, zone_power,
          status, priority, created_at, updated_at
        ) VALUES (
          lower(hex(randomblob(16))), NEW.id, 'support',
          CASE NEW.enemy_style WHEN 'ranged' THEN 'Тростниковый загонщик' ELSE 'Соляной пращник' END,
          CASE NEW.enemy_style WHEN 'ranged' THEN 'controller' ELSE 'ranged' END,
          MAX(6, CAST(NEW.enemy_max_health / 2 AS INTEGER)),
          MAX(6, CAST(NEW.enemy_max_health / 2 AS INTEGER)),
          MIN(NEW.max_distance, NEW.distance + 1),
          CASE WHEN NEW.terrain_id = 'sunken-chapel' THEN 2 ELSE 0 END,
          'attack', CASE NEW.enemy_style WHEN 'ranged' THEN 2 ELSE 0 END,
          'active', 20, NEW.created_at, NEW.updated_at
        );

        UPDATE player_expeditions SET target_enemy_id = (
          SELECT id FROM player_expedition_enemies
          WHERE expedition_id = NEW.id AND status = 'active'
          ORDER BY priority, created_at LIMIT 1
        ) WHERE id = NEW.id;
      END;
    `)
  })
}
