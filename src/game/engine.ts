import { professionById, scenes } from './content'
import type { Choice, GameState, ProfessionId, StatKey } from './types'

const SAVE_KEY = 'ashes-of-principalities:save:v1'
const MAX_STAT = 12

const clampStat = (key: StatKey, value: number) => {
  if (key === 'coins') return Math.max(0, value)
  return Math.max(0, Math.min(MAX_STAT, value))
}

export function createGame(professionId: ProfessionId): GameState {
  const profession = professionById[professionId]
  const base: Record<StatKey, number> = {
    health: 8,
    stamina: 8,
    insight: 3,
    coins: 3,
  }

  for (const [key, value] of Object.entries(profession.stats)) {
    const stat = key as StatKey
    base[stat] = clampStat(stat, base[stat] + (value ?? 0))
  }

  return {
    version: 1,
    professionId,
    sceneId: 'crossroads',
    health: base.health,
    stamina: base.stamina,
    insight: base.insight,
    coins: base.coins,
    inventory: [profession.startingItem, 'Сухой паёк'],
    day: 1,
    hour: 18,
    history: [`Путь начат. Ремесло: ${profession.name}.`],
  }
}

export function canChoose(state: GameState, choice: Choice) {
  return !choice.requiresProfession || choice.requiresProfession === state.professionId
}

export function applyChoice(state: GameState, choice: Choice): GameState {
  const next = { ...state, inventory: [...state.inventory], history: [...state.history] }

  if (choice.effects) {
    for (const [key, value] of Object.entries(choice.effects)) {
      const stat = key as StatKey
      next[stat] = clampStat(stat, next[stat] + (value ?? 0))
    }
  }

  if (choice.item && !next.inventory.includes(choice.item)) {
    next.inventory.push(choice.item)
  }

  next.hour += 1
  if (next.hour >= 24) {
    next.day += Math.floor(next.hour / 24)
    next.hour %= 24
  }

  next.sceneId = choice.nextSceneId
  next.history.unshift(choice.consequence)
  next.history = next.history.slice(0, 12)
  return next
}

export function getScene(state: GameState) {
  return scenes[state.sceneId] ?? scenes.crossroads
}

export function saveGame(state: GameState) {
  localStorage.setItem(SAVE_KEY, JSON.stringify(state))
}

export function loadGame(): GameState | null {
  try {
    const raw = localStorage.getItem(SAVE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as GameState
    if (parsed.version !== 1 || !professionById[parsed.professionId] || !scenes[parsed.sceneId]) {
      return null
    }
    return parsed
  } catch {
    return null
  }
}

export function clearGame() {
  localStorage.removeItem(SAVE_KEY)
}
