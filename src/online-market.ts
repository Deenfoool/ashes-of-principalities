import { PlayerApiError } from './online-player'
import type { SurvivalCharacter } from './online-survival'

export type MarketSort = 'newest' | 'price-asc' | 'price-desc' | 'quantity'
export type MarketType = 'all' | 'material' | 'consumable'

export interface MarketListing {
  id: string
  sellerName: string
  item: { id: string; name: string; type: string; quality: string }
  quantityTotal: number
  quantityRemaining: number
  unitPrice: number
  status: 'active' | 'sold' | 'cancelled' | 'expired'
  isMine: boolean
  createdAt: number
  updatedAt: number
  expiresAt: number
}
export interface MarketTrade {
  id: string
  listingId: string
  itemName: string
  quantity: number
  unitPrice: number
  gross: number
  fee: number
  sellerNet: number
  buyerName: string
  sellerName: string
  side: 'purchase' | 'sale'
  createdAt: number
}
export interface MarketSellableItem { id: string; name: string; quantity: number; type: string; quality: string }
export interface MarketSnapshot {
  character: SurvivalCharacter | null
  feePercent: number
  listingLifetimeHours: number
  pendingCoins: number
  pendingItems: number
  filters: { query: string; type: MarketType; sort: MarketSort }
  safe: boolean
  safeReason: string | null
  listings: MarketListing[]
  ownListings: MarketListing[]
  trades: MarketTrade[]
  sellable: MarketSellableItem[]
  purchase?: { listingId: string; itemName: string; quantity: number; gross: number; fee: number }
}

const STORAGE_PREFIX = 'ashes:market-request:'
const newRequestId = () => crypto.randomUUID().replaceAll('-', '')
const operationKey = (path: string, body: Record<string, unknown>) => `${STORAGE_PREFIX}${path}:${JSON.stringify(Object.entries(body).sort(([left], [right]) => left.localeCompare(right)))}`
function requestIdFor(path: string, body: Record<string, unknown>) {
  const key = operationKey(path, body)
  const existing = sessionStorage.getItem(key)
  if (existing) return { key, requestId: existing }
  const requestId = newRequestId()
  sessionStorage.setItem(key, requestId)
  return { key, requestId }
}
async function parse<T>(response: Response): Promise<T> {
  let payload: unknown = null
  try { payload = await response.json() } catch { /* readable fallback below */ }
  if (!response.ok) {
    const error = payload as { error?: { code?: string; message?: string } } | null
    throw new PlayerApiError(error?.error?.code ?? 'market-request-failed', error?.error?.message ?? 'Рынок не смог выполнить действие.', response.status)
  }
  return payload as T
}
async function post(path: string, body: Record<string, unknown> = {}) {
  const receipt = requestIdFor(path, body)
  let response: Response
  try {
    response = await fetch(path, {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ ...body, requestId: receipt.requestId }),
    })
  } catch (error) { throw error }
  sessionStorage.removeItem(receipt.key)
  return parse<MarketSnapshot>(response)
}

export const getMarket = async (filters: { query?: string; type?: MarketType; sort?: MarketSort } = {}) => {
  const params = new URLSearchParams()
  if (filters.query) params.set('q', filters.query)
  if (filters.type && filters.type !== 'all') params.set('type', filters.type)
  if (filters.sort && filters.sort !== 'newest') params.set('sort', filters.sort)
  const suffix = params.size > 0 ? `?${params}` : ''
  return parse<MarketSnapshot>(await fetch(`/api/market${suffix}`, { credentials: 'same-origin', headers: { Accept: 'application/json' } }))
}
export const createMarketListing = (itemId: string, quantity: number, unitPrice: number) => post('/api/market/listings', { itemId, quantity, unitPrice })
export const buyMarketListing = (listingId: string, quantity: number) => post(`/api/market/listings/${encodeURIComponent(listingId)}/buy`, { quantity })
export const cancelMarketListing = (listingId: string) => post(`/api/market/listings/${encodeURIComponent(listingId)}/cancel`)
