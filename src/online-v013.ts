import type { ExpeditionTactic } from './online-player'
import type { SurvivalCharacter } from './online-survival'
import { PlayerApiError } from './online-player'

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

const requestId = () => crypto.randomUUID().replaceAll('-', '')

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
  const response = await fetch('/api/player/expeditions/tactic', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ expeditionId, tactic, targetId, requestId: requestId() }),
  })
  return parse<{ character: SurvivalCharacter }>(response)
}
