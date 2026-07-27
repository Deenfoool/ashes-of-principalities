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

    db.exec(`
      UPDATE player_inventory
      SET quantity = MAX(0, quantity - COALESCE((
        SELECT SUM(c.quantity - CASE
          WHEN e.contract_id = 'ash-wolf' AND c.item_id = 'burnt-hide' THEN 2
          WHEN e.contract_id = 'ash-wolf' AND c.item_id = 'charcoal' THEN 1
          WHEN e.contract_id = 'toll-robber' AND c.item_id = 'scrap-iron' THEN 2
          WHEN e.contract_id = 'toll-robber' AND c.item_id = 'cloth' THEN 1
          WHEN e.contract_id = 'drowned-dead' AND c.item_id = 'river-bone' THEN 2
          WHEN e.contract_id = 'drowned-dead' AND c.item_id = 'bitter-herb' THEN 2
          ELSE c.quantity
        END)
        FROM player_material_claims c
        JOIN player_expeditions e ON e.id = c.expedition_id
        WHERE c.user_id = player_inventory.user_id
          AND c.item_id = player_inventory.item_id
          AND c.quantity > CASE
            WHEN e.contract_id = 'ash-wolf' AND c.item_id = 'burnt-hide' THEN 2
            WHEN e.contract_id = 'ash-wolf' AND c.item_id = 'charcoal' THEN 1
            WHEN e.contract_id = 'toll-robber' AND c.item_id = 'scrap-iron' THEN 2
            WHEN e.contract_id = 'toll-robber' AND c.item_id = 'cloth' THEN 1
            WHEN e.contract_id = 'drowned-dead' AND c.item_id = 'river-bone' THEN 2
            WHEN e.contract_id = 'drowned-dead' AND c.item_id = 'bitter-herb' THEN 2
            ELSE c.quantity
          END
      ), 0))
      WHERE item_type = 'material';

      DELETE FROM player_inventory
      WHERE item_type = 'material' AND quantity <= 0;

      UPDATE player_material_claims
      SET quantity = CASE
        WHEN item_id = 'burnt-hide' AND expedition_id IN (
          SELECT id FROM player_expeditions WHERE contract_id = 'ash-wolf'
        ) THEN 2
        WHEN item_id = 'charcoal' AND expedition_id IN (
          SELECT id FROM player_expeditions WHERE contract_id = 'ash-wolf'
        ) THEN 1
        WHEN item_id = 'scrap-iron' AND expedition_id IN (
          SELECT id FROM player_expeditions WHERE contract_id = 'toll-robber'
        ) THEN 2
        WHEN item_id = 'cloth' AND expedition_id IN (
          SELECT id FROM player_expeditions WHERE contract_id = 'toll-robber'
        ) THEN 1
        WHEN item_id = 'river-bone' AND expedition_id IN (
          SELECT id FROM player_expeditions WHERE contract_id = 'drowned-dead'
        ) THEN 2
        WHEN item_id = 'bitter-herb' AND expedition_id IN (
          SELECT id FROM player_expeditions WHERE contract_id = 'drowned-dead'
        ) THEN 2
        ELSE quantity
      END;
    `)
  })
}
