export function installV013SaltGroupTrigger(db) {
  db.exec(`
    DROP TRIGGER IF EXISTS trg_v013_seed_salt_group;

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
        'active', 10, NEW.started_at, NEW.updated_at
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
        'active', 20, NEW.started_at, NEW.updated_at
      );

      UPDATE player_expeditions SET target_enemy_id = (
        SELECT id FROM player_expedition_enemies
        WHERE expedition_id = NEW.id AND status = 'active'
        ORDER BY priority, created_at LIMIT 1
      ) WHERE id = NEW.id;
    END;
  `)
}
