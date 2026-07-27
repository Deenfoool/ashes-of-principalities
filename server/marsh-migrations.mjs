import { applyMigration } from './migrations.mjs'

const HOUR = 60 * 60 * 1000

export function installMarshMigrations(db) {
  return applyMigration(db, '014_salt_marsh_story_and_recovery', () => {
    db.exec(`
      ALTER TABLE player_injuries ADD COLUMN natural_heal_at INTEGER;
      ALTER TABLE player_injuries ADD COLUMN recovery_interval INTEGER NOT NULL DEFAULT ${12 * HOUR};
      ALTER TABLE player_injuries ADD COLUMN recovery_note TEXT NOT NULL DEFAULT '';

      UPDATE player_injuries SET
        recovery_interval = CASE kind
          WHEN 'salt-burn' THEN ${8 * HOUR}
          WHEN 'marsh-fever' THEN ${18 * HOUR}
          WHEN 'deep-cut' THEN ${24 * HOUR}
          WHEN 'sprained-ankle' THEN ${18 * HOUR}
          ELSE ${12 * HOUR}
        END,
        natural_heal_at = COALESCE(natural_heal_at, created_at + CASE kind
          WHEN 'salt-burn' THEN ${8 * HOUR}
          WHEN 'marsh-fever' THEN ${18 * HOUR}
          WHEN 'deep-cut' THEN ${24 * HOUR}
          WHEN 'sprained-ankle' THEN ${18 * HOUR}
          ELSE ${12 * HOUR}
        END),
        recovery_note = CASE kind
          WHEN 'salt-burn' THEN 'Промывай кожу пресной водой и не входи в рассол.'
          WHEN 'marsh-fever' THEN 'Тепло и сон ускоряют спад лихорадки.'
          WHEN 'deep-cut' THEN 'Рана затянется только после нескольких спокойных ночей.'
          ELSE 'Покой постепенно уменьшает тяжесть травмы.'
        END
      WHERE status = 'active';

      CREATE TABLE player_marsh_story_state (
        user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        generation INTEGER NOT NULL,
        scene_id TEXT NOT NULL,
        flags_json TEXT NOT NULL DEFAULT '[]',
        history_json TEXT NOT NULL DEFAULT '[]',
        decision_count INTEGER NOT NULL DEFAULT 0,
        started INTEGER NOT NULL DEFAULT 0 CHECK(started IN (0, 1)),
        chapter_complete INTEGER NOT NULL DEFAULT 0 CHECK(chapter_complete IN (0, 1)),
        ending TEXT,
        updated_at INTEGER NOT NULL
      ) STRICT;

      CREATE TABLE player_marsh_story_quests (
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        quest_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('active', 'completed')),
        outcome TEXT,
        contract_counted INTEGER NOT NULL DEFAULT 0 CHECK(contract_counted IN (0, 1)),
        started_at INTEGER NOT NULL,
        completed_at INTEGER,
        PRIMARY KEY(user_id, quest_id)
      ) STRICT;

      CREATE TABLE player_marsh_pending_encounters (
        user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        expedition_id TEXT NOT NULL UNIQUE REFERENCES player_expeditions(id) ON DELETE CASCADE,
        quest_id TEXT NOT NULL,
        victory_scene_id TEXT NOT NULL,
        flee_scene_id TEXT NOT NULL,
        created_at INTEGER NOT NULL
      ) STRICT;

      CREATE INDEX idx_marsh_story_quests_status
        ON player_marsh_story_quests(user_id, status, started_at);

      CREATE TRIGGER trg_marsh_injury_recovery_defaults
      AFTER INSERT ON player_injuries
      WHEN NEW.natural_heal_at IS NULL
      BEGIN
        UPDATE player_injuries SET
          recovery_interval = CASE NEW.kind
            WHEN 'salt-burn' THEN ${8 * HOUR}
            WHEN 'marsh-fever' THEN ${18 * HOUR}
            WHEN 'deep-cut' THEN ${24 * HOUR}
            WHEN 'sprained-ankle' THEN ${18 * HOUR}
            ELSE ${12 * HOUR}
          END,
          natural_heal_at = NEW.created_at + CASE NEW.kind
            WHEN 'salt-burn' THEN ${8 * HOUR}
            WHEN 'marsh-fever' THEN ${18 * HOUR}
            WHEN 'deep-cut' THEN ${24 * HOUR}
            WHEN 'sprained-ankle' THEN ${18 * HOUR}
            ELSE ${12 * HOUR}
          END,
          recovery_note = CASE NEW.kind
            WHEN 'salt-burn' THEN 'Промывай кожу пресной водой и не входи в рассол.'
            WHEN 'marsh-fever' THEN 'Тепло и сон ускоряют спад лихорадки.'
            WHEN 'deep-cut' THEN 'Рана затянется только после нескольких спокойных ночей.'
            ELSE 'Покой постепенно уменьшает тяжесть травмы.'
          END
        WHERE id = NEW.id;
      END;

      CREATE TRIGGER trg_marsh_salt_burn
      AFTER UPDATE OF health ON player_characters
      WHEN NEW.alive = 1 AND NEW.health > 0
        AND NEW.health * 3 <= NEW.max_health * 2
        AND EXISTS (
          SELECT 1 FROM player_expeditions
          WHERE user_id = NEW.user_id AND status = 'active' AND region_id = 'salt-marsh'
        )
      BEGIN
        INSERT OR IGNORE INTO player_injuries(
          id, user_id, kind, title, severity, status, source, created_at,
          natural_heal_at, recovery_interval, recovery_note
        ) VALUES (
          lower(hex(randomblob(16))), NEW.user_id, 'salt-burn', 'Соляной ожог', 1,
          'active', 'Едкий рассол Соляных топей', unixepoch('subsec') * 1000,
          unixepoch('subsec') * 1000 + ${8 * HOUR}, ${8 * HOUR},
          'Промывай кожу пресной водой и не входи в рассол.'
        );
      END;

      CREATE TRIGGER trg_marsh_deep_cut
      AFTER UPDATE OF health ON player_characters
      WHEN NEW.alive = 1 AND NEW.health > 0
        AND NEW.health * 3 <= NEW.max_health
        AND EXISTS (
          SELECT 1 FROM player_expeditions
          WHERE user_id = NEW.user_id AND status = 'active' AND region_id = 'salt-marsh'
        )
      BEGIN
        INSERT OR IGNORE INTO player_injuries(
          id, user_id, kind, title, severity, status, source, created_at,
          natural_heal_at, recovery_interval, recovery_note
        ) VALUES (
          lower(hex(randomblob(16))), NEW.user_id, 'deep-cut', 'Глубокий порез', 2,
          'active', 'Ржавое железо и острый тростник', unixepoch('subsec') * 1000,
          unixepoch('subsec') * 1000 + ${24 * HOUR}, ${24 * HOUR},
          'Рана затянется только после нескольких спокойных ночей.'
        );
      END;

      CREATE TRIGGER trg_marsh_fever_after_expedition
      AFTER UPDATE OF status ON player_expeditions
      WHEN OLD.status = 'active' AND NEW.status IN ('won', 'fled')
        AND NEW.region_id = 'salt-marsh'
        AND json_extract(NEW.contract_snapshot_json, '$.complicationId') IN ('fog', 'distant-bells')
      BEGIN
        INSERT OR IGNORE INTO player_injuries(
          id, user_id, kind, title, severity, status, source, created_at,
          natural_heal_at, recovery_interval, recovery_note
        ) VALUES (
          lower(hex(randomblob(16))), NEW.user_id, 'marsh-fever', 'Болотная лихорадка', 1,
          'active', 'Холодный туман Соляных топей', unixepoch('subsec') * 1000,
          unixepoch('subsec') * 1000 + ${18 * HOUR}, ${18 * HOUR},
          'Тепло и сон ускоряют спад лихорадки.'
        );
      END;

      CREATE TRIGGER trg_marsh_sigil_on_start
      AFTER INSERT ON player_expeditions
      WHEN NEW.region_id = 'salt-marsh'
        AND EXISTS (
          SELECT 1 FROM player_inventory
          WHERE user_id = NEW.user_id AND item_id = 'marsh-sigil' AND quantity > 0
        )
      BEGIN
        UPDATE player_expeditions SET guard = guard + 2 WHERE id = NEW.id;
        UPDATE player_inventory SET quantity = quantity - 1
          WHERE user_id = NEW.user_id AND item_id = 'marsh-sigil';
        DELETE FROM player_inventory
          WHERE user_id = NEW.user_id AND item_id = 'marsh-sigil' AND quantity <= 0;
      END;

      CREATE TRIGGER trg_marsh_cordage_on_move
      AFTER INSERT ON player_action_receipts
      WHEN NEW.action IN ('expedition:advance', 'expedition:retreat')
        AND EXISTS (
          SELECT 1 FROM player_expeditions
          WHERE user_id = NEW.user_id AND status = 'active' AND region_id = 'salt-marsh'
        )
        AND EXISTS (
          SELECT 1 FROM player_inventory
          WHERE user_id = NEW.user_id AND item_id = 'marsh-cordage' AND quantity > 0
        )
      BEGIN
        UPDATE player_characters SET stamina = MIN(max_stamina, stamina + 1),
          updated_at = unixepoch('subsec') * 1000 WHERE user_id = NEW.user_id;
        UPDATE player_inventory SET quantity = quantity - 1
          WHERE user_id = NEW.user_id AND item_id = 'marsh-cordage';
        DELETE FROM player_inventory
          WHERE user_id = NEW.user_id AND item_id = 'marsh-cordage' AND quantity <= 0;
      END;
    `)
  })
}
