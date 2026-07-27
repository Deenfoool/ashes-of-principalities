import { enemyById, professionById, questById, scenes } from './content'
import type {
  Choice,
  CombatState,
  EnemyIntent,
  GameState,
  GuildBranchId,
  GuildState,
  LegacyState,
  ProfessionId,
  QuestId,
  StatKey,
} from './types'

const SAVE_KEY = 'ashes-of-principalities:save:v2'
const OLD_SAVE_KEY = 'ashes-of-principalities:save:v1'
const LEGACY_KEY = 'ashes-of-principalities:legacy:v1'
const GUILD_KEY = 'ashes-of-principalities:guild:v1'

const BASE_HEALTH = 9
const BASE_STAMINA = 8
const MAX_INSIGHT = 20
const FOUNDER_SEAL = 'Печать основателя'

export type CombatAction = 'strike' | 'guard' | 'focus' | 'profession' | 'heal' | 'flee'

const defaultLegacy: LegacyState = {
  version: 1,
  renown: 0,
  deaths: 0,
  contractsCompleted: 0,
  heirlooms: [],
}

const defaultGuildTasks = (): GuildState['tasks'] => [
  { id: 'contracts', title: 'Завершить 3 контракта', current: 0, target: 3, experienceReward: 50, completed: false },
  { id: 'victories', title: 'Победить 8 опасных противников', current: 0, target: 8, experienceReward: 45, completed: false },
  { id: 'donations', title: 'Внести 60 монет в казну', current: 0, target: 60, experienceReward: 55, completed: false },
]

const getWeekKey = (date = new Date()) => {
  const utc = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()))
  const day = utc.getUTCDay() || 7
  utc.setUTCDate(utc.getUTCDate() + 4 - day)
  const yearStart = new Date(Date.UTC(utc.getUTCFullYear(), 0, 1))
  const week = Math.ceil((((utc.getTime() - yearStart.getTime()) / 86400000) + 1) / 7)
  return `${utc.getUTCFullYear()}-W${String(week).padStart(2, '0')}`
}

export const getSeasonKey = (date = new Date()) => `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`

const clamp = (value: number, minimum: number, maximum: number) => Math.min(maximum, Math.max(minimum, value))

export const experienceForNextLevel = (level: number) => 10 + level * 8
export const guildExperienceForNextLevel = (level: number) => 80 + level * 40

export function loadLegacy(): LegacyState {
  try {
    const raw = localStorage.getItem(LEGACY_KEY)
    if (!raw) return { ...defaultLegacy }
    const parsed = JSON.parse(raw) as Partial<LegacyState>
    if (parsed.version !== 1) return { ...defaultLegacy }
    return {
      version: 1,
      renown: Math.max(0, Number(parsed.renown) || 0),
      deaths: Math.max(0, Number(parsed.deaths) || 0),
      contractsCompleted: Math.max(0, Number(parsed.contractsCompleted) || 0),
      heirlooms: Array.isArray(parsed.heirlooms) ? parsed.heirlooms.filter((item): item is string => typeof item === 'string').slice(0, 3) : [],
    }
  } catch {
    return { ...defaultLegacy }
  }
}

export function saveLegacy(legacy: LegacyState) {
  localStorage.setItem(LEGACY_KEY, JSON.stringify(legacy))
}

export function createGame(playerName: string, professionId: ProfessionId, legacy = loadLegacy()): GameState {
  const profession = professionById[professionId]
  const healthBonus = profession.stats.health ?? 0
  const staminaBonus = profession.stats.stamina ?? 0
  const inheritedCoins = Math.min(6, Math.floor(legacy.renown / 5))
  const inheritedItem = legacy.heirlooms[0]
  const inventory = [profession.startingItem, 'Сухой паёк']
  if (inheritedItem && !inventory.includes(inheritedItem)) inventory.push(inheritedItem)

  return {
    version: 2,
    playerName: playerName.trim().slice(0, 24) || 'Безымянный',
    professionId,
    sceneId: 'crossroads',
    health: BASE_HEALTH + healthBonus,
    maxHealth: BASE_HEALTH + healthBonus,
    stamina: BASE_STAMINA + staminaBonus,
    maxStamina: BASE_STAMINA + staminaBonus,
    insight: clamp(3 + (profession.stats.insight ?? 0), 0, MAX_INSIGHT),
    coins: Math.max(0, 3 + (profession.stats.coins ?? 0) + inheritedCoins),
    experience: 0,
    level: 1,
    reputation: 0,
    skillPoints: 0,
    inventory,
    flags: [],
    activeQuestId: null,
    completedQuestIds: [],
    day: 1,
    hour: 18,
    history: [`${playerName.trim().slice(0, 24) || 'Безымянный'} выходит на дорогу. Ремесло: ${profession.name}.`],
    combat: null,
    isDead: false,
    deathReason: null,
  }
}

