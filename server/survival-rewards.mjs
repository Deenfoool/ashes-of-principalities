export function installSurvivalRewards(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS player_reward_claims (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      reward_id TEXT NOT NULL,
      claimed_at INTEGER NOT NULL,
      PRIMARY KEY(user_id, reward_id)
    ) STRICT;

    CREATE TABLE IF NOT EXISTS player_loadouts (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      slot TEXT NOT NULL,
      item_id TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(user_id, slot)
    ) STRICT;

    DROP TRIGGER IF EXISTS trg_survival_founder_seal;

    CREATE TRIGGER IF NOT EXISTS trg_survival_founder_seal
    AFTER UPDATE OF status ON player_story_quests
    WHEN OLD.status = 'active' AND NEW.status = 'completed'
      AND NOT EXISTS (
        SELECT 1 FROM player_reward_claims
        WHERE user_id = NEW.user_id AND reward_id = 'founder-seal-granted'
      )
    BEGIN
      INSERT OR IGNORE INTO player_inventory(
        user_id, item_id, item_name, quantity, item_type, quality,
        durability, max_durability, equipped, repair_count
      ) VALUES (
        NEW.user_id, 'founder-seal', 'Печать основателя', 1, 'quest', 'good', 0, 0, 0, 0
      );
      INSERT OR IGNORE INTO player_reward_claims(user_id, reward_id, claimed_at)
      VALUES (NEW.user_id, 'founder-seal-granted', unixepoch('subsec') * 1000);
    END;

    CREATE TRIGGER IF NOT EXISTS trg_survival_founder_seal_consumed
    AFTER INSERT ON guilds
    BEGIN
      INSERT OR IGNORE INTO player_reward_claims(user_id, reward_id, claimed_at)
      VALUES (NEW.leader_id, 'founder-seal-consumed', unixepoch('subsec') * 1000);
    END;

    CREATE TRIGGER IF NOT EXISTS trg_survival_persist_equipped_tool
    AFTER INSERT ON player_action_receipts
    WHEN NEW.action LIKE 'equip:%'
    BEGIN
      INSERT INTO player_loadouts(user_id, slot, item_id, updated_at)
      SELECT NEW.user_id, 'tool', item_id, unixepoch('subsec') * 1000
      FROM player_inventory
      WHERE user_id = NEW.user_id AND equipped = 1 AND max_durability > 0
      LIMIT 1
      ON CONFLICT(user_id, slot) DO UPDATE SET
        item_id = excluded.item_id,
        updated_at = excluded.updated_at;
    END;

    CREATE TRIGGER IF NOT EXISTS trg_survival_chapter_reward
    AFTER UPDATE OF chapter_complete ON player_story_state
    WHEN OLD.chapter_complete = 0 AND NEW.chapter_complete = 1
    BEGIN
      INSERT OR IGNORE INTO player_inventory(
        user_id, item_id, item_name, quantity, item_type, quality,
        durability, max_durability, equipped, repair_count
      ) VALUES (
        NEW.user_id, 'road-blade', 'Дорожный тесак', 1, 'tool', 'good', 60, 60, 0, 0
      );
    END;
  `)

  db.prepare(`
    INSERT OR IGNORE INTO player_reward_claims(user_id, reward_id, claimed_at)
    SELECT DISTINCT user_id, 'founder-seal-granted', MIN(completed_at)
    FROM player_story_quests
    WHERE status = 'completed'
    GROUP BY user_id
  `).run()

  db.prepare(`
    INSERT OR IGNORE INTO player_reward_claims(user_id, reward_id, claimed_at)
    SELECT leader_id, 'founder-seal-consumed', created_at FROM guilds
  `).run()

  db.prepare(`
    DELETE FROM player_inventory
    WHERE item_id = 'founder-seal'
      AND user_id IN (
        SELECT user_id FROM player_reward_claims WHERE reward_id = 'founder-seal-consumed'
      )
  `).run()

  db.prepare(`
    INSERT OR IGNORE INTO player_inventory(
      user_id, item_id, item_name, quantity, item_type, quality,
      durability, max_durability, equipped, repair_count
    )
    SELECT user_id, 'road-blade', 'Дорожный тесак', 1, 'tool', 'good', 60, 60, 0, 0
    FROM player_story_state WHERE chapter_complete = 1
  `).run()

  db.prepare(`
    DELETE FROM player_loadouts
    WHERE slot = 'tool'
      AND NOT EXISTS (
        SELECT 1 FROM player_inventory i
        WHERE i.user_id = player_loadouts.user_id
          AND i.item_id = player_loadouts.item_id
          AND i.max_durability > 0
      )
  `).run()

  db.prepare(`
    INSERT OR IGNORE INTO player_loadouts(user_id, slot, item_id, updated_at)
    SELECT user_id, 'tool', item_id, unixepoch('subsec') * 1000
    FROM player_inventory
    WHERE equipped = 1 AND max_durability > 0
  `).run()

  db.prepare(`
    UPDATE player_inventory SET equipped = 0
    WHERE user_id IN (SELECT user_id FROM player_loadouts WHERE slot = 'tool')
  `).run()

  db.prepare(`
    UPDATE player_inventory SET equipped = 1
    WHERE EXISTS (
      SELECT 1 FROM player_loadouts l
      WHERE l.user_id = player_inventory.user_id
        AND l.slot = 'tool'
        AND l.item_id = player_inventory.item_id
    )
  `).run()
}