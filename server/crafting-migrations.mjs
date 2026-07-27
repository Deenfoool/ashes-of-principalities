import { applyMigration } from './migrations.mjs'

export function installCraftingMigrations(db) {
  applyMigration(db, '007_crafting_lifecycle', () => {
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS trg_crafting_clear_effects_for_heir
      AFTER UPDATE OF generation ON player_characters
      WHEN NEW.generation > OLD.generation
      BEGIN
        DELETE FROM player_effects WHERE user_id = NEW.user_id;
      END;
    `)

    db.prepare(`
      UPDATE player_inventory SET item_type = 'consumable'
      WHERE item_id IN (
        'repair-kit', 'healing-poultice', 'leather-bindings',
        'warded-ink', 'cargo-brace', 'traveler-kit'
      )
    `).run()
  })
}