const migrateV1 = (raw: Record<string, unknown>): GameState | null => {
  const professionId = raw.professionId as ProfessionId
  const sceneId = typeof raw.sceneId === 'string' && scenes[raw.sceneId] ? raw.sceneId : 'crossroads'
  if (!professionById[professionId]) return null
  const health = clamp(Number(raw.health) || BASE_HEALTH, 1, 20)
  const stamina = clamp(Number(raw.stamina) || BASE_STAMINA, 0, 20)
  return {
    version: 2,
    playerName: 'Странник',
    professionId,
    sceneId,
    health,
    maxHealth: Math.max(BASE_HEALTH, health),
    stamina,
    maxStamina: Math.max(BASE_STAMINA, stamina),
    insight: clamp(Number(raw.insight) || 3, 0, MAX_INSIGHT),
    coins: Math.max(0, Number(raw.coins) || 0),
    experience: 0,
    level: 1,
    reputation: 0,
    skillPoints: 0,
    inventory: Array.isArray(raw.inventory) ? raw.inventory.filter((item): item is string => typeof item === 'string') : [],
    flags: [],
    activeQuestId: null,
    completedQuestIds: [],
    day: Math.max(1, Number(raw.day) || 1),
    hour: clamp(Number(raw.hour) || 18, 0, 23),
    history: Array.isArray(raw.history) ? raw.history.filter((item): item is string => typeof item === 'string').slice(0, 20) : [],
    combat: null,
    isDead: false,
    deathReason: null,
  }
}

export function saveGame(state: GameState) {
  localStorage.setItem(SAVE_KEY, JSON.stringify(state))
}

