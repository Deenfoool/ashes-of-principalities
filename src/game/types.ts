export type ProfessionId = 'blacksmith' | 'herbalist' | 'hunter' | 'scribe' | 'carter' | 'wanderer'

export type QuestId = 'taxman' | 'well' | 'beast'
export type EnemyId = 'road-cutthroat' | 'well-drowner' | 'ash-wolf'
export type GuildBranchId = 'warband' | 'treasury' | 'workshops' | 'foraging' | 'chronicle'
export type StatKey = 'health' | 'stamina' | 'insight' | 'coins' | 'experience' | 'reputation'

export interface Profession {
  id: ProfessionId
  name: string
  epithet: string
  description: string
  bonus: string
  startingItem: string
  stats: Partial<Record<'health' | 'stamina' | 'insight' | 'coins', number>>
}

export interface EncounterDefinition {
  enemyId: EnemyId
  victorySceneId: string
  fleeSceneId: string
}

export interface Choice {
  id: string
  label: string
  consequence: string
  nextSceneId: string
  effects?: Partial<Record<StatKey, number>>
  addItem?: string
  removeItem?: string
  addFlag?: string
  requiresProfession?: ProfessionId
  requiresItem?: string
  requiresInsight?: number
  requiresFlag?: string
  startQuest?: QuestId
  completeQuest?: QuestId
  encounter?: EncounterDefinition
}

export interface Scene {
  id: string
  region: string
  title: string
  text: string
  choices: Choice[]
}

export interface QuestDefinition {
  id: QuestId
  title: string
  summary: string
  danger: 'Низкая' | 'Средняя' | 'Высокая'
  reward: string
}

export interface EnemyDefinition {
  id: EnemyId
  name: string
  description: string
  maxHealth: number
  attack: number
  armor: number
  experience: number
  coins: number
  tags: Array<'human' | 'beast' | 'spirit' | 'armored'>
}

export type EnemyIntent = 'attack' | 'heavy' | 'guard' | 'watch'

export interface CombatState {
  enemyId: EnemyId
  enemyHealth: number
  enemyArmor: number
  enemyGuard: number
  enemyAttackPenalty: number
  professionUsed: boolean
  turn: number
  playerGuard: number
  focus: number
  enemyPoison: number
  enemyStunned: boolean
  intent: EnemyIntent
  victorySceneId: string
  fleeSceneId: string
  log: string[]
}

export interface GameState {
  version: 2
  playerName: string
  professionId: ProfessionId
  sceneId: string
  health: number
  maxHealth: number
  stamina: number
  maxStamina: number
  insight: number
  coins: number
  experience: number
  level: number
  reputation: number
  skillPoints: number
  inventory: string[]
  flags: string[]
  activeQuestId: QuestId | null
  completedQuestIds: QuestId[]
  day: number
  hour: number
  history: string[]
  combat: CombatState | null
  isDead: boolean
  deathReason: string | null
}

export interface LegacyState {
  version: 1
  renown: number
  deaths: number
  contractsCompleted: number
  heirlooms: string[]
}

export interface GuildRole {
  id: string
  name: string
  canInvite: boolean
  canKick: boolean
  canUseTreasury: boolean
  canManageTree: boolean
}

export interface GuildTask {
  id: 'contracts' | 'victories' | 'donations'
  title: string
  current: number
  target: number
  experienceReward: number
  completed: boolean
}

export interface GuildState {
  version: 1
  id: string
  name: string
  tag: string
  level: number
  experience: number
  treePoints: number
  treasuryCoins: number
  treasuryResources: number
  joinedAt: number
  weekKey: string
  seasonKey: string
  lastTreeResetSeason: string | null
  branches: Record<GuildBranchId, number>
  roles: GuildRole[]
  tasks: GuildTask[]
}
