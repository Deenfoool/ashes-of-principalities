import test from 'node:test'
import assert from 'node:assert/strict'
import { installMarshMigrations } from './marsh-migrations.mjs'
import { PlayerStore } from './player-store.mjs'
import { installRegionFixes } from './region-fixes.mjs'
import { RegionStore } from './region-store.mjs'
import { StoryStore } from './story-store.mjs'
import { SurvivalStore } from './survival-store.mjs'
import { GameStore } from './store.mjs'

test('0.12 migration preserves active 0.11 expedition and applies once', () => {
  const game = new GameStore(':memory:')
  try {
    const players = new PlayerStore(game)
    const stories = new StoryStore(game, players)
    new SurvivalStore(game, players)
    const regions = new RegionStore(game, players)
    installRegionFixes(game.db, regions)
    const account = game.register({ username: 'marsh_migration_user', password: '12345678', displayName: 'Старый путник' })
    const userId = account.user.id
    players.createCharacter(userId, { requestId: 'migration-create-0001', name: 'Старый путник', profession: 'hunter' })
    stories.publicStory(userId)
    game.db.prepare("UPDATE player_story_state SET chapter_complete = 1, scene_id = 'chapter-end' WHERE user_id = ?").run(userId)
    game.db.prepare('UPDATE player_characters SET stamina = 12, max_stamina = 12 WHERE user_id = ?').run(userId)
    const offer = regions.snapshot(userId).contracts[0]
    const started = players.startExpedition(userId, { requestId: 'migration-start-0001', contractId: offer.id })
    const before = game.db.prepare('SELECT id, enemy_id, enemy_health, distance FROM player_expeditions WHERE id = ?').get(started.character.activeExpedition.id)

    assert.equal(installMarshMigrations(game.db), true)
    assert.equal(installMarshMigrations(game.db), false)
    const after = game.db.prepare('SELECT id, enemy_id, enemy_health, distance FROM player_expeditions WHERE id = ?').get(before.id)
    assert.deepEqual(after, before)
    assert.ok(game.db.prepare("SELECT id FROM schema_migrations WHERE id = '014_salt_marsh_story_and_recovery'").get())
  } finally { game.close() }
})