export function loadGame(): GameState | null {
  try {
    const raw = localStorage.getItem(SAVE_KEY) ?? localStorage.getItem(OLD_SAVE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as GameState | Record<string, unknown>
    if ((parsed as GameState).version === 2) {
      const state = parsed as GameState
      if (!professionById[state.professionId] || !scenes[state.sceneId]) return null
      return {
        ...state,
        combat: state.combat ?? null,
        flags: Array.isArray(state.flags) ? state.flags : [],
        completedQuestIds: Array.isArray(state.completedQuestIds) ? state.completedQuestIds : [],
      }
    }
    const migrated = migrateV1(parsed as Record<string, unknown>)
    if (migrated) saveGame(migrated)
    return migrated
  } catch {
    return null
  }
}

export function clearGame() {
  localStorage.removeItem(SAVE_KEY)
  localStorage.removeItem(OLD_SAVE_KEY)
}

export function getScene(state: GameState) {
  return scenes[state.sceneId] ?? scenes.crossroads
}

const hasEnoughForEffects = (state: GameState, effects?: Choice['effects']) => {
  if (!effects) return true
  if ((effects.coins ?? 0) < 0 && state.coins < Math.abs(effects.coins ?? 0)) return false
  if ((effects.stamina ?? 0) < 0 && state.stamina < Math.abs(effects.stamina ?? 0)) return false
  if ((effects.health ?? 0) < 0 && state.health <= Math.abs(effects.health ?? 0)) return false
  return true
}

export function canChoose(state: GameState, choice: Choice) {
  if (state.isDead || state.combat) return false
  if (choice.requiresProfession && choice.requiresProfession !== state.professionId) return false
  if (choice.requiresItem && !state.inventory.includes(choice.requiresItem)) return false
  if (choice.requiresInsight && state.insight < choice.requiresInsight) return false
  if (choice.requiresFlag && !state.flags.includes(choice.requiresFlag)) return false
  if (choice.startQuest && state.completedQuestIds.includes(choice.startQuest)) return false
  if (choice.startQuest && state.activeQuestId && state.activeQuestId !== choice.startQuest) return false
  return hasEnoughForEffects(state, choice.effects)
}

const applyStat = (state: GameState, key: StatKey, delta: number) => {
  if (key === 'health') state.health = clamp(state.health + delta, 0, state.maxHealth)
  if (key === 'stamina') state.stamina = clamp(state.stamina + delta, 0, state.maxStamina)
  if (key === 'insight') state.insight = clamp(state.insight + delta, 0, MAX_INSIGHT)
  if (key === 'coins') state.coins = Math.max(0, state.coins + delta)
  if (key === 'experience') state.experience = Math.max(0, state.experience + delta)
  if (key === 'reputation') state.reputation += delta
}

const advanceTime = (state: GameState, hours = 1) => {
  state.hour += hours
  if (state.hour >= 24) {
    state.day += Math.floor(state.hour / 24)
    state.hour %= 24
  }
}

const grantLevels = (state: GameState) => {
  let threshold = experienceForNextLevel(state.level)
  while (state.experience >= threshold) {
    state.experience -= threshold
    state.level += 1
    state.skillPoints += 1
    state.maxHealth += 1
    if (state.level % 2 === 0) state.maxStamina += 1
    state.health = state.maxHealth
    state.stamina = state.maxStamina
    state.history.unshift(`Достигнут ${state.level}-й уровень. Тело крепнет, а решения становятся тяжелее.`)
    threshold = experienceForNextLevel(state.level)
  }
}

export function getGuildBonusMultiplier(guild: GuildState | null) {
  if (!guild) return 0
  const elapsed = Date.now() - guild.joinedAt
  if (elapsed < 4 * 60 * 60 * 1000) return 0
  if (elapsed < 8 * 60 * 60 * 1000) return 0.5
  return 1
}

const applyGuildRewardBonus = (state: GameState, baseExperience: number, baseCoins: number) => {
  const guild = loadGuild()
  const multiplier = getGuildBonusMultiplier(guild)
  if (!guild || multiplier === 0) return { experience: baseExperience, coins: baseCoins }
  const experienceBonus = Math.floor(baseExperience * guild.branches.chronicle * 0.02 * multiplier)
  const coinBonus = Math.floor(baseCoins * guild.branches.treasury * 0.02 * multiplier)
  return { experience: baseExperience + experienceBonus, coins: baseCoins + coinBonus }
}

const recordLegacyContract = () => {
  const legacy = loadLegacy()
  legacy.contractsCompleted += 1
  legacy.renown += 2
  saveLegacy(legacy)
}

const completeQuest = (state: GameState, questId: QuestId) => {
  if (state.completedQuestIds.includes(questId)) return
  state.completedQuestIds.push(questId)
  state.activeQuestId = null
  if (state.completedQuestIds.length >= 3 && !state.flags.includes('chapter-complete')) state.flags.push('chapter-complete')
  state.history.unshift(`Контракт завершён: ${questById[questId].title}.`)
  if (!state.inventory.includes(FOUNDER_SEAL)) {
    state.inventory.push(FOUNDER_SEAL)
    state.history.unshift('За первый завершённый контракт ты получаешь редкую Печать основателя.')
  }
  recordLegacyContract()
  progressGuildTask('contracts', 1)
}

const intentForTurn = (turn: number): EnemyIntent => {
  const cycle: EnemyIntent[] = ['attack', 'guard', 'heavy', 'watch']
  return cycle[(turn - 1) % cycle.length]
}

const beginCombat = (state: GameState, choice: Choice) => {
  if (!choice.encounter) return
  const enemy = enemyById[choice.encounter.enemyId]
  let enemyHealth = enemy.maxHealth
  if (state.flags.includes('taxman-ambush') && enemy.id === 'road-cutthroat') enemyHealth -= 3
  if (state.flags.includes('well-weakened') && enemy.id === 'well-drowner') enemyHealth -= 4
  if (state.flags.includes('beast-advantage') && enemy.id === 'ash-wolf') enemyHealth -= 3
  state.combat = {
    enemyId: enemy.id,
    enemyHealth: Math.max(1, enemyHealth),
    enemyArmor: enemy.armor,
    enemyGuard: 0,
    enemyAttackPenalty: 0,
    professionUsed: false,
    turn: 1,
    playerGuard: 0,
    focus: 0,
    enemyPoison: 0,
    enemyStunned: false,
    intent: intentForTurn(1),
    victorySceneId: choice.encounter.victorySceneId,
    fleeSceneId: choice.encounter.fleeSceneId,
    log: [`Начинается бой: ${enemy.name}.`],
  }
}

export function applyChoice(state: GameState, choice: Choice): GameState {
  if (!canChoose(state, choice)) return state
  const next: GameState = {
    ...state,
    inventory: [...state.inventory],
    flags: [...state.flags],
    completedQuestIds: [...state.completedQuestIds],
    history: [...state.history],
    combat: state.combat ? { ...state.combat, log: [...state.combat.log] } : null,
  }

  if (choice.effects) {
    const effects = { ...choice.effects }
    if (choice.completeQuest) {
      const rewards = applyGuildRewardBonus(next, Math.max(0, effects.experience ?? 0), Math.max(0, effects.coins ?? 0))
      if ((effects.experience ?? 0) > 0) effects.experience = rewards.experience
      if ((effects.coins ?? 0) > 0) effects.coins = rewards.coins
    }
    for (const [key, value] of Object.entries(effects)) {
      applyStat(next, key as StatKey, value ?? 0)
    }
  }
  if (choice.addItem && !next.inventory.includes(choice.addItem)) next.inventory.push(choice.addItem)
  if (choice.removeItem) {
    const index = next.inventory.indexOf(choice.removeItem)
    if (index >= 0) next.inventory.splice(index, 1)
  }
  if (choice.addFlag && !next.flags.includes(choice.addFlag)) next.flags.push(choice.addFlag)
  if (choice.startQuest) next.activeQuestId = choice.startQuest
  if (choice.completeQuest) completeQuest(next, choice.completeQuest)

  next.sceneId = choice.nextSceneId
  next.history.unshift(choice.consequence)
  next.history = next.history.slice(0, 24)
  advanceTime(next, choice.effects?.health && choice.effects.health > 0 ? 4 : 1)
  beginCombat(next, choice)
  grantLevels(next)
  return next
}

const combatCopy = (state: GameState): GameState => ({
  ...state,
  inventory: [...state.inventory],
  flags: [...state.flags],
  completedQuestIds: [...state.completedQuestIds],
  history: [...state.history],
  combat: state.combat ? { ...state.combat, log: [...state.combat.log] } : null,
})

const appendCombatLog = (combat: CombatState, text: string) => {
  combat.log.unshift(text)
  combat.log = combat.log.slice(0, 10)
}

const professionDamageBonus = (state: GameState, enemyTags: string[]) => {
  const guild = loadGuild()
  const guildMultiplier = getGuildBonusMultiplier(guild)
  const warband = guild ? Math.floor((guild.branches.warband * guildMultiplier) / 2) : 0
  const hunter = state.professionId === 'hunter' && enemyTags.includes('beast') ? 2 : 0
  return hunter + warband
}

const finalizeVictory = (state: GameState) => {
  const combat = state.combat
  if (!combat) return
  const enemy = enemyById[combat.enemyId]
  const rewards = applyGuildRewardBonus(state, enemy.experience, enemy.coins)
  state.experience += rewards.experience
  state.coins += rewards.coins
  state.sceneId = combat.victorySceneId
  state.combat = null
  state.history.unshift(`Победа над противником «${enemy.name}»: +${rewards.experience} опыта, +${rewards.coins} монет.`)
  progressGuildTask('victories', 1)
  grantLevels(state)
}

const recordDeath = (state: GameState, reason: string) => {
  if (state.isDead) return
  state.health = 0
  state.isDead = true
  state.deathReason = reason
  state.combat = null
  const legacy = loadLegacy()
  legacy.deaths += 1
  legacy.renown += Math.max(1, state.level + state.completedQuestIds.length)
  const candidate = state.inventory.find((item) => !['Сухой паёк', professionById[state.professionId].startingItem, FOUNDER_SEAL].includes(item))
  if (candidate && !legacy.heirlooms.includes(candidate)) legacy.heirlooms = [candidate, ...legacy.heirlooms].slice(0, 3)
  saveLegacy(legacy)
}

const resolveEnemyTurn = (state: GameState) => {
  const combat = state.combat
  if (!combat) return
  const enemy = enemyById[combat.enemyId]

  if (combat.enemyStunned) {
    combat.enemyStunned = false
    appendCombatLog(combat, `${enemy.name} теряет ход.`)
  } else if (combat.intent === 'guard') {
    combat.enemyGuard = 2
    appendCombatLog(combat, `${enemy.name} защищается и выжидает.`)
  } else if (combat.intent === 'watch') {
    combat.focus = Math.max(0, combat.focus - 1)
    appendCombatLog(combat, `${enemy.name} считывает твои движения и сбивает подготовку.`)
  } else {
    const rawDamage = enemy.attack + (combat.intent === 'heavy' ? 2 : 0) - combat.enemyAttackPenalty
    const damage = Math.max(0, rawDamage - combat.playerGuard)
    state.health = Math.max(0, state.health - damage)
    appendCombatLog(combat, combat.intent === 'heavy' ? `${enemy.name} наносит тяжёлый удар: −${damage} здоровья.` : `${enemy.name} атакует: −${damage} здоровья.`)
  }

  combat.playerGuard = 0
  if (combat.enemyPoison > 0) {
    combat.enemyHealth = Math.max(0, combat.enemyHealth - 1)
    combat.enemyPoison -= 1
    appendCombatLog(combat, 'Яд причиняет противнику 1 урон.')
  }

  if (combat.enemyHealth <= 0) {
    finalizeVictory(state)
    return
  }
  if (state.health <= 0) {
    recordDeath(state, `Тебя одолел ${enemy.name}.`)
    return
  }

  combat.turn += 1
  combat.intent = intentForTurn(combat.turn)
}

export function performCombatAction(state: GameState, action: CombatAction): GameState {
  if (!state.combat || state.isDead) return state
  const next = combatCopy(state)
  const combat = next.combat!
  const enemy = enemyById[combat.enemyId]
  combat.enemyGuard = Math.max(0, combat.enemyGuard)

  if (action === 'flee') {
    if (next.stamina >= 3) {
      next.stamina -= 3
      next.sceneId = combat.fleeSceneId
      next.combat = null
      next.history.unshift(`Ты отступаешь от противника «${enemy.name}». Контракт остаётся незавершённым.`)
      advanceTime(next, 2)
      return next
    }
    appendCombatLog(combat, 'Сил для отступления не хватает.')
    resolveEnemyTurn(next)
    return next
  }

  if (action === 'heal') {
    const index = next.inventory.indexOf('Лечебный сбор')
    if (index < 0) return state
    next.inventory.splice(index, 1)
    const guild = loadGuild()
    const workshopBonus = guild ? Math.floor(guild.branches.workshops * getGuildBonusMultiplier(guild)) : 0
    const healed = Math.min(next.maxHealth - next.health, 5 + workshopBonus)
    next.health += healed
    appendCombatLog(combat, `Лечебный сбор восстанавливает ${healed} здоровья.`)
    resolveEnemyTurn(next)
    return next
  }

  if (action === 'guard') {
    combat.playerGuard = 3 + Math.floor(next.level / 3)
    next.stamina = Math.min(next.maxStamina, next.stamina + 1)
    appendCombatLog(combat, 'Ты принимаешь защитную стойку и переводишь дыхание.')
    resolveEnemyTurn(next)
    return next
  }

  if (action === 'focus') {
    if (next.stamina < 1) return state
    next.stamina -= 1
    combat.focus = Math.min(4, combat.focus + 2)
    next.insight = Math.min(MAX_INSIGHT, next.insight + 1)
    appendCombatLog(combat, 'Ты изучаешь противника и готовишь усиленный удар.')
    resolveEnemyTurn(next)
    return next
  }

  if (action === 'profession') {
    if (combat.professionUsed) return state
    combat.professionUsed = true
    if (next.professionId === 'blacksmith') {
      const removed = Math.min(2, combat.enemyArmor)
      combat.enemyArmor -= removed
      combat.enemyHealth -= 2
      appendCombatLog(combat, `Точный удар по снаряжению: −2 здоровья, броня снижена на ${removed}.`)
    }
    if (next.professionId === 'herbalist') {
      combat.enemyHealth -= 1
      combat.enemyPoison = 4
      appendCombatLog(combat, 'Едкая смесь ранит противника и отравляет его на 4 хода.')
    }
    if (next.professionId === 'hunter') {
      if (next.stamina < 2) return state
      next.stamina -= 2
      const damage = 5 + (enemy.tags.includes('beast') ? 2 : 0)
      combat.enemyHealth -= damage
      appendCombatLog(combat, `Точный выстрел наносит ${damage} урона.`)
    }
    if (next.professionId === 'scribe') {
      combat.enemyAttackPenalty += enemy.tags.includes('human') ? 2 : 1
      combat.focus += 1
      appendCombatLog(combat, 'Ты угадываешь привычку противника: его атака ослаблена до конца боя.')
    }
    if (next.professionId === 'carter') {
      combat.enemyStunned = true
      combat.playerGuard = 1
      appendCombatLog(combat, 'Верёвочная петля спутывает противника и лишает его следующего действия.')
    }
    if (next.professionId === 'wanderer') {
      combat.enemyHealth -= 3
      combat.playerGuard = 2
      appendCombatLog(combat, 'Ты соединяешь грязный удар и мгновенный отход: 3 урона и защита.')
    }
    if (combat.enemyHealth <= 0) finalizeVictory(next)
    else resolveEnemyTurn(next)
    return next
  }

  const armor = combat.enemyArmor + combat.enemyGuard
  const baseDamage = 3 + Math.floor(next.level / 2) + combat.focus + professionDamageBonus(next, enemy.tags)
  const damage = Math.max(1, baseDamage - armor)
  combat.enemyHealth = Math.max(0, combat.enemyHealth - damage)
  combat.enemyGuard = 0
  combat.focus = 0
  appendCombatLog(combat, `Ты наносишь ${damage} урона.`)
  if (combat.enemyHealth <= 0) finalizeVictory(next)
  else resolveEnemyTurn(next)
  return next
}

export function spendSkillPoint(state: GameState, target: 'health' | 'stamina' | 'insight'): GameState {
  if (state.skillPoints < 1 || state.isDead) return state
  const next = { ...state, history: [...state.history] }
  next.skillPoints -= 1
  if (target === 'health') {
    next.maxHealth += 2
    next.health += 2
    next.history.unshift('Закалка: максимальное здоровье увеличено на 2.')
  }
  if (target === 'stamina') {
    next.maxStamina += 2
    next.stamina += 2
    next.history.unshift('Выносливость: максимальный запас сил увеличен на 2.')
  }
  if (target === 'insight') {
    next.insight = Math.min(MAX_INSIGHT, next.insight + 2)
    next.history.unshift('Наблюдательность: чутьё увеличено на 2.')
  }
  return next
}

export function loadGuild(): GuildState | null {
  try {
    const raw = localStorage.getItem(GUILD_KEY)
    if (!raw) return null
    const guild = JSON.parse(raw) as GuildState
    if (guild.version !== 1) return null
    const weekKey = getWeekKey()
    if (guild.weekKey !== weekKey) {
      guild.weekKey = weekKey
      guild.tasks = defaultGuildTasks()
      saveGuild(guild)
    }
    guild.seasonKey = getSeasonKey()
    return guild
  } catch {
    return null
  }
}

export function saveGuild(guild: GuildState) {
  localStorage.setItem(GUILD_KEY, JSON.stringify(guild))
}

export function createGuild(state: GameState, name: string, tag: string): { game: GameState; guild: GuildState | null; error: string | null } {
  if (loadGuild()) return { game: state, guild: null, error: 'Ты уже состоишь в гильдии.' }
  if (state.coins < 12) return { game: state, guild: null, error: 'Для основания гильдии нужно 12 монет.' }
  if (!state.inventory.includes(FOUNDER_SEAL)) return { game: state, guild: null, error: 'Нужна редкая Печать основателя.' }
  const cleanName = name.trim().slice(0, 28)
  const cleanTag = tag.trim().toUpperCase().replace(/[^А-ЯA-Z0-9]/g, '').slice(0, 5)
  if (cleanName.length < 3) return { game: state, guild: null, error: 'Название должно содержать хотя бы 3 символа.' }
  if (cleanTag.length < 2) return { game: state, guild: null, error: 'Тег должен содержать от 2 до 5 букв или цифр.' }

  const next: GameState = { ...state, inventory: [...state.inventory], history: [...state.history] }
  next.coins -= 12
  next.inventory.splice(next.inventory.indexOf(FOUNDER_SEAL), 1)
  next.history.unshift(`Основана гильдия «${cleanName}».`)
  const guild: GuildState = {
    version: 1,
    id: crypto.randomUUID(),
    name: cleanName,
    tag: cleanTag,
    level: 1,
    experience: 0,
    treePoints: 1,
    treasuryCoins: 0,
    treasuryResources: 0,
    joinedAt: Date.now(),
    weekKey: getWeekKey(),
    seasonKey: getSeasonKey(),
    lastTreeResetSeason: null,
    branches: { warband: 0, treasury: 0, workshops: 0, foraging: 0, chronicle: 0 },
    roles: [
      { id: 'leader', name: 'Глава', canInvite: true, canKick: true, canUseTreasury: true, canManageTree: true },
      { id: 'deputy', name: 'Заместитель', canInvite: true, canKick: true, canUseTreasury: true, canManageTree: true },
      { id: 'member', name: 'Участник', canInvite: false, canKick: false, canUseTreasury: false, canManageTree: false },
    ],
    tasks: defaultGuildTasks(),
  }
  saveGuild(guild)
  return { game: next, guild, error: null }
}

const addGuildExperience = (guild: GuildState, amount: number) => {
  guild.experience += amount
  let threshold = guildExperienceForNextLevel(guild.level)
  while (guild.experience >= threshold) {
    guild.experience -= threshold
    guild.level += 1
    guild.treePoints += 1
    threshold = guildExperienceForNextLevel(guild.level)
  }
}

export function progressGuildTask(taskId: GuildState['tasks'][number]['id'], amount: number) {
  const guild = loadGuild()
  if (!guild || amount <= 0) return
  const task = guild.tasks.find((item) => item.id === taskId)
  if (!task || task.completed) return
  task.current = Math.min(task.target, task.current + amount)
  if (task.current >= task.target) {
    task.completed = true
    addGuildExperience(guild, task.experienceReward)
  }
  saveGuild(guild)
}

export function depositGuildCoins(state: GameState, guild: GuildState, amount: number) {
  const cleanAmount = Math.floor(amount)
  if (cleanAmount <= 0 || state.coins < cleanAmount) return { game: state, guild, error: 'Недостаточно монет для взноса.' }
  const nextGame = { ...state, history: [...state.history] }
  const nextGuild = { ...guild, tasks: guild.tasks.map((task) => ({ ...task })) }
  nextGame.coins -= cleanAmount
  nextGuild.treasuryCoins += cleanAmount
  nextGame.history.unshift(`В казну гильдии внесено ${cleanAmount} монет.`)
  const task = nextGuild.tasks.find((item) => item.id === 'donations')
  if (task && !task.completed) {
    task.current = Math.min(task.target, task.current + cleanAmount)
    if (task.current >= task.target) {
      task.completed = true
      addGuildExperience(nextGuild, task.experienceReward)
    }
  }
  saveGuild(nextGuild)
  return { game: nextGame, guild: nextGuild, error: null }
}

export function upgradeGuildBranch(guild: GuildState, branch: GuildBranchId) {
  if (guild.treePoints < 1) return { guild, error: 'Нет свободных очков дерева.' }
  if (guild.branches[branch] >= 5) return { guild, error: 'Ветка уже достигла максимального ранга.' }
  const next = { ...guild, branches: { ...guild.branches } }
  next.branches[branch] += 1
  next.treePoints -= 1
  saveGuild(next)
  return { guild: next, error: null }
}

export function resetGuildTree(guild: GuildState) {
  const season = getSeasonKey()
  if (guild.lastTreeResetSeason === season) return { guild, error: 'Бесплатный сброс в этом сезоне уже использован.' }
  const spent = Object.values(guild.branches).reduce((sum, rank) => sum + rank, 0)
  const next: GuildState = {
    ...guild,
    treePoints: guild.treePoints + spent,
    lastTreeResetSeason: season,
    branches: { warband: 0, treasury: 0, workshops: 0, foraging: 0, chronicle: 0 },
  }
  saveGuild(next)
  return { guild: next, error: null }
}
