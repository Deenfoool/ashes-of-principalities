import { PlayerApiError } from './online-player'
import type { SurvivalCharacter } from './online-survival'

export interface MarketListing {
  id: string
  sellerName: string
  item: {
    id: string
    name: string
    type: string
    quality: string
  }
  quantityTotal: number
  quantityRemaining: number
  unitPrice: number
  status: 'active' | 'sold' | 'cancelled'
  isMine: boolean
  createdAt: number
  updatedAt: number
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

export interface MarketSellableItem {
  id: string
  name: string
  quantity: number
  type: string
  quality: string
}

export interface MarketSnapshot {
  character: SurvivalCharacter | null
  feePercent: number
  pendingCoins: number
  safe: boolean
  safeReason: string | null
  listings: MarketListing[]
  ownListings: MarketListing[]
  trades: MarketTrade[]
  sellable: MarketSellableItem[]
  purchase?: {
    listingId: string
    itemName: string
    quantity: number
    gross: number
    fee: number
  }
}

const requestId = () => crypto.randomUUID().replaceAll('-', '')

async function parse<T>(response: Response): Promise<T> {
  let payload: unknown = null
  try { payload = await response.json() } catch { /* readable fallback below */ }
  if (!response.ok) {
    const error = payload as { error?: { code?: string; message?: string } } | null
    throw new PlayerApiError(
      error?.error?.code ?? 'market-request-failed',
      error?.error?.message ?? 'Рынок не смог выполнить действие.',
      response.status,
    )
  }
  return payload as T
}

async function post(path: string, body: Record<string, unknown> = {}) {
  return parse<MarketSnapshot>(await fetch(path, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ ...body, requestId: requestId() }),
  }))
}

export const getMarket = async () => parse<MarketSnapshot>(await fetch('/api/market', {
  credentials: 'same-origin',
  headers: { Accept: 'application/json' },
}))

export const createMarketListing = (itemId: string, quantity: number, unitPrice: number) =>
  post('/api/market/listings', { itemId, quantity, unitPrice })

export const buyMarketListing = (listingId: string, quantity: number) =>
  post(`/api/market/listings/${encodeURIComponent(listingId)}/buy`, { quantity })

export const cancelMarketListing = (listingId: string) =>
  post(`/api/market/listings/${encodeURIComponent(listingId)}/cancel`)
