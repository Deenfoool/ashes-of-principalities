import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { installMarshStoryFixes } from './marsh-story-fixes.mjs'

function setup() {
  const db = new DatabaseSync(':memory:')
  db.exec(`
    CREATE TABLE player_story_state(user_id TEXT PRIMARY KEY, chapter_complete INTEGER NOT NULL);
    CREATE TABLE player_marsh_story_state(user_id TEXT PRIMARY KEY, chapter_complete INTEGER NOT NULL);
    CREATE TABLE player_action_receipts(
      user_id TEXT NOT NULL,
      request_id TEXT NOT NULL,
      action TEXT NOT NULL,
      result_json TEXT NOT NULL,
      PRIMARY KEY(user_id, request_id)
    );
  `)
  db.prepare('INSERT INTO player_story_state VALUES (?, 1)').run('user')
  db.prepare('INSERT INTO player_marsh_story_state VALUES (?, 1)').run('user')
  const marshStories = {
    isUnlocked: () => true,
    publicStory: () => ({
      chapterComplete: true,
      scene: { choices: [{ id: 'marsh-council', available: true, requirement: null }] },
    }),
    choose: () => { throw new Error('original choose must not run for a confirmed receipt') },
  }
  installMarshStoryFixes(db, marshStories)
  return { db, marshStories }
}

test('confirmed ending request is replayed before ending lock', () => {
  const { db, marshStories } = setup()
  try {
    const result = { character: { coins: 42 }, marshStory: { ending: 'free-marsh' } }
    db.prepare(`
      INSERT INTO player_action_receipts(user_id, request_id, action, result_json)
      VALUES (?, ?, ?, ?)
    `).run('user', 'ending-request-0001', 'marsh-story:ending-free-marsh', JSON.stringify(result))
    assert.deepEqual(marshStories.choose('user', {
      requestId: 'ending-request-0001',
      choiceId: 'ending-free-marsh',
    }), result)
  } finally { db.close() }
})

test('new ending request remains blocked after chapter completion', () => {
  const { db, marshStories } = setup()
  try {
    assert.throws(
      () => marshStories.choose('user', { requestId: 'ending-request-0002', choiceId: 'ending-free-marsh' }),
      (error) => error?.code === 'marsh-ending-locked',
    )
    const council = marshStories.publicStory('user').scene.choices[0]
    assert.equal(council.available, false)
  } finally { db.close() }
})
