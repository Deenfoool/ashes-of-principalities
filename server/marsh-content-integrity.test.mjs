import test from 'node:test'
import assert from 'node:assert/strict'
import { marshQuestIds, marshScenes } from './marsh-content.mjs'

test('Salt Marsh story graph has valid scenes, quests and encounters', () => {
  const choiceIds = new Set()
  for (const scene of Object.values(marshScenes)) {
    assert.equal(typeof scene.id, 'string')
    assert.equal(Array.isArray(scene.choices), true)
    for (const choice of scene.choices) {
      assert.equal(choiceIds.has(choice.id), false, `duplicate choice id: ${choice.id}`)
      choiceIds.add(choice.id)
      if (choice.nextSceneId) assert.ok(marshScenes[choice.nextSceneId], `missing scene: ${choice.nextSceneId}`)
      if (choice.startQuest) assert.equal(marshQuestIds.has(choice.startQuest), true)
      if (choice.completeQuest) assert.equal(marshQuestIds.has(choice.completeQuest.id), true)
      if (choice.encounter) {
        assert.equal(marshQuestIds.has(choice.encounter.questId), true)
        assert.ok(marshScenes[choice.encounter.victorySceneId])
        assert.ok(marshScenes[choice.encounter.fleeSceneId])
        assert.equal(choice.encounter.initialDistance >= 0, true)
        assert.equal(choice.encounter.maxDistance >= choice.encounter.initialDistance, true)
      }
    }
  }
  assert.equal(Object.keys(marshScenes).length, 12)
  assert.equal(choiceIds.size > 20, true)
})
