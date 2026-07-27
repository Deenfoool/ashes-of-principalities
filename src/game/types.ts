export type ProfessionId = 'blacksmith' | 'herbalist' | 'hunter' | 'scribe' | 'carter' | 'wanderer'

export type StatKey = 'health' | 'stamina' | 'insight' | 'coins'

export interface Profession {
  id: ProfessionId
  name: string
  epithet: string
  description: string
  bonus: string
  startingItem: string
  stats: Partial<Record<StatKey, number>>
}

export interface Choice {
  id: string
  label: string
  consequence: string
  nextSceneId: string
  effects?: Partial<Record<StatKey, number>>
  item?: string
  requiresProfession?: ProfessionId
}

export interface Scene {
  id: string
  region: string
  title: string
  text: string
  choices: Choice[]
}

export interface GameState {
  version: 1
  professionId: ProfessionId
  sceneId: string
  health: number
  stamina: number
  insight: number
  coins: number
  inventory: string[]
  day: number
  hour: number
  history: string[]
}
