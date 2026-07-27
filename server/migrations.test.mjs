import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { applyMigration, ensureMigrationTable } from './migrations.mjs'

test('numbered migration is applied only once', () => {
  const db = new DatabaseSync(':memory:')
  try {
    let calls = 0
    const first = applyMigration(db, '001_once', () => {
      calls += 1
      db.exec('CREATE TABLE sample(id INTEGER PRIMARY KEY) STRICT;')
    })
    const second = applyMigration(db, '001_once', () => { calls += 1 })

    assert.equal(first, true)
    assert.equal(second, false)
    assert.equal(calls, 1)
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE id = '001_once'").get().count, 1)
  } finally {
    db.close()
  }
})

test('failed migration rolls back schema and is not recorded', () => {
  const db = new DatabaseSync(':memory:')
  try {
    ensureMigrationTable(db)
    assert.throws(() => applyMigration(db, '002_failure', () => {
      db.exec('CREATE TABLE unfinished(id INTEGER PRIMARY KEY) STRICT;')
      throw new Error('planned failure')
    }), /planned failure/)

    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE id = '002_failure'").get().count, 0)
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'unfinished'").get().count, 0)
  } finally {
    db.close()
  }
})
