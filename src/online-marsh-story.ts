import type { SurvivalCharacter } from './online-survival'
import { PlayerApiError } from './online-player'

export interface MarshChoice {
  id: string
  label: string
  available: boolean
  requirement: string | null
}

export interface MarshQuest {
  id: string
  title: string
  summary: string
  status: 'available' | 'active' | 'completed'
  outcome: string | null
  startedAt: number | null
  completedAt: number | null
}

export interface MarshStory {
  available: boolean
  unlocked: boolean
  generation?: number
  started: boolean
  chapterComplete: boolean
  ending?: string | null
  decisionCount?: number
  pendingEncounter?: boolean
  scene?: {
    id: string
    region: string
    title: string
    text: string
    choices: MarshChoice[]
  }
  quests?: MarshQuest[]
  history?: string[]
  flags?: string[]
}

const requestId = () => crypto.randomUUID().replaceAll('-', '')

async function parse<T>(response: Response): Promise<T> {
  let payload: unknown = null
  try { payload = await response.json() } catch { /* readable fallback below */ }
  if (!response.ok) {
    const error = payload as { error?: { code?: string; message?: string } } | null
    throw new PlayerApiError(
      error?.error?.code ?? 'request-failed',
      error?.error?.message ?? 'Сервер не смог выполнить действие.',
      response.status,
    )
  }
  return payload as T
}

export async function getMarshStory() {
  const response = await fetch('/api/marsh-story', {
    credentials: 'same-origin',
    headers: { Accept: 'application/json' },
  })
  return parse<{ marshStory: MarshStory }>(response)
}

export async function chooseMarshStory(choiceId: string) {
  const response = await fetch('/api/marsh-story', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ choiceId, requestId: requestId() }),
  })
  return parse<{ character: SurvivalCharacter; marshStory: MarshStory }>(response)
}
