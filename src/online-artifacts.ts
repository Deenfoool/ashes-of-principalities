import { PlayerApiError } from './online-player'
import type { OnlineProfession } from './online-player'
import type { SurvivalCharacter, SurvivalItem } from './online-survival'

export type ArtifactItem = SurvivalItem & {
  unique: true
  templateId: string
  serialNumber: number
  serial: string
  makerName: string | null
  originType: string
  originDetail: string
  tradeCount: number
  tradable: boolean
  createdAt: number
  updatedAt: number
}

export interface ArtifactBlueprint {
  id: string
  profession: OnlineProfession
  name: string
  description: string
  templateId: string
  type: 'tool' | 'weapon' | 'armor'
  quality: 'good' | 'masterwork'
  durability: number
  ingredients: Record<string, number>
  coins: number
  available: boolean
  reason: string | null
}

export interface ArtifactListing {
  id: string
  item: ArtifactItem
  sellerName: string
  sellerId: string
  unitPrice: number
  status: 'active' | 'sold' | 'cancelled' | 'expired'
  isMine: boolean
  createdAt: number
  expiresAt: number
  closedAt: number | null
}

export interface ArtifactTrade {
  id: string
  itemName: string
  sellerName: string
  buyerName: string
  side: 'purchase' | 'sale'
  gross: number
  fee: number
  sellerNet: number
  createdAt: number
}

export interface MasterRank {
  rank: number
  name: string
  profession: OnlineProfession
  reputation: number
  crafted: number
  fulfilled: number
  score: number
}

export interface ArtifactSnapshot {
  character: SurvivalCharacter | null
  safe: boolean
  safeReason: string | null
  listingLifetimeHours: number
  blueprints: ArtifactBlueprint[]
  owned: ArtifactItem[]
  listings: ArtifactListing[]
  ownListings: ArtifactListing[]
  trades: ArtifactTrade[]
  leaderboard: MasterRank[]
  forged?: ArtifactItem
  purchase?: { listingId: string; itemId: string; gross: number; fee: number }
}

const STORAGE_PREFIX = 'ashes:artifact-request:'
const requestId = () => crypto.randomUUID().replaceAll('-', '')
const operationKey = (path: string, body: Record<string, unknown>) =>
  `${STORAGE_PREFIX}${path}:${JSON.stringify(Object.entries(body).sort(([left], [right]) => left.localeCompare(right)))}`

function receipt(path: string, body: Record<string, unknown>) {
  const key = operationKey(path, body)
  const stored = sessionStorage.getItem(key)
  if (stored) return { key, id: stored }
  const id = requestId()
  sessionStorage.setItem(key, id)
  return { key, id }
}

async function parse(response: Response): Promise<ArtifactSnapshot> {
  let payload: unknown = null
  try { payload = await response.json() } catch { /* readable fallback below */ }
  if (!response.ok) {
    const error = payload as { error?: { code?: string; message?: string } } | null
    throw new PlayerApiError(
      error?.error?.code ?? 'artifact-request-failed',
      error?.error?.message ?? 'Сервер не смог выполнить действие с предметом.',
      response.status,
    )
  }
  return payload as ArtifactSnapshot
}

async function post(path: string, body: Record<string, unknown> = {}) {
  const current = receipt(path, body)
  const response = await fetch(path, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ ...body, requestId: current.id }),
  })
  sessionStorage.removeItem(current.key)
  return parse(response)
}

export const getArtifacts = () => fetch('/api/artifacts', {
  credentials: 'same-origin',
  headers: { Accept: 'application/json' },
}).then(parse)

export const forgeArtifact = (blueprintId: string) =>
  post(`/api/artifacts/blueprints/${encodeURIComponent(blueprintId)}/forge`)

export const listArtifact = (itemId: string, unitPrice: number) =>
  post(`/api/artifacts/items/${encodeURIComponent(itemId)}/list`, { unitPrice })

export const buyArtifact = (listingId: string) =>
  post(`/api/artifacts/listings/${encodeURIComponent(listingId)}/buy`)

export const cancelArtifactListing = (listingId: string) =>
  post(`/api/artifacts/listings/${encodeURIComponent(listingId)}/cancel`)
