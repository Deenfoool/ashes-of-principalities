export function ensureMigrationTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at INTEGER NOT NULL
    ) STRICT;
  `)
}

export function applyMigration(db, id, migrate) {
  ensureMigrationTable(db)
  if (db.prepare('SELECT id FROM schema_migrations WHERE id = ?').get(id)) return false
  db.exec('BEGIN IMMEDIATE')
  try {
    migrate()
    db.prepare('INSERT INTO schema_migrations(id, applied_at) VALUES (?, ?)').run(id, Date.now())
    db.exec('COMMIT')
    return true
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}
