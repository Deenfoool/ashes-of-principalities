import type { ServerCharacter } from './online-player'
import { PlayerApiError, QueuedPlayerAction } from './online-player'

export interface ServerStoryChoice {
  id: string
  label: string
  available: boolean
  requirement: string | null
}

export interface ServerStoryQuest {
  id: 'taxman' | 'well' | 'beast'
  title: string
  summary: string
  status: 'available' | 'active' | 'completed'
  outcome: string | null
  startedAt: number | null
  completedAt: number | null
}

export interface ServerStory {
  generation: number
  scene: {
    id: string
    region: string
    title: string
    text: string
    choices: ServerStoryChoice[]
  }
  quests: ServerStoryQuest[]
  history: string[]
  flags: string[]
  decisionCount: number
  chapterComplete: boolean
  pendingEncounter: boolean
}

export interface ServerStorySnapshot {
  character: ServerCharacter | null
  story: ServerStory | null
}

interface StoryQueueItem {
  id: string
  choiceId: string
  createdAt: number
}

const STORY_QUEUE_KEY = 'ashes-of-principalities:offline-story-actions:v1'
const newRequestId = () => crypto.randomUUID().replaceAll('-', '')

function readQueue(): StoryQueueItem[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORY_QUEUE_KEY) ?? '[]') as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter((item): item is StoryQueueItem => Boolean(
      item && typeof item === 'object'
      && typeof (item as StoryQueueItem).id === 'string'
      && typeof (item as StoryQueueItem).choiceId === 'string',
    ))
  } catch {
    return []
  }
}

function writeQueue(items: StoryQueueItem[]) {
  localStorage.setItem(STORY_QUEUE_KEY, JSON.stringify(items.slice(-20)))
}

async function parseResponse<T>(response: Response): Promise<T> {
  let payload: unknown = null
  try { payload = await response.json() } catch { /* readable fallback below */ }
  if (!response.ok) {
    const error = payload as { error?: { code?: string; message?: string } } | null
    throw new PlayerApiError(
      error?.error?.code ?? 'request-failed',
      error?.error?.message ?? 'Сервер не смог выполнить сюжетное действие.',
      response.status,
    )
  }
  return payload as T
}

export async function getServerStory(): Promise<ServerStorySnapshot> {
  const response = await fetch('/api/story', { headers: { Accept: 'application/json' } })
  return parseResponse<ServerStorySnapshot>(response)
}

export async function chooseServerStory(choiceId: string): Promise<ServerStorySnapshot> {
  const requestId = newRequestId()
  try {
    const response = await fetch('/api/story/choose', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ choiceId, requestId }),
    })
    return await parseResponse<ServerStorySnapshot>(response)
  } catch (error) {
    if (error instanceof PlayerApiError) throw error
    const queue = readQueue()
    if (!queue.some((item) => item.id === requestId)) {
      queue.push({ id: requestId, choiceId, createdAt: Date.now() })
      writeQueue(queue)
    }
    throw new QueuedPlayerAction()
  }
}

export async function flushStoryActionQueue() {
  const queue = readQueue()
  let completed = 0
  for (const item of queue) {
    try {
      const response = await fetch('/api/story/choose', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ choiceId: item.choiceId, requestId: item.id }),
      })
      if (response.status === 401) break
      if (response.ok || (response.status >= 400 && response.status < 500)) {
        completed += 1
        writeQueue(readQueue().filter((queued) => queued.id !== item.id))
        continue
      }
      break
    } catch {
      break
    }
  }
  return completed
}
