import { applyMigration } from './migrations.mjs'

export function installUniqueItemFixes(db, artifacts) {
  applyMigration(db, '012_unique_item_relisting', () => {
    db.exec(`
      ALTER TABLE unique_item_trades RENAME TO unique_item_trades_011;
      ALTER TABLE unique_item_listings RENAME TO unique_item_listings_011;

      CREATE TABLE unique_item_listings (
        id TEXT PRIMARY KEY,
        item_id TEXT NOT NULL REFERENCES unique_items(id) ON DELETE CASCADE,
        seller_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        unit_price INTEGER NOT NULL CHECK(unit_price > 0),
        status TEXT NOT NULL CHECK(status IN ('active', 'sold', 'cancelled', 'expired')),
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        closed_at INTEGER
      ) STRICT;

      CREATE TABLE unique_item_trades (
        id TEXT PRIMARY KEY,
        listing_id TEXT NOT NULL REFERENCES unique_item_listings(id),
        item_id TEXT NOT NULL REFERENCES unique_items(id),
        seller_id TEXT NOT NULL REFERENCES users(id),
        buyer_id TEXT NOT NULL REFERENCES users(id),
        gross INTEGER NOT NULL CHECK(gross > 0),
        fee INTEGER NOT NULL CHECK(fee >= 0),
        seller_net INTEGER NOT NULL CHECK(seller_net >= 0),
        created_at INTEGER NOT NULL
      ) STRICT;

      INSERT INTO unique_item_listings(id, item_id, seller_id, unit_price, status, created_at, expires_at, closed_at)
      SELECT id, item_id, seller_id, unit_price, status, created_at, expires_at, closed_at
      FROM unique_item_listings_011;

      INSERT INTO unique_item_trades(id, listing_id, item_id, seller_id, buyer_id, gross, fee, seller_net, created_at)
      SELECT id, listing_id, item_id, seller_id, buyer_id, gross, fee, seller_net, created_at
      FROM unique_item_trades_011;

      DROP TABLE unique_item_trades_011;
      DROP TABLE unique_item_listings_011;

      CREATE INDEX idx_unique_listings_active ON unique_item_listings(status, created_at DESC);
      CREATE INDEX idx_unique_listings_expiry ON unique_item_listings(status, expires_at);
      CREATE UNIQUE INDEX idx_unique_one_active_listing ON unique_item_listings(item_id) WHERE status = 'active';
      CREATE INDEX idx_unique_trades_user ON unique_item_trades(seller_id, buyer_id, created_at DESC);
    `)
  })

  const originalExpire = artifacts.expireListings.bind(artifacts)
  const isTransactionOpen = () => Boolean(db.isTransaction)
  artifacts.expireListings = (now = Date.now()) => isTransactionOpen() ? 0 : originalExpire(now)

  for (const method of ['createListing', 'buyListing', 'cancelListing']) {
    const original = artifacts[method].bind(artifacts)
    artifacts[method] = (...args) => {
      originalExpire()
      return original(...args)
    }
  }
}
