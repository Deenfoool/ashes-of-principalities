import { PlayerApiError } from './online-player'
import type { OnlineProfession } from './online-player'
import type { SurvivalCharacter } from './online-survival'

export interface CraftingSupply {
  id: string
  name: string
  quantity: number
  type: 'material' | 'consumable'
}

export interface CraftingIngredient {
  id: string
  name: string
  quantity: number
}

export interface CraftingRecipe {
  id: string
  title: string
  description: string
  professions: OnlineProfession[] | null
  minLevel: number
  ingredients: CraftingIngredient[]
  coins: number
  result: string
  available: boolean
  reason: string | null
}

export interface CraftingHistoryEntry {
  id: string
  recipeId: string
  result: string
  createdAt: number
}

export interface CraftingEffect {
  id: string
  charges: number
}

export interface CraftingWorkshop {
  character: SurvivalCharacter
  supplies: CraftingSupply[]
  recipes: CraftingRecipe[]
  history: CraftingHistoryEntry[]
  effects: CraftingEffect[]
  safe: boolean
  crafted?: { recipeId: string; result: string }
}

async function parseResponse<T>(response: Response): Promise<T> {
  let payload: unknown = null
  try { payload = await response.json() } catch { /* readable fallback below */ }
  if (!response.ok) {
    const error = payload as { error?: { code?: string; message?: string } } | null
    throw new PlayerApiError(
      error?.error?.code ?? 'request-failed',
      error?.error?.message ?? 'Сервер не смог выполнить ремесленное действие.',
      response.status,
    )
  }
  return payload as T
}

export async function getCraftingWorkshop() {
  const response = await fetch('/api/crafting', {
    credentials: 'same-origin',
    headers: { Accept: 'application/json' },
  })
  return parseResponse<CraftingWorkshop>(response)
}

export async function craftServerRecipe(recipeId: string) {
  const response = await fetch(`/api/crafting/${encodeURIComponent(recipeId)}`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ requestId: crypto.randomUUID().replaceAll('-', '') }),
  })
  return parseResponse<CraftingWorkshop>(response)
}
