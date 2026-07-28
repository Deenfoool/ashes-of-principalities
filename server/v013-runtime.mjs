export function installV013Runtime(db) {
  db.exec(`
    DROP TRIGGER IF EXISTS trg_unique_tool_wear;
    DROP TRIGGER IF EXISTS trg_unique_persist_loadout;
    DROP TRIGGER IF EXISTS trg_v013_main_hand_wear;
    DROP TRIGGER IF EXISTS trg_v013_persist_loadout;

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
  `)
}
