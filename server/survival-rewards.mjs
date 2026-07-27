export function installSurvivalRewards(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS player_reward_claims (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      reward_id TEXT NOT NULL,
      claimed_at INTEGER NOT NULL,
      PRIMARY KEY(user_id, reward_id)
    ) STRICT;

    CREATE TRIGGER IF NOT EXISTS trg_survival_founder_seal_consumed
    AFTER INSERT ON guilds
    BEGIN
      INSERT OR IGNORE INTO player_reward_claims(user_id, reward_id, claimed_at)
      VALUES (NEW.leader_id, 'founder-seal-consumed', unixepoch('subsec') * 1000);
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
}