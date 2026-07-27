import type { OnlineGuild } from './online'
import type { ServerCharacter } from './online-player'
import { PlayerApiError } from './online-player'

export type ItemQuality = 'worn' | 'common' | 'good' | 'masterwork'

export interface SurvivalItem {
  id: string
  templateId?: string
  name: string
  quantity: number
  type: 'tool' | 'weapon' | 'armor' | 'material' | 'quest' | 'relic' | string
  quality: ItemQuality
  durability: number
  maxDurability: number
  equipped: boolean
  repairCount: number
  broken: boolean
  unique?: boolean
  serialNumber?: number
  serial?: string
  makerName?: string | null
  originType?: string
  originDetail?: string
  tradeCount?: number
  tradable?: boolean
  createdAt?: number
  updatedAt?: number
}

export interface SurvivalInjury {
  id: string
  kind: 'wounded-arm' | 'sprained-ankle' | string
  title: string
  severity: number
  status: 'active' | 'treated'
  source: string
  createdAt: number
}

export type SurvivalCharacter = Omit<ServerCharacter, 'inventory'> & {
  inventory: SurvivalItem[]
  injuries: SurvivalInjury[]
  equippedItem: SurvivalItem | null
  combatModifiers: {
    attackStaminaPenalty: number
    fleeStaminaPenalty: number
  }
}

const requestId = () => crypto.randomUUID().replaceAll('-', '')

async function post<T>(path: string, body: Record<string, unknown> = {}): Promise<T> {
  const response = await fetch(path, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ ...body, requestId: requestId() }),
  })
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

export const repairServerItem = (itemId: string) =>
  post<{ character: SurvivalCharacter; cost: number }>(`/api/player/items/${encodeURIComponent(itemId)}/repair`)

export const equipServerItem = (itemId: string) =>
  post<{ character: SurvivalCharacter }>(`/api/player/items/${encodeURIComponent(itemId)}/equip`)

export const treatServerInjury = (injuryId: string) =>
  post<{ character: SurvivalCharacter; cost: number }>(`/api/player/injuries/${encodeURIComponent(injuryId)}/treat`)

export const createPaidServerGuild = (name: string, tag: string) =>
  post<{ guild: OnlineGuild; character: SurvivalCharacter }>('/api/guilds', { name, tag })
