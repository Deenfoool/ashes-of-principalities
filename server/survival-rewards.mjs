export function installSurvivalRewards(db) {
  db.exec(`
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
    INSERT OR IGNORE INTO player_inventory(
      user_id, item_id, item_name, quantity, item_type, quality,
      durability, max_durability, equipped, repair_count
    )
    SELECT user_id, 'road-blade', 'Дорожный тесак', 1, 'tool', 'good', 60, 60, 0, 0
    FROM player_story_state WHERE chapter_complete = 1
  `).run()
}