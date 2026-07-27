import { PlayerApiError } from './online-player'
import type { OnlineProfession } from './online-player'
import type { SurvivalCharacter } from './online-survival'

export interface CommissionRecipe {
  id: string
  title: string
  description: string
  profession: OnlineProfession
  ingredients: Array<{ id: string; quantity: number }>
  output: { id: string; name: string; type: string; quality: string; quantity: number }
  baseReward: number
}
export interface CommissionOrder {
  id: string
  requesterName: string
  targetName: string | null
  fulfillerName: string | null
  recipe: { id: string; title: string; profession: OnlineProfession; ingredients: Array<{ id: string; quantity: number }> }
  batches: number
  output: { id: string; name: string; type: string; quality: string; quantity: number }
  rewardCoins: number
  feeCoins: number
  status: 'open' | 'fulfilled' | 'cancelled' | 'expired'
  isMine: boolean
  canFulfill: boolean
  fulfillReason: string | null
  createdAt: number
  expiresAt: number
  closedAt: number | null
}
export interface CommissionSnapshot {
  character: SurvivalCharacter | null
  catalog: CommissionRecipe[]
  feePercent: number
  lifetimeHours: number
  filters: { query: string; profession: OnlineProfession | 'all' }
  safe: boolean
  safeReason: string | null
  available: CommissionOrder[]
  mine: CommissionOrder[]
  fulfilled: CommissionOrder[]
  fulfillment?: { orderId: string; itemName: string; quantity: number; rewardCoins: number; feeCoins: number }
}

const STORAGE_PREFIX = 'ashes:commission-request:'
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
    throw new PlayerApiError(error?.error?.code ?? 'commission-request-failed', error?.error?.message ?? 'Доска заказов не смогла выполнить действие.', response.status)
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
  return parse<CommissionSnapshot>(response)
}

export const getCommissions = async (filters: { query?: string; profession?: OnlineProfession | 'all' } = {}) => {
  const params = new URLSearchParams()
  if (filters.query) params.set('q', filters.query)
  if (filters.profession && filters.profession !== 'all') params.set('profession', filters.profession)
  const suffix = params.size > 0 ? `?${params}` : ''
  return parse<CommissionSnapshot>(await fetch(`/api/commissions${suffix}`, { credentials: 'same-origin', headers: { Accept: 'application/json' } }))
}
export const createCommission = (recipeId: string, batches: number, rewardCoins: number, targetUsername: string) => post('/api/commissions', { recipeId, batches, rewardCoins, targetUsername })
export const fulfillCommission = (orderId: string) => post(`/api/commissions/${encodeURIComponent(orderId)}/fulfill`)
export const cancelCommission = (orderId: string) => post(`/api/commissions/${encodeURIComponent(orderId)}/cancel`)
