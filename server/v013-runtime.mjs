export function installV013Runtime(db) {
  db.exec(`
    DROP TRIGGER IF EXISTS trg_unique_tool_wear;
    DROP TRIGGER IF EXISTS trg_unique_persist_loadout;
    DROP TRIGGER IF EXISTS trg_unique_craft_repair;
    DROP TRIGGER IF EXISTS trg_unique_craft_reinforce;
    DROP TRIGGER IF EXISTS trg_unique_craft_reforge_good;
    DROP TRIGGER IF EXISTS trg_unique_craft_reforge_masterwork;
    DROP TRIGGER IF EXISTS trg_v013_main_hand_wear;
    DROP TRIGGER IF EXISTS trg_v013_persist_loadout;
    DROP TRIGGER IF EXISTS trg_v013_craft_repair;
    DROP TRIGGER IF EXISTS trg_v013_craft_reinforce;
    DROP TRIGGER IF EXISTS trg_v013_craft_reforge_good;
    DROP TRIGGER IF EXISTS trg_v013_craft_reforge_masterwork;

    DELETE FROM player_loadouts WHERE slot = 'tool';
    DELETE FROM player_loadouts
    WHERE slot IN ('main-hand', 'body', 'charm')
      AND NOT EXISTS (
        SELECT 1 FROM unique_items item
        WHERE item.id = player_loadouts.item_id
          AND item.owner_user_id = player_loadouts.user_id
          AND item.equipment_slot = player_loadouts.slot
      );

    UPDATE unique_items SET equipped = 0
    WHERE owner_user_id IS NOT NULL;

    UPDATE unique_items SET equipped = 1
    WHERE EXISTS (
      SELECT 1 FROM player_loadouts loadout
      WHERE loadout.user_id = unique_items.owner_user_id
        AND loadout.item_id = unique_items.id
        AND loadout.slot = unique_items.equipment_slot
    );

    CREATE TRIGGER trg_v013_main_hand_wear
    AFTER INSERT ON player_action_receipts
    WHEN NEW.action LIKE 'expedition:attack%' OR NEW.action LIKE 'expedition:profession%'
    BEGIN
      UPDATE unique_items SET durability = max(0, durability - 1), updated_at = unixepoch('subsec') * 1000
      WHERE owner_user_id = NEW.user_id AND equipment_slot = 'main-hand' AND equipped = 1;
    END;

    CREATE TRIGGER trg_v013_craft_repair
    AFTER INSERT ON player_action_receipts
    WHEN NEW.action = 'craft:use-repair-kit'
    BEGIN
      UPDATE unique_items SET durability = MIN(max_durability, durability + 20), updated_at = unixepoch('subsec') * 1000
      WHERE owner_user_id = NEW.user_id AND equipment_slot = 'main-hand' AND equipped = 1;
    END;

    CREATE TRIGGER trg_v013_craft_reinforce
    AFTER INSERT ON player_action_receipts
    WHEN NEW.action IN ('craft:reinforce-tool-hunter', 'craft:reinforce-tool-carter')
    BEGIN
      UPDATE unique_items SET max_durability = MIN(100, max_durability + 10),
        durability = MIN(MIN(100, max_durability + 10), durability + 10),
        updated_at = unixepoch('subsec') * 1000
      WHERE owner_user_id = NEW.user_id AND equipment_slot = 'main-hand' AND equipped = 1;
    END;

    CREATE TRIGGER trg_v013_craft_reforge_good
    AFTER INSERT ON player_action_receipts
    WHEN NEW.action = 'craft:reforge-good'
    BEGIN
      UPDATE unique_items SET quality = 'good', max_durability = MIN(120, max_durability + 20),
        durability = MIN(120, max_durability + 20), repair_count = repair_count + 1,
        updated_at = unixepoch('subsec') * 1000
      WHERE owner_user_id = NEW.user_id AND equipment_slot = 'main-hand' AND equipped = 1;
    END;

    CREATE TRIGGER trg_v013_craft_reforge_masterwork
    AFTER INSERT ON player_action_receipts
    WHEN NEW.action = 'craft:reforge-masterwork'
    BEGIN
      UPDATE unique_items SET quality = 'masterwork', max_durability = MIN(120, max_durability + 25),
        durability = MIN(120, max_durability + 25), repair_count = repair_count + 1,
        updated_at = unixepoch('subsec') * 1000
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
  `)
}
