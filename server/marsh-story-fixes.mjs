import { StoreError } from './store.mjs'

const ENDING_CHOICES = new Set([
  'ending-salt-house',
  'ending-free-marsh',
  'ending-burn-ledgers',
])

export function installMarshStoryFixes(db, marshStories) {
  if (marshStories.__endingFixInstalled) return
  marshStories.__endingFixInstalled = true

  const originalPublicStory = marshStories.publicStory.bind(marshStories)
  marshStories.publicStory = (userId) => {
    const story = originalPublicStory(userId)
    if (!story?.chapterComplete || !story.scene?.choices) return story
    return {
      ...story,
      scene: {
        ...story.scene,
        choices: story.scene.choices.map((choice) => choice.id === 'marsh-council'
          ? {
              ...choice,
              available: false,
              requirement: 'Вторая глава уже завершена. Итог рода нельзя переписать.',
            }
          : choice),
      },
    }
  }

  const originalChoose = marshStories.choose.bind(marshStories)
  marshStories.choose = (userId, input) => {
    const state = db.prepare(`
      SELECT chapter_complete FROM player_marsh_story_state WHERE user_id = ?
    `).get(userId)
    const choiceId = String(input.choiceId ?? '')
    if (Number(state?.chapter_complete) && (choiceId === 'marsh-council' || ENDING_CHOICES.has(choiceId))) {
      throw new StoreError(
        'marsh-ending-locked',
        'Финальное решение Соляных топей уже принято и не может быть изменено.',
        409,
      )
    }
    return originalChoose(userId, input)
  }
}
