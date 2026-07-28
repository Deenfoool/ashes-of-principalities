import assert from 'node:assert/strict'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { findBrokenLegacyEncounterTriggers, installLegacyStoryFixes } from './legacy-story-fixes.mjs'

function createFixture() {
  const db = new DatabaseSync(':memory:')
  db.exec(`
    CREATE TABLE player_expeditions(id TEXT PRIMARY KEY);
    CREATE TABLE trigger_audit(value TEXT NOT NULL);

    CREATE TRIGGER trg_legacy_positional_encounter
    AFTER INSERT ON player_expeditions
    BEGIN
      INSERT INTO trigger_audit(value) SELECT positional;
    END;

    CREATE TRIGGER trg_valid_positional_label
    AFTER INSERT ON player_expeditions
    BEGIN
      INSERT INTO trigger_audit(value) VALUES ('positional');
    END;
  `)
  return db
}

test('finds a bare positional identifier but preserves string literals', () => {
  const db = createFixture()
  assert.deepEqual(
    findBrokenLegacyEncounterTriggers(db).map((trigger) => trigger.name),
    ['trg_legacy_positional_encounter'],
  )
  db.close()
})

test('removes the broken trigger and makes encounter inserts work again', () => {
  const db = createFixture()
  assert.throws(
    () => db.prepare('INSERT INTO player_expeditions(id) VALUES (?)').run('before-fix'),
    /no such column: positional/i,
  )

  const warnings = []
  const removed = installLegacyStoryFixes(db, { warn: (message) => warnings.push(message) })
  assert.deepEqual(removed, ['trg_legacy_positional_encounter'])
  assert.equal(warnings.length, 1)

  db.prepare('INSERT INTO player_expeditions(id) VALUES (?)').run('after-fix')
  assert.deepEqual(
    db.prepare('SELECT value FROM trigger_audit ORDER BY rowid').all().map((row) => row.value),
    ['positional'],
  )
  assert.deepEqual(installLegacyStoryFixes(db, { warn: () => assert.fail('second run must be silent') }), [])
  db.close()
})
