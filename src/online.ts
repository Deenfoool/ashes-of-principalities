import type { GuildBranchId } from './game/types'

const ACCOUNT_HINT_KEY = 'ashes-of-principalities:online-account:v1'

export interface OnlineUser {
  id: string
  username: string
  displayName: string
  createdAt: number
}

export interface OnlineGuildTask {
  id: 'contracts' | 'victories' | 'donations'
  title: string
  current: number
  target: number
  reward: number
  completed: boolean
}

export interface OnlineGuild {
  id: string
  name: string
  tag: string
  level: number
  experience: number
  treePoints: number
  treasuryCoins: number
  treasuryResources: number
  joinedAt: number
  memberCount: number
  role: {
    id: string
    name: string
    permissions: {
      invite: boolean
      kick: boolean
      treasury: boolean
      tree: boolean
      roles: boolean
    }
  }
  branches: Record<GuildBranchId, number>
  tasks: OnlineGuildTask[]
  seasonKey: string
  lastTreeResetSeason: string | null
}

export interface OnlineInvite {
  id: string
  guildId: string
  guildName: string
  guildTag: string
  inviterName: string
  createdAt: number
  expiresAt: number
}

export interface OnlineSnapshot {
  user: OnlineUser
  guild: OnlineGuild | null
  invites: OnlineInvite[]
}

export interface OnlineRole {
  id: string
  name: string
  position: number
  canInvite: boolean
  canKick: boolean
  canUseTreasury: boolean
  canManageTree: boolean
  canManageRoles: boolean
}

export interface TreasuryEntry {
  id: string
  operation: string
  amount: number
  createdAt: number
  playerName: string
}

export interface OnlineMember {
  id: string
  username: string
  displayName: string
  joinedAt: number
  roleId: string
  roleName: string
  rolePosition: number
  isLeader: boolean
}

export class OnlineError extends Error {
  code: string
  status: number

  constructor(code: string, message: string, status: number) {
    super(message)
    this.name = 'OnlineError'
    this.code = code
    this.status = status
  }
}

// Session secrets live only in an HttpOnly cookie. This function remains for the
// chat hello packet API, but deliberately never exposes the cookie to JavaScript.
export const getOnlineToken = () => null
export const hasOnlineToken = () => localStorage.getItem(ACCOUNT_HINT_KEY) === '1'

const setAccountHint = (enabled: boolean) => {
  if (enabled) localStorage.setItem(ACCOUNT_HINT_KEY, '1')
  else localStorage.removeItem(ACCOUNT_HINT_KEY)
}

async function api<T>(path: string, options: { method?: string; body?: unknown; auth?: boolean } = {}): Promise<T> {
  const response = await fetch(path, {
    method: options.method ?? 'GET',
    credentials: 'same-origin',
    headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined,
  })

  let payload: unknown = null
  try {
    payload = await response.json()
  } catch {
    // Non-JSON errors still become a readable network error.
  }

  if (!response.ok) {
    const error = payload as { error?: { code?: string; message?: string } } | null
    if (response.status === 401) setAccountHint(false)
    throw new OnlineError(
      error?.error?.code ?? 'request-failed',
      error?.error?.message ?? 'Сервер не смог выполнить запрос.',
      response.status,
    )
  }
  return payload as T
}

export async function registerOnline(input: { username: string; password: string; displayName: string }) {
  const result = await api<{ user: OnlineUser }>('/api/auth/register', { method: 'POST', body: input, auth: false })
  setAccountHint(true)
  return result.user
}

export async function loginOnline(input: { username: string; password: string }) {
  const result = await api<{ user: OnlineUser }>('/api/auth/login', { method: 'POST', body: input, auth: false })
  setAccountHint(true)
  return result.user
}

export async function logoutOnline() {
  try {
    await api('/api/auth/logout', { method: 'POST' })
  } finally {
    setAccountHint(false)
  }
}

export const fetchOnlineSnapshot = () => api<OnlineSnapshot>('/api/online')

export async function createOnlineGuild(name: string, tag: string) {
  const result = await api<{ guild: OnlineGuild }>('/api/guilds', { method: 'POST', body: { name, tag } })
  return result.guild
}

export async function inviteOnlinePlayer(username: string) {
  return api<{ invite: { id: string; inviteeName: string } }>('/api/guilds/invites', { method: 'POST', body: { username } })
}

export async function acceptOnlineInvite(inviteId: string) {
  const result = await api<{ guild: OnlineGuild }>(`/api/guilds/invites/${encodeURIComponent(inviteId)}/accept`, { method: 'POST' })
  return result.guild
}

export async function depositOnlineGuildCoins(amount: number) {
  const result = await api<{ guild: OnlineGuild }>('/api/guilds/treasury/deposit', { method: 'POST', body: { amount } })
  return result.guild
}

export async function upgradeOnlineGuildBranch(branch: GuildBranchId) {
  const result = await api<{ guild: OnlineGuild }>('/api/guilds/tree/upgrade', { method: 'POST', body: { branch } })
  return result.guild
}

export async function resetOnlineGuildTree() {
  const result = await api<{ guild: OnlineGuild }>('/api/guilds/tree/reset', { method: 'POST' })
  return result.guild
}

export async function progressOnlineGuildTask(taskId: 'contracts' | 'victories', amount = 1) {
  const result = await api<{ guild: OnlineGuild }>('/api/guilds/progress', { method: 'POST', body: { taskId, amount } })
  return result.guild
}

export async function fetchTreasuryLog() {
  const result = await api<{ entries: TreasuryEntry[] }>('/api/guilds/treasury/log')
  return result.entries
}

export async function fetchOnlineRoles() {
  const result = await api<{ roles: OnlineRole[] }>('/api/guilds/roles')
  return result.roles
}

export async function createOnlineRole(input: {
  name: string
  permissions: { invite: boolean; kick: boolean; treasury: boolean; tree: boolean }
}) {
  const result = await api<{ roles: OnlineRole[] }>('/api/guilds/roles', { method: 'POST', body: input })
  return result.roles
}

export async function fetchOnlineMembers() {
  const result = await api<{ members: OnlineMember[] }>('/api/guilds/members')
  return result.members
}

export async function assignOnlineMemberRole(memberId: string, roleId: string) {
  const result = await api<{ members: OnlineMember[] }>(`/api/guilds/members/${encodeURIComponent(memberId)}/role`, { method: 'POST', body: { roleId } })
  return result.members
}

export async function kickOnlineMember(memberId: string) {
  const result = await api<{ members: OnlineMember[] }>(`/api/guilds/members/${encodeURIComponent(memberId)}`, { method: 'DELETE' })
  return result.members
}
