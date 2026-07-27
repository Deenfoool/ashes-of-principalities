import type { SurvivalCharacter } from './online-survival'
import { PlayerApiError, QueuedPlayerAction } from './online-player'

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

interface MarshQueueItem {
  id: string
  choiceId: string
  createdAt: number
}

const QUEUE_KEY = 'ashes-of-principalities:offline-marsh-story-actions:v1'
const newRequestId = () => crypto.randomUUID().replaceAll('-', '')

function readQueue(): MarshQueueItem[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(QUEUE_KEY) ?? '[]') as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter((item): item is MarshQueueItem => Boolean(
      item && typeof item === 'object'
      && typeof (item as MarshQueueItem).id === 'string'
      && typeof (item as MarshQueueItem).choiceId === 'string',
    ))
  } catch {
    return []
  }
}

function writeQueue(items: MarshQueueItem[]) {
  localStorage.setItem(QUEUE_KEY, JSON.stringify(items.slice(-12)))
}

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
  const requestId = newRequestId()
  try {
    const response = await fetch('/api/marsh-story', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ choiceId, requestId }),
    })
    return await parse<{ character: SurvivalCharacter; marshStory: MarshStory }>(response)
  } catch (error) {
    if (error instanceof PlayerApiError) throw error
    const queue = readQueue()
    if (queue.length > 0) {
      throw new PlayerApiError(
        'marsh-story-sync-pending',
        'Предыдущее решение второй главы ещё ждёт связи с сервером.',
        409,
      )
    }
    queue.push({ id: requestId, choiceId, createdAt: Date.now() })
    writeQueue(queue)
    throw new QueuedPlayerAction()
  }
}

export async function flushMarshStoryActionQueue() {
  const queue = readQueue()
  let processed = 0
  for (const item of queue) {
    try {
      const response = await fetch('/api/marsh-story', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ choiceId: item.choiceId, requestId: item.id }),
      })
      if (response.status === 401) break
      if (response.ok || (response.status >= 400 && response.status < 500)) {
        processed += 1
        writeQueue(readQueue().filter((queued) => queued.id !== item.id))
        continue
      }
      break
    } catch {
      break
    }
  }
  return processed
}
