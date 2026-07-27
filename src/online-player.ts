export type OnlineProfession = 'blacksmith' | 'herbalist' | 'hunter' | 'scribe' | 'carter' | 'wanderer'
export type CombatAction = 'attack' | 'guard' | 'prepare' | 'profession' | 'flee' | 'advance' | 'retreat'
export type ExpeditionTactic = 'cover' | 'trap'

export interface ServerInventoryItem {
  id: string
  name: string
  quantity: number
}

export interface ServerTactic {
  id: ExpeditionTactic
  label: string
  available: boolean
  reason: string
}

export interface ServerExpedition {
  id: string
  contractId: string
  status: 'active' | 'won' | 'fled' | 'dead'
  turn: number
  enemyId: string
  enemyName: string
  enemyHealth: number
  enemyMaxHealth: number
  enemyIntent: 'attack' | 'heavy' | 'guard' | 'hex'
  guard: number
  prepared: boolean
  lastLog: string[]
  startedAt: number
  updatedAt: number
  positional?: boolean
  regionId?: string
  regionName?: string
  offerId?: string
  distance?: number
  maxDistance?: number
  terrainId?: string
  terrainName?: string
  complication?: string | null
  objective?: string | null
  enemyStyle?: 'melee' | 'ranged' | 'skirmisher'
  tactics?: ServerTactic[]
}

export interface ServerCharacter {
  userId: string
  name: string
  profession: OnlineProfession
  level: number
  experience: number
  experienceToNext: number
  maxHealth: number
  health: number
  maxStamina: number
  stamina: number
  insight: number
  reputation: number
  coins: number
  generation: number
  deaths: number
  legacyGlory: number
  completedContracts: number
  alive: boolean
  createdAt: number
  updatedAt: number
  inventory: ServerInventoryItem[]
  activeExpedition: ServerExpedition | null
}

export interface ServerContract {
  id: string
  title: string
  description: string
  enemyName: string
  enemyHealth: number
  difficulty: number
  rewardCoins: number
  rewardExperience: number
  regionId?: string
  regionName?: string
  terrainName?: string
  complication?: string
  objective?: string
  initialDistance?: number
  maxDistance?: number
  expiresAt?: number
  procedural?: boolean
}

export interface ServerRegion {
  id: string
  name: string
  description: string
  unlock: string
  unlocked: boolean
  unlockedAt: number | null
  victories: number
  requirement: string | null
}

export interface ContractRotation {
  contracts: ServerContract[]
  regions: ServerRegion[]
  rotationEndsAt: number | null
}

interface QueuedOperation {
  id: string
  path: string
  body: Record<string, unknown>
  createdAt: number
}

const QUEUE_KEY = 'ashes-of-principalities:offline-actions:v1'
const SEQUENTIAL_PATHS = new Set([
  '/api/player/expeditions',
  '/api/player/expeditions/action',
  '/api/player/expeditions/tactic',
])

export class PlayerApiError extends Error {
  code: string
  status: number

  constructor(code: string, message: string, status: number) {
    super(message)
    this.name = 'PlayerApiError'
    this.code = code
    this.status = status
  }
}

export class QueuedPlayerAction extends Error {
  constructor() {
    super('Действие сохранено и будет отправлено после восстановления связи.')
    this.name = 'QueuedPlayerAction'
  }
}

const newRequestId = () => crypto.randomUUID().replaceAll('-', '')

function readQueue(): QueuedOperation[] {
  try {
    const value = JSON.parse(localStorage.getItem(QUEUE_KEY) ?? '[]') as unknown
    return Array.isArray(value) ? value.filter((item): item is QueuedOperation => (
      Boolean(item)
      && typeof item === 'object'
      && typeof (item as QueuedOperation).id === 'string'
      && typeof (item as QueuedOperation).path === 'string'
    )) : []
  } catch {
    return []
  }
}

function writeQueue(queue: QueuedOperation[]) {
  localStorage.setItem(QUEUE_KEY, JSON.stringify(queue.slice(-40)))
}

async function parseResponse<T>(response: Response): Promise<T> {
  let payload: unknown = null
  try {
    payload = await response.json()
  } catch {
    // The fallback below keeps non-JSON server failures readable.
  }
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

async function get<T>(path: string): Promise<T> {
  const response = await fetch(path, { headers: { Accept: 'application/json' } })
  return parseResponse<T>(response)
}

async function post<T>(
  path: string,
  body: Record<string, unknown>,
  options: { queueOnNetworkFailure?: boolean } = {},
): Promise<T> {
  const requestId = typeof body.requestId === 'string' ? body.requestId : newRequestId()
  const payload = { ...body, requestId }
  try {
    const response = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(payload),
    })
    return await parseResponse<T>(response)
  } catch (error) {
    if (error instanceof PlayerApiError || options.queueOnNetworkFailure === false) throw error
    const queue = readQueue()
    if (SEQUENTIAL_PATHS.has(path) && queue.some((operation) => SEQUENTIAL_PATHS.has(operation.path))) {
      throw new QueuedPlayerAction()
    }
    if (!queue.some((operation) => operation.id === requestId)) {
      queue.push({ id: requestId, path, body: payload, createdAt: Date.now() })
      writeQueue(queue)
    }
    throw new QueuedPlayerAction()
  }
}

export async function flushPlayerActionQueue() {
  const queue = readQueue()
  let completed = 0
  for (const operation of queue) {
    try {
      const response = await fetch(operation.path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(operation.body),
      })
      if (response.status === 401) break
      if (response.ok || (response.status >= 400 && response.status < 500)) {
        completed += 1
        writeQueue(readQueue().filter((item) => item.id !== operation.id))
        continue
      }
      break
    } catch {
      break
    }
  }
  return completed
}

export const getServerCharacter = () => get<{ character: ServerCharacter | null }>('/api/player')
export const getServerContracts = () => get<ContractRotation>('/api/player/contracts')

export const createServerCharacter = (name: string, profession: OnlineProfession) =>
  post<{ character: ServerCharacter }>('/api/player', { name, profession }, { queueOnNetworkFailure: true })

export const startServerExpedition = (contractId: string) =>
  post<{ character: ServerCharacter }>('/api/player/expeditions', { contractId }, { queueOnNetworkFailure: true })

export const actInServerExpedition = (expeditionId: string, action: CombatAction) =>
  post<{ character: ServerCharacter }>('/api/player/expeditions/action', { expeditionId, action }, { queueOnNetworkFailure: true })

export const useExpeditionTactic = (expeditionId: string, tactic: ExpeditionTactic) =>
  post<{ character: ServerCharacter }>('/api/player/expeditions/tactic', { expeditionId, tactic }, { queueOnNetworkFailure: true })

export const restServerCharacter = () =>
  post<{ character: ServerCharacter }>('/api/player/rest', {}, { queueOnNetworkFailure: true })

export const createServerHeir = (name: string, profession: OnlineProfession) =>
  post<{ character: ServerCharacter }>('/api/player/heir', { name, profession }, { queueOnNetworkFailure: true })

export const donateServerCoins = (amount: number) =>
  post<{ character: ServerCharacter }>('/api/guilds/treasury/deposit', { amount }, { queueOnNetworkFailure: true })
