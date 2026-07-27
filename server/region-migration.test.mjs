import test from 'node:test'
import assert from 'node:assert/strict'
import { PlayerStore } from './player-store.mjs'
import { RegionStore } from './region-store.mjs'
import { StoryStore } from './story-store.mjs'
import { GameStore } from './store.mjs'

test('migration 013 preserves an active legacy expedition', () => {
  const game = new GameStore(':memory:')
  const players = new PlayerStore(game)
  const stories = new StoryStore(game, players)
  try {
    const account = game.register({ username: 'legacy_region_migration', password: '12345678', displayName: 'Старый путник' })
    players.createCharacter(account.user.id, { requestId: 'legacy-region-create-0001', name: 'Старый путник', profession: 'hunter' })
    stories.publicStory(account.user.id)
    game.db.prepare("UPDATE player_story_state SET scene_id = 'tavern', chapter_complete = 1 WHERE user_id = ?").run(account.user.id)
    const before = players.startExpedition(account.user.id, { requestId: 'legacy-region-start-0001', contractId: 'ash-wolf' }).character.activeExpedition

    const regions = new RegionStore(game, players)
    const after = players.getCharacter(account.user.id).activeExpedition
    const stored = game.db.prepare('SELECT region_id, offer_id, distance, max_distance, enemy_health FROM player_expeditions WHERE id = ?').get(before.id)

    assert.equal(after.id, before.id)
    assert.equal(after.enemyName, before.enemyName)
    assert.equal(after.enemyHealth, before.enemyHealth)
    assert.equal(Boolean(after.positional), false)
    assert.equal(stored.region_id, 'ash-road')
    assert.equal(stored.offer_id, null)
    assert.equal(stored.distance, 1)
    assert.equal(stored.max_distance, 2)

    regions.createSchema()
    assert.equal(game.db.prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE id = '013_regions_and_positioning'").get().count, 1)
  } finally { game.close() }
})
