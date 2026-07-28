import type { SurvivalCharacter } from './online-survival'
import { PlayerApiError } from './online-player'

export interface GuildResource {
  id: string
  name: string
  quantity: number
  reserved: number
  available: number
  updatedAt: number
}

export interface GuildResourceLogEntry {
  id: string
  operation: 'deposit' | 'withdraw' | 'reserve' | 'consume' | 'reward'
  itemId: string
  itemName: string
  quantity: number
  createdAt: number
  playerName: string
}

export interface GuildResourceSnapshot {
  stock: GuildResource[]
  log: GuildResourceLogEntry[]
  allowed: Array<{ id: string; name: string; owned: number }>
  canWithdraw: boolean
  total: number
}

export interface GuildLeadershipMember {
  id: string
  username: string
  displayName: string
  joinedAt: number
  lastActiveAt: number
  roleName: string
  rolePosition: number
  isLeader: boolean
}

export interface GuildLeadershipSnapshot {
  leaderId: string
  canTransfer: boolean
  inactivityDays: number
  successorActivityDays: number
  members: GuildLeadershipMember[]
  history: Array<{
    id: string
    reason: 'voluntary' | 'inactivity'
    createdAt: number
    previousLeaderName: string
    nextLeaderName: string
  }>
}

export interface GuildRaidRequirement {
  id: string
  name: string
  required: number
  quantity: number
  reserved: number
  available: number
  ready: boolean
}

export interface GuildRaidParticipant {
  userId: string
  playerName: string
  profession: string
  level: number
  joinedAt: number
  actions: number
  damage: number
  support: number
  rewardClaimed: boolean
  isSelf: boolean
}

export interface GuildRaidSnapshot {
  boss: {
    id: string
    title: string
    description: string
    status: 'preparing' | 'ready' | 'active' | 'won' | 'failed' | 'cooldown'
    health: number
    maxHealth: number
    shield: number
    maxShield: number
    morale: number
    maxMorale: number
    round: number
    intent: string
    attempts: number
    victories: number
    cooldownUntil: number | null
    maxActionsPerMember: number
  }
  requirements: GuildRaidRequirement[]
  participants: GuildRaidParticipant[]
  log: Array<{
    id: string
    type: string
    message: string
    round: number
    createdAt: number
    playerName: string | null
  }>
  permissions: {
    canPrepare: boolean
    canStart: boolean
    canJoin: boolean
    canAct: boolean
  }
  minimumParticipants: number
}

export interface GuildExpansionSnapshot {
  resources: GuildResourceSnapshot
  leadership: GuildLeadershipSnapshot
  raid: GuildRaidSnapshot
}

const requestId = () => crypto.randomUUID().replaceAll('-', '')

async function parse<T>(response: Response): Promise<T> {
  let payload: unknown = null
  try { payload = await response.json() } catch { /* readable fallback below */ }
  if (!response.ok) {
    const error = payload as { error?: { code?: string; message?: string } } | null
    throw new PlayerApiError(
      error?.error?.code ?? 'request-failed',
      error?.error?.message ?? 'Сервер не смог выполнить действие гильдии.',
      response.status,
    )
  }
  return payload as T
}

async function post<T>(path: string, body: Record<string, unknown> = {}) {
  if (!navigator.onLine) throw new PlayerApiError('online-required', 'Для общей казны и рейда требуется соединение с сервером.', 503)
  const response = await fetch(path, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ ...body, requestId: requestId() }),
  })
  return parse<T>(response)
}

export async function getGuildExpansion() {
  const response = await fetch('/api/guilds/expansion', {
    credentials: 'same-origin',
    headers: { Accept: 'application/json' },
  })
  return parse<GuildExpansionSnapshot>(response)
}

export const depositGuildResource = (itemId: string, quantity: number) =>
  post<{ character: SurvivalCharacter; resources: GuildResourceSnapshot }>('/api/guilds/resources/deposit', { itemId, quantity })

export const withdrawGuildResource = (itemId: string, quantity: number) =>
  post<{ character: SurvivalCharacter; resources: GuildResourceSnapshot }>('/api/guilds/resources/withdraw', { itemId, quantity })

export const transferGuildLeadership = (targetUserId: string) =>
  post<{ leadership: GuildLeadershipSnapshot }>('/api/guilds/leadership/transfer', { targetUserId })

export const prepareGuildRaid = () =>
  post<{ raid: GuildRaidSnapshot; resources: GuildResourceSnapshot }>('/api/guilds/raid/prepare')

export const joinGuildRaid = () =>
  post<{ character: SurvivalCharacter; raid: GuildRaidSnapshot }>('/api/guilds/raid/join')

export const startGuildRaid = () =>
  post<{ raid: GuildRaidSnapshot; resources: GuildResourceSnapshot }>('/api/guilds/raid/start')

export const actInGuildRaid = (action: 'assault' | 'guard' | 'profession') =>
  post<{ character: SurvivalCharacter; raid: GuildRaidSnapshot }>('/api/guilds/raid/action', { action })
