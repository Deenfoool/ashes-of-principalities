import type { ExpeditionTactic } from './online-player'
import type { SurvivalCharacter } from './online-survival'
import { PlayerApiError, QueuedPlayerAction } from './online-player'

export interface RegionalBoss {
  id: string
  title: string
  description: string
  regionId: string
  difficulty: number
  recommendedLevel: number
  unlocked: boolean
  available: boolean
  requirement: string | null
  attempts: number
  victories: number
  cooldownEndsAt: number | null
  firstReward: string
  repeatReward: string
}

interface QueuedOperation {
  id: string
  path: string
  body: Record<string, unknown>
  createdAt: number
}

const PLAYER_QUEUE_KEY = 'ashes-of-principalities:offline-actions:v1'
const SEQUENTIAL_PATHS = new Set([
  '/api/player/expeditions',
  '/api/player/expeditions/action',
  '/api/player/expeditions/tactic',
])
const requestId = () => crypto.randomUUID().replaceAll('-', '')

function readQueue(): QueuedOperation[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(PLAYER_QUEUE_KEY) ?? '[]') as unknown
    return Array.isArray(parsed) ? parsed.filter((item): item is QueuedOperation => Boolean(
      item && typeof item === 'object'
      && typeof (item as QueuedOperation).id === 'string'
      && typeof (item as QueuedOperation).path === 'string',
    )) : []
  } catch {
    return []
  }
}

function writeQueue(queue: QueuedOperation[]) {
  localStorage.setItem(PLAYER_QUEUE_KEY, JSON.stringify(queue.slice(-40)))
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

export async function getRegionalBosses() {
  const response = await fetch('/api/bosses', {
    credentials: 'same-origin',
    headers: { Accept: 'application/json' },
  })
  return parse<{ bosses: RegionalBoss[] }>(response)
}

export async function startSaltBellWarden() {
  const response = await fetch('/api/bosses/salt-bell-warden/start', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ requestId: requestId() }),
  })
  return parse<{ character: SurvivalCharacter; boss: RegionalBoss }>(response)
}

export async function useTargetedExpeditionTactic(expeditionId: string, tactic: ExpeditionTactic, targetId?: string) {
  const path = '/api/player/expeditions/tactic'
  const id = requestId()
  const body = { expeditionId, tactic, targetId, requestId: id }
  try {
    const response = await fetch(path, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
    })
    return await parse<{ character: SurvivalCharacter }>(response)
  } catch (error) {
    if (error instanceof PlayerApiError) throw error
    const queue = readQueue()
    if (queue.some((operation) => SEQUENTIAL_PATHS.has(operation.path))) throw new QueuedPlayerAction()
    queue.push({ id, path, body, createdAt: Date.now() })
    writeQueue(queue)
    throw new QueuedPlayerAction()
  }
}
