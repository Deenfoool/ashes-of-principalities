import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ChangeEvent, FormEvent } from 'react'
import { enemyById, professionById, professions, questById, quests } from './game/content'
import {
  applyChoice,
  canChoose,
  clearGame,
  createGame,
  experienceForNextLevel,
  getGuildBonusMultiplier,
  getScene,
  guildExperienceForNextLevel,
  loadGame,
  loadGuild,
  loadLegacy,
  performCombatAction,
  saveGame,
  saveGuild,
  spendSkillPoint,
} from './game/engine'
import type { CombatAction } from './game/engine'
import type { Choice, GameState, GuildBranchId, GuildState, LegacyState, ProfessionId } from './game/types'
import {
  acceptOnlineInvite,
  createOnlineGuild,
  createOnlineRole,
  depositOnlineGuildCoins,
  fetchOnlineMembers,
  fetchOnlineRoles,
  fetchOnlineSnapshot,
  fetchTreasuryLog,
  getOnlineToken,
  hasOnlineToken,
  inviteOnlinePlayer,
  assignOnlineMemberRole,
  kickOnlineMember,
  loginOnline,
  logoutOnline,
  progressOnlineGuildTask,
  registerOnline,
  resetOnlineGuildTree,
  upgradeOnlineGuildBranch,
} from './online'
import type { OnlineGuild, OnlineMember, OnlineRole, OnlineSnapshot, TreasuryEntry } from './online'

type View = 'journey' | 'journal' | 'character' | 'chat' | 'guild' | 'account'
type ChatChannel = 'general' | 'trade' | 'guild'
type OnlineStatus = 'loading' | 'online' | 'guest' | 'offline'

interface ChatMessage {
  id: string
  channel: ChatChannel
  author: string
  text: string
  timestamp: number
  system?: boolean
  guildId?: string | null
}

const channelLabels: Record<ChatChannel, string> = {
  general: '#Общий',
  trade: '#Торговля',
  guild: '#Гильдия',
}

const branchInfo: Record<GuildBranchId, { name: string; description: string }> = {
  warband: { name: 'Дружина', description: 'Усиливает урон в опасных столкновениях.' },
  treasury: { name: 'Казна', description: 'Повышает монеты за бои и контракты.' },
  workshops: { name: 'Мастерские', description: 'Усиливает лечебные предметы.' },
  foraging: { name: 'Промысел', description: 'Подготавливает добычу ресурсов и снижает дорожные потери.' },
  chronicle: { name: 'Летопись', description: 'Повышает опыт за бои и контракты.' },
}

const intentLabels = {
  attack: 'готовит обычную атаку',
  heavy: 'замахивается для тяжёлого удара',
  guard: 'собирается защищаться',
  watch: 'наблюдает за твоими движениями',
}

const professionCombatLabels: Record<ProfessionId, string> = {
  blacksmith: 'Сбить броню',
  herbalist: 'Применить яд',
  hunter: 'Точный выстрел',
  scribe: 'Прочесть повадку',
  carter: 'Накинуть петлю',
  wanderer: 'Грязный приём',
}

const getPlayerId = () => {
  const key = 'ashes-of-principalities:player-id'
  const existing = localStorage.getItem(key)
  if (existing) return existing
  const id = crypto.randomUUID()
  localStorage.setItem(key, id)
  return id
}

const clearGuildCache = () => localStorage.removeItem('ashes-of-principalities:guild:v1')

const payGuildFoundingCost = (state: GameState, guildName: string): GameState | null => {
  if (state.coins < 12 || !state.inventory.includes('Печать основателя')) return null
  const next: GameState = { ...state, inventory: [...state.inventory], history: [...state.history] }
  next.coins -= 12
  next.inventory.splice(next.inventory.indexOf('Печать основателя'), 1)
  next.history.unshift(`Основана гильдия «${guildName}».`)
  return next
}

const payGuildDeposit = (state: GameState, amount: number): GameState | null => {
  const cleanAmount = Math.floor(amount)
  if (cleanAmount <= 0 || state.coins < cleanAmount) return null
  const next: GameState = { ...state, history: [...state.history] }
  next.coins -= cleanAmount
  next.history.unshift(`В общую казну внесено ${cleanAmount} монет.`)
  return next
}

function onlineGuildToCache(guild: OnlineGuild): GuildState {
  const existing = loadGuild()
  return {
    version: 1,
    id: guild.id,
    name: guild.name,
    tag: guild.tag,
    level: guild.level,
    experience: guild.experience,
    treePoints: guild.treePoints,
    treasuryCoins: guild.treasuryCoins,
    treasuryResources: guild.treasuryResources,
    joinedAt: guild.joinedAt,
    weekKey: existing?.id === guild.id ? existing.weekKey : '',
    seasonKey: guild.seasonKey,
    lastTreeResetSeason: guild.lastTreeResetSeason,
    branches: { ...guild.branches },
    roles: existing?.id === guild.id ? existing.roles : [],
    tasks: guild.tasks.map((task) => ({
      id: task.id,
      title: task.title,
      current: task.current,
      target: task.target,
      experienceReward: task.reward,
      completed: task.completed,
    })),
  }
}

function CharacterCreation({ legacy, onCreate }: { legacy: LegacyState; onCreate: (name: string, professionId: ProfessionId) => void }) {
  const [selected, setSelected] = useState<ProfessionId>('hunter')
  const [name, setName] = useState('')
  const profession = professionById[selected]

  return (
    <main className="creation-shell">
      <section className="creation-intro">
        <p className="eyebrow">Текстовая PWA RPG-рогалик</p>
        <h1>Пепел Княжеств</h1>
        <p>Здесь нет избранных. Есть ремесло, долги и дорога, которая переживёт тебя.</p>
        <div className="legacy-summary">
          <span>Родовая слава: <strong>{legacy.renown}</strong></span>
          <span>Погибло предшественников: <strong>{legacy.deaths}</strong></span>
          <span>Завершено контрактов: <strong>{legacy.contractsCompleted}</strong></span>
        </div>
      </section>

      <section className="profession-grid" aria-label="Выбор ремесла">
        {professions.map((item) => (
          <button className={`profession-card ${selected === item.id ? 'selected' : ''}`} key={item.id} onClick={() => setSelected(item.id)} type="button">
            <span>{item.name}</span>
            <small>{item.epithet}</small>
          </button>
        ))}
      </section>

      <section className="profession-detail">
        <div><p className="eyebrow">Новый человек</p><h2>{profession.name}</h2><p>{profession.description}</p></div>
        <label className="field-label">
          Имя персонажа
          <input maxLength={24} onChange={(event: ChangeEvent<HTMLInputElement>) => setName(event.target.value)} placeholder="Например, Мирослав" value={name} />
        </label>
        <dl>
          <div><dt>Преимущество</dt><dd>{profession.bonus}</dd></div>
          <div><dt>Начальный предмет</dt><dd>{profession.startingItem}</dd></div>
          {legacy.heirlooms[0] && <div><dt>Наследство</dt><dd>{legacy.heirlooms[0]}</dd></div>}
        </dl>
        <button className="primary-action" disabled={name.trim().length < 2} type="button" onClick={() => onCreate(name, selected)}>Выйти на дорогу</button>
      </section>
    </main>
  )
}

function Stat({ label, value, max }: { label: string; value: number; max: number }) {
  const width = `${Math.min(100, Math.max(0, (value / Math.max(1, max)) * 100))}%`
  return <div className="stat"><div><span>{label}</span><strong>{value}/{max}</strong></div><div className="stat-track"><span style={{ width }} /></div></div>
}

function requirementText(game: GameState, choice: Choice) {
  if (choice.requiresProfession && choice.requiresProfession !== game.professionId) return `Требуется ремесло: ${professionById[choice.requiresProfession].name}`
  if (choice.requiresItem && !game.inventory.includes(choice.requiresItem)) return `Требуется предмет: ${choice.requiresItem}`
  if (choice.requiresInsight && game.insight < choice.requiresInsight) return `Требуется чутьё: ${choice.requiresInsight}`
  if (choice.requiresFlag === 'chapter-complete' && !game.flags.includes('chapter-complete')) return 'Сначала завершите все три контракта'
  if (choice.requiresFlag && !game.flags.includes(choice.requiresFlag)) return 'Этот вариант пока недоступен'
  if (choice.startQuest && game.completedQuestIds.includes(choice.startQuest)) return 'Контракт уже завершён'
  if (choice.startQuest && game.activeQuestId && game.activeQuestId !== choice.startQuest) return 'Сначала завершите текущий контракт'
  if ((choice.effects?.coins ?? 0) < 0 && game.coins < Math.abs(choice.effects?.coins ?? 0)) return 'Недостаточно монет'
  if ((choice.effects?.stamina ?? 0) < 0 && game.stamina < Math.abs(choice.effects?.stamina ?? 0)) return 'Недостаточно сил'
  return null
}

function CombatPanel({ game, onAction }: { game: GameState; onAction: (action: CombatAction) => void }) {
  const combat = game.combat!
  const enemy = enemyById[combat.enemyId]
  const enemyPercent = `${Math.max(0, (combat.enemyHealth / enemy.maxHealth) * 100)}%`
  return (
    <section className="panel combat-panel">
      <header className="combat-header">
        <div><p className="eyebrow">Опасное столкновение · ход {combat.turn}</p><h1>{enemy.name}</h1><p>{enemy.description}</p></div>
        <div className="enemy-health"><span>Здоровье врага</span><strong>{combat.enemyHealth}/{enemy.maxHealth}</strong><div className="enemy-track"><span style={{ width: enemyPercent }} /></div></div>
      </header>
      <div className="enemy-intent"><strong>Намерение:</strong> противник {intentLabels[combat.intent]}.</div>
      <div className="combat-actions">
        <button type="button" onClick={() => onAction('strike')}>Атаковать</button>
        <button type="button" onClick={() => onAction('guard')}>Защищаться</button>
        <button disabled={game.stamina < 1} type="button" onClick={() => onAction('focus')}>Изучить противника</button>
        <button disabled={combat.professionUsed || (game.professionId === 'hunter' && game.stamina < 2)} type="button" onClick={() => onAction('profession')}>{professionCombatLabels[game.professionId]}</button>
        <button disabled={!game.inventory.includes('Лечебный сбор')} type="button" onClick={() => onAction('heal')}>Лечебный сбор</button>
        <button className="flee-action" disabled={game.stamina < 3} type="button" onClick={() => onAction('flee')}>Отступить</button>
      </div>
      <div className="combat-log"><h3>Ход боя</h3>{combat.log.map((entry, index) => <p key={`${entry}-${index}`}>{entry}</p>)}</div>
    </section>
  )
}

function ChatPanel({ author, guildId }: { author: string; guildId: string | null }) {
  const [channel, setChannel] = useState<ChatChannel>('general')
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [text, setText] = useState('')
  const [status, setStatus] = useState<'connecting' | 'online' | 'offline'>('connecting')
  const socketRef = useRef<WebSocket | null>(null)

  useEffect(() => {
    let cancelled = false
    let retryTimer: number | undefined
    let attempts = 0
    const connect = () => {
      if (cancelled) return
      setStatus('connecting')
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
      const socket = new WebSocket(`${protocol}//${window.location.host}/ws`)
      socketRef.current = socket
      socket.addEventListener('open', () => {
        attempts = 0
        setStatus('online')
        socket.send(JSON.stringify({ type: 'hello', token: getOnlineToken(), playerId: getPlayerId(), author }))
      })
      socket.addEventListener('message', (event) => {
        try {
          const payload = JSON.parse(String(event.data)) as { type: string; messages?: ChatMessage[]; message?: ChatMessage }
          if (payload.type === 'history' && payload.messages) setMessages(payload.messages)
          if (payload.type === 'message' && payload.message) setMessages((current) => [...current.slice(-119), payload.message!])
        } catch {
          // Malformed packets never break the PWA shell.
        }
      })
      socket.addEventListener('close', () => {
        if (cancelled) return
        setStatus('offline')
        attempts += 1
        retryTimer = window.setTimeout(connect, Math.min(10000, 700 * 2 ** attempts))
      })
      socket.addEventListener('error', () => socket.close())
    }
    connect()
    return () => {
      cancelled = true
      if (retryTimer) window.clearTimeout(retryTimer)
      socketRef.current?.close()
    }
  }, [author, guildId])

  useEffect(() => {
    if (channel === 'guild' && !guildId) setChannel('general')
  }, [channel, guildId])

  const visibleMessages = messages.filter((message) => message.channel === channel && (channel !== 'guild' || message.guildId === guildId))
  const submit = (event: FormEvent) => {
    event.preventDefault()
    const clean = text.trim()
    if (!clean || socketRef.current?.readyState !== WebSocket.OPEN) return
    socketRef.current.send(JSON.stringify({ type: 'message', channel, text: clean }))
    setText('')
  }

  return (
    <section className="panel chat-panel">
      <header className="panel-header"><div><p className="eyebrow">Связь между путниками</p><h2>Чаты</h2></div><span className={`connection ${status}`}>{status === 'online' ? 'В сети' : status === 'connecting' ? 'Подключение' : 'Нет связи'}</span></header>
      <div className="channel-tabs">
        {(Object.keys(channelLabels) as ChatChannel[]).map((id) => <button disabled={id === 'guild' && !guildId} className={channel === id ? 'active' : ''} key={id} onClick={() => setChannel(id)} type="button">{channelLabels[id]}</button>)}
      </div>
      <div className="messages" aria-live="polite">
        {visibleMessages.length === 0 ? <p className="empty-state">Здесь пока тихо. Первое сообщение тоже становится частью истории.</p> : visibleMessages.map((message) => (
          <article className={message.system ? 'system-message' : ''} key={message.id}><div><strong>{message.author}</strong><time>{new Date(message.timestamp).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}</time></div><p>{message.text}</p></article>
        ))}
      </div>
      <form className="chat-form" onSubmit={submit}><input maxLength={280} onChange={(event: ChangeEvent<HTMLInputElement>) => setText(event.target.value)} placeholder={`Написать в ${channelLabels[channel]}`} value={text} /><button disabled={status !== 'online' || !text.trim()} type="submit">Отправить</button></form>
    </section>
  )
}

function JournalPanel({ game }: { game: GameState }) {
  return (
    <section className="panel journal-panel">
      <header className="panel-header"><div><p className="eyebrow">Не список поручений, а след решений</p><h2>Контракты</h2></div><strong>{game.completedQuestIds.length}/3</strong></header>
      <div className="quest-list">{quests.map((quest) => {
        const active = game.activeQuestId === quest.id
        const completed = game.completedQuestIds.includes(quest.id)
        return <article className={active ? 'active' : completed ? 'completed' : ''} key={quest.id}><div><span>{completed ? 'Завершён' : active ? 'Активен' : quest.danger}</span><h3>{quest.title}</h3></div><p>{quest.summary}</p><small>{quest.reward}</small></article>
      })}</div>
    </section>
  )
}

function AccountPanel({ snapshot, status, onRefresh, onLogout }: { snapshot: OnlineSnapshot | null; status: OnlineStatus; onRefresh: () => Promise<void>; onLogout: () => Promise<void> }) {
  const [mode, setMode] = useState<'login' | 'register'>('login')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  if (snapshot) {
    return (
      <section className="panel account-panel">
        <header className="panel-header"><div><p className="eyebrow">Серверная личность</p><h2>{snapshot.user.displayName}</h2><small>@{snapshot.user.username}</small></div><button className="danger-link" type="button" onClick={() => void onLogout()}>Выйти</button></header>
        <div className="account-status"><span>Аккаунт подключён</span><strong>{snapshot.guild ? `[${snapshot.guild.tag}] ${snapshot.guild.name}` : 'Без гильдии'}</strong></div>
        <div className="guild-section">
          <p className="eyebrow">Личные приглашения</p><h3>Входящие</h3>
          {snapshot.invites.length === 0 ? <p className="empty-state compact">Новых приглашений нет.</p> : <div className="invite-list">{snapshot.invites.map((invite) => (
            <article key={invite.id}><div><strong>[{invite.guildTag}] {invite.guildName}</strong><small>От: {invite.inviterName}</small></div><button type="button" onClick={async () => { setBusy(true); setError(null); try { await acceptOnlineInvite(invite.id); await onRefresh() } catch (caught) { setError(caught instanceof Error ? caught.message : 'Не удалось принять приглашение.') } finally { setBusy(false) } }}>Принять</button></article>
          ))}</div>}
        </div>
        {busy && <p className="muted-line">Синхронизация с сервером…</p>}
        {error && <p className="form-error">{error}</p>}
      </section>
    )
  }

  return (
    <section className="panel account-panel">
      <header className="panel-header"><div><p className="eyebrow">Онлайн без потери офлайн-игры</p><h2>{mode === 'login' ? 'Вход' : 'Регистрация'}</h2></div><span className={`connection ${status === 'offline' ? 'offline' : ''}`}>{status === 'offline' ? 'Сервер недоступен' : 'Гостевой режим'}</span></header>
      <p className="account-explainer">Без аккаунта можно проходить одиночную главу и пользоваться общим чатом. Аккаунт нужен для общей гильдии, приглашений и защищённого гильдейского канала.</p>
      <div className="account-tabs"><button className={mode === 'login' ? 'active' : ''} type="button" onClick={() => setMode('login')}>Вход</button><button className={mode === 'register' ? 'active' : ''} type="button" onClick={() => setMode('register')}>Новый аккаунт</button></div>
      <form className="account-form" onSubmit={async (event: FormEvent) => {
        event.preventDefault(); setBusy(true); setError(null)
        try {
          if (mode === 'register') await registerOnline({ username, password, displayName })
          else await loginOnline({ username, password })
          await onRefresh()
        } catch (caught) {
          setError(caught instanceof Error ? caught.message : 'Не удалось подключить аккаунт.')
        } finally { setBusy(false) }
      }}>
        {mode === 'register' && <label className="field-label">Имя в игре<input maxLength={24} value={displayName} onChange={(event: ChangeEvent<HTMLInputElement>) => setDisplayName(event.target.value)} /></label>}
        <label className="field-label">Логин<input autoCapitalize="none" maxLength={20} value={username} onChange={(event: ChangeEvent<HTMLInputElement>) => setUsername(event.target.value)} /></label>
        <label className="field-label">Пароль<input minLength={8} maxLength={128} type="password" value={password} onChange={(event: ChangeEvent<HTMLInputElement>) => setPassword(event.target.value)} /></label>
        <button className="primary-action" disabled={busy || username.trim().length < 3 || password.length < 8 || (mode === 'register' && displayName.trim().length < 2)}>{busy ? 'Подключение…' : mode === 'register' ? 'Создать аккаунт' : 'Войти'}</button>
      </form>
      {error && <p className="form-error">{error}</p>}
    </section>
  )
}

function ServerGuildPanel({ game, snapshot, onGame, onSnapshot, onGoAccount }: { game: GameState; snapshot: OnlineSnapshot | null; onGame: (game: GameState) => void; onSnapshot: (snapshot: OnlineSnapshot) => void; onGoAccount: () => void }) {
  const [name, setName] = useState('')
  const [tag, setTag] = useState('')
  const [deposit, setDeposit] = useState('10')
  const [inviteUsername, setInviteUsername] = useState('')
  const [roleName, setRoleName] = useState('')
  const [rolePermissions, setRolePermissions] = useState({ invite: false, kick: false, treasury: false, tree: false })
  const [roles, setRoles] = useState<OnlineRole[]>([])
  const [members, setMembers] = useState<OnlineMember[]>([])
  const [treasuryLog, setTreasuryLog] = useState<TreasuryEntry[]>([])
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const guild = snapshot?.guild ?? null

  useEffect(() => {
    if (!guild) { setRoles([]); setMembers([]); setTreasuryLog([]); return }
    void Promise.all([fetchOnlineRoles(), fetchOnlineMembers(), fetchTreasuryLog()])
      .then(([nextRoles, nextMembers, nextLog]) => { setRoles(nextRoles); setMembers(nextMembers); setTreasuryLog(nextLog) })
      .catch(() => undefined)
  }, [guild?.id, guild?.treasuryCoins])

  const run = async (action: () => Promise<void>) => {
    setBusy(true); setError(null); setNotice(null)
    try { await action() } catch (caught) { setError(caught instanceof Error ? caught.message : 'Сервер не выполнил действие.') } finally { setBusy(false) }
  }

  if (!snapshot) {
    return <section className="panel guild-panel"><p className="eyebrow">Общее дело хранится на сервере</p><h2>Нужен аккаунт</h2><p>Создай аккаунт или войди, чтобы приглашать игроков, делить казну и пользоваться закрытым гильдейским чатом.</p><button className="primary-action" type="button" onClick={onGoAccount}>Перейти к аккаунту</button></section>
  }

  if (!guild) {
    const hasSeal = game.inventory.includes('Печать основателя')
    return (
      <section className="panel guild-panel">
        <p className="eyebrow">Общее дело</p><h2>Основать гильдию</h2>
        <p>Гильдия объединяет до 20 игроков. Для основания нужны 12 монет и Печать основателя после первого контракта.</p>
        <div className="guild-cost"><span className={game.coins >= 12 ? 'ready' : ''}>Монеты: {game.coins}/12</span><span className={hasSeal ? 'ready' : ''}>Печать: {hasSeal ? 'есть' : 'нет'}</span></div>
        <div className="guild-create-form">
          <label className="field-label">Название<input maxLength={28} value={name} onChange={(event: ChangeEvent<HTMLInputElement>) => setName(event.target.value)} placeholder="Серые вороны" /></label>
          <label className="field-label">Тег<input maxLength={5} value={tag} onChange={(event: ChangeEvent<HTMLInputElement>) => setTag(event.target.value)} placeholder="СВ" /></label>
          <button className="primary-action" disabled={busy || game.coins < 12 || !hasSeal} type="button" onClick={() => void run(async () => {
            const paidGame = payGuildFoundingCost(game, name.trim())
            if (!paidGame) throw new Error('Не хватает монет или Печати основателя.')
            const created = await createOnlineGuild(name, tag)
            onGame(paidGame)
            onSnapshot({ ...snapshot, guild: created, invites: [] })
            setNotice('Гильдия основана и сохранена на сервере.')
          })}>Основать гильдию</button>
        </div>
        {notice && <p className="form-notice">{notice}</p>}{error && <p className="form-error">{error}</p>}
      </section>
    )
  }

  const cache = onlineGuildToCache(guild)
  const bonusMultiplier = getGuildBonusMultiplier(cache)
  const guildXpTarget = guildExperienceForNextLevel(guild.level)
  return (
    <section className="panel guild-panel">
      <header className="guild-heading"><div><p className="eyebrow">[{guild.tag}] · {guild.memberCount}/20 участников · {guild.role.name}</p><h2>{guild.name}</h2></div><div><span>Уровень {guild.level}</span><strong>{guild.experience}/{guildXpTarget} опыта</strong></div></header>
      <div className="guild-status-grid">
        <article><span>Бонус участника</span><strong>×{bonusMultiplier.toFixed(1)}</strong><small>{bonusMultiplier === 0 ? 'Включится через 4 часа' : bonusMultiplier === 0.5 ? 'Полная сила через 8 часов' : 'Работает полностью'}</small></article>
        <article><span>Казна</span><strong>{guild.treasuryCoins} монет</strong><small>{guild.treasuryResources} ресурсов</small></article>
        <article><span>Очки дерева</span><strong>{guild.treePoints}</strong><small>Новые очки выдаются за уровни</small></article>
      </div>

      <div className="guild-section">
        <div className="section-title"><div><p className="eyebrow">Пять путей развития</p><h3>Дерево гильдии</h3></div>{guild.role.permissions.tree && <button disabled={busy} type="button" onClick={() => void run(async () => onSnapshot({ ...snapshot, guild: await resetOnlineGuildTree() }))}>Сбросить раз в сезон</button>}</div>
        <div className="branch-grid">{(Object.keys(branchInfo) as GuildBranchId[]).map((branch) => <article key={branch}><div><h4>{branchInfo[branch].name}</h4><strong>{guild.branches[branch]}/5</strong></div><p>{branchInfo[branch].description}</p><button disabled={busy || !guild.role.permissions.tree || guild.treePoints < 1 || guild.branches[branch] >= 5} type="button" onClick={() => void run(async () => onSnapshot({ ...snapshot, guild: await upgradeOnlineGuildBranch(branch) }))}>Улучшить</button></article>)}</div>
      </div>

      <div className="guild-section"><p className="eyebrow">Общие для всех участников</p><h3>Еженедельные задания</h3><div className="guild-tasks">{guild.tasks.map((task) => <article className={task.completed ? 'completed' : ''} key={task.id}><div><strong>{task.title}</strong><span>{task.current}/{task.target}</span></div><div className="task-track"><span style={{ width: `${Math.min(100, task.current / task.target * 100)}%` }} /></div><small>Награда: {task.reward} опыта гильдии</small></article>)}</div></div>

      <div className="guild-section treasury-form"><div><p className="eyebrow">Операции сохраняются на сервере</p><h3>Взнос в казну</h3></div><input min="1" type="number" value={deposit} onChange={(event: ChangeEvent<HTMLInputElement>) => setDeposit(event.target.value)} /><button disabled={busy} type="button" onClick={() => void run(async () => {
        const amount = Math.floor(Number(deposit))
        const paidGame = payGuildDeposit(game, amount)
        if (!paidGame) throw new Error('Недостаточно монет для взноса.')
        const updated = await depositOnlineGuildCoins(amount)
        onGame(paidGame); onSnapshot({ ...snapshot, guild: updated }); setNotice(`Внесено ${amount} монет.`)
      })}>Внести</button></div>
      <div className="treasury-log">{treasuryLog.slice(0, 8).map((entry) => <p key={entry.id}><span>{entry.playerName}</span><strong>+{entry.amount}</strong><time>{new Date(entry.createdAt).toLocaleString('ru-RU')}</time></p>)}</div>

      {guild.role.permissions.invite && <div className="guild-section inline-form"><div><p className="eyebrow">Вступление только по приглашению</p><h3>Пригласить игрока</h3></div><input value={inviteUsername} onChange={(event: ChangeEvent<HTMLInputElement>) => setInviteUsername(event.target.value)} placeholder="Логин игрока" /><button disabled={busy || inviteUsername.trim().length < 3} type="button" onClick={() => void run(async () => { const result = await inviteOnlinePlayer(inviteUsername); setNotice(`Приглашение отправлено: ${result.invite.inviteeName}.`); setInviteUsername('') })}>Пригласить</button></div>}

      <div className="guild-section"><p className="eyebrow">Состав и иерархия</p><h3>Участники</h3><div className="member-list">{members.map((member) => <article key={member.id}><div><strong>{member.displayName}</strong><small>@{member.username} · вступил {new Date(member.joinedAt).toLocaleDateString('ru-RU')}</small></div>{guild.role.permissions.roles && !member.isLeader ? <select value={member.roleId} onChange={(event: ChangeEvent<HTMLSelectElement>) => void run(async () => setMembers(await assignOnlineMemberRole(member.id, event.target.value)))}>{roles.filter((role) => role.position < 100).map((role) => <option key={role.id} value={role.id}>{role.name}</option>)}</select> : <span>{member.roleName}</span>}{guild.role.permissions.kick && !member.isLeader && <button className="danger-link" type="button" onClick={() => void run(async () => setMembers(await kickOnlineMember(member.id)))}>Исключить</button>}</article>)}</div></div>

      {guild.role.permissions.roles && <div className="guild-section role-editor"><p className="eyebrow">Глава создаёт собственные роли</p><h3>Роли и права</h3><div className="role-list">{roles.map((role) => <span key={role.id}>{role.name}</span>)}</div><label className="field-label">Новая роль<input maxLength={20} value={roleName} onChange={(event: ChangeEvent<HTMLInputElement>) => setRoleName(event.target.value)} placeholder="Казначей" /></label><div className="permission-grid">{(['invite', 'kick', 'treasury', 'tree'] as const).map((permission) => <label key={permission}><input type="checkbox" checked={rolePermissions[permission]} onChange={(event: ChangeEvent<HTMLInputElement>) => setRolePermissions((current) => ({ ...current, [permission]: event.target.checked }))} />{permission === 'invite' ? 'Приглашать' : permission === 'kick' ? 'Исключать' : permission === 'treasury' ? 'Казна' : 'Дерево'}</label>)}</div><button disabled={busy || roleName.trim().length < 2} type="button" onClick={() => void run(async () => { const nextRoles = await createOnlineRole({ name: roleName, permissions: rolePermissions }); setRoles(nextRoles); setRoleName(''); setRolePermissions({ invite: false, kick: false, treasury: false, tree: false }); setNotice('Новая роль создана.') })}>Создать роль</button></div>}

      {busy && <p className="muted-line">Синхронизация…</p>}{notice && <p className="form-notice">{notice}</p>}{error && <p className="form-error">{error}</p>}
    </section>
  )
}

function DeathScreen({ game, onContinue }: { game: GameState; onContinue: () => void }) {
  const legacy = loadLegacy()
  return <main className="death-screen"><p className="eyebrow">Дорога запомнила ещё одно имя</p><h1>{game.playerName} погиб</h1><p>{game.deathReason}</p><div className="death-legacy"><span>Уровень: <strong>{game.level}</strong></span><span>Завершено контрактов: <strong>{game.completedQuestIds.length}</strong></span><span>Родовая слава: <strong>{legacy.renown}</strong></span><span>Сохранённые реликвии: <strong>{legacy.heirlooms.length}</strong></span></div><button className="primary-action" type="button" onClick={onContinue}>Создать наследника</button></main>
}

function App() {
  const [game, setGame] = useState<GameState | null>(() => loadGame())
  const [legacy, setLegacy] = useState<LegacyState>(() => loadLegacy())
  const [view, setView] = useState<View>('journey')
  const [online, setOnline] = useState<OnlineSnapshot | null>(null)
  const [onlineStatus, setOnlineStatus] = useState<OnlineStatus>(hasOnlineToken() ? 'loading' : 'guest')

  const refreshOnline = useCallback(async () => {
    if (!hasOnlineToken()) { setOnline(null); setOnlineStatus('guest'); clearGuildCache(); return }
    setOnlineStatus('loading')
    try {
      const snapshot = await fetchOnlineSnapshot()
      setOnline(snapshot)
      setOnlineStatus('online')
      if (snapshot.guild) saveGuild(onlineGuildToCache(snapshot.guild))
      else clearGuildCache()
    } catch {
      setOnline(null)
      setOnlineStatus(hasOnlineToken() ? 'offline' : 'guest')
    }
  }, [])

  useEffect(() => { void refreshOnline() }, [refreshOnline])
  useEffect(() => { if (game) saveGame(game) }, [game])
  useEffect(() => {
    if (online?.guild) saveGuild(onlineGuildToCache(online.guild))
    if (online && !online.guild) clearGuildCache()
  }, [online])

  const scene = useMemo(() => game ? getScene(game) : null, [game])
  const profession = game ? professionById[game.professionId] : null

  if (!game || !scene || !profession) return <CharacterCreation legacy={legacy} onCreate={(name, professionId) => setGame(createGame(name, professionId, legacy))} />
  if (game.isDead) return <DeathScreen game={game} onContinue={() => { clearGame(); setGame(null); setLegacy(loadLegacy()); setView('journey') }} />

  const restart = () => { clearGame(); setGame(null); setLegacy(loadLegacy()); setView('journey') }
  const activeQuest = game.activeQuestId ? questById[game.activeQuestId] : null
  const experienceTarget = experienceForNextLevel(game.level)

  const syncGuildProgress = async (taskId: 'contracts' | 'victories') => {
    if (!online?.guild) return
    try {
      const guild = await progressOnlineGuildTask(taskId)
      setOnline((current) => current ? { ...current, guild } : current)
    } catch {
      // The action remains playable offline; guild progress can be retried in a later sync layer.
    }
  }

  const handleChoice = (choice: Choice) => {
    const next = applyChoice(game, choice)
    const completed = next.completedQuestIds.length > game.completedQuestIds.length
    setGame(next)
    if (completed) void syncGuildProgress('contracts')
  }

  const handleCombat = (action: CombatAction) => {
    const previousCombat = game.combat
    const next = performCombatAction(game, action)
    const won = Boolean(previousCombat && !next.combat && !next.isDead && next.sceneId === previousCombat.victorySceneId)
    setGame(next)
    if (won) void syncGuildProgress('victories')
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand"><span className="brand-mark">ПК</span><div><strong>Пепел Княжеств</strong><small>{scene.region}</small></div></div>
        <div className="topbar-progress"><span>{game.playerName} · {profession.name}</span><strong>Ур. {game.level} · {game.experience}/{experienceTarget} опыта</strong></div>
        <div className="world-clock"><span>{online?.user.displayName ?? (onlineStatus === 'offline' ? 'Сервер недоступен' : 'Гость')} · День {game.day}</span><strong>{String(game.hour).padStart(2, '0')}:00</strong></div>
      </header>

      <aside className="sidebar"><nav aria-label="Основная навигация">
        <button className={view === 'journey' ? 'active' : ''} onClick={() => setView('journey')} type="button">Путь</button>
        <button className={view === 'journal' ? 'active' : ''} onClick={() => setView('journal')} type="button">Контракты</button>
        <button className={view === 'character' ? 'active' : ''} onClick={() => setView('character')} type="button">Персонаж</button>
        <button className={view === 'chat' ? 'active' : ''} onClick={() => setView('chat')} type="button">Чаты</button>
        <button className={view === 'guild' ? 'active' : ''} onClick={() => setView('guild')} type="button">Гильдия</button>
        <button className={view === 'account' ? 'active' : ''} onClick={() => setView('account')} type="button">Аккаунт</button>
      </nav><div className="sidebar-stats"><Stat label="Здоровье" value={game.health} max={game.maxHealth} /><Stat label="Силы" value={game.stamina} max={game.maxStamina} /><Stat label="Чутьё" value={game.insight} max={20} /><div className="coins"><span>Монеты</span><strong>{game.coins}</strong></div><div className="coins"><span>Репутация</span><strong>{game.reputation}</strong></div></div></aside>

      <main className="main-content">
        {view === 'journey' && (game.combat ? <CombatPanel game={game} onAction={handleCombat} /> : <section className="panel story-panel">{activeQuest && <div className="active-contract"><span>Активный контракт</span><strong>{activeQuest.title}</strong></div>}<header className="story-header"><p className="eyebrow">{scene.region}</p><h1>{scene.title}</h1></header><p className="story-text">{scene.text}</p><div className="choices">{scene.choices.map((choice) => { const allowed = canChoose(game, choice); const requirement = requirementText(game, choice); return <button disabled={!allowed} key={choice.id} onClick={() => handleChoice(choice)} type="button"><span>{choice.label}</span>{requirement && <small>{requirement}</small>}{!requirement && choice.requiresProfession && <small>Ремесло: {professionById[choice.requiresProfession].name}</small>}</button> })}</div></section>)}
        {view === 'journal' && <JournalPanel game={game} />}
        {view === 'character' && <section className="panel character-panel"><header className="panel-header"><div><p className="eyebrow">Живой человек, не класс</p><h2>{game.playerName}</h2></div><button className="danger-link" onClick={restart} type="button">Отказаться от забега</button></header><p><strong>{profession.name}.</strong> {profession.description}</p><div className="character-facts"><span>Уровень {game.level}</span><span>Репутация {game.reputation}</span><span>Контракты {game.completedQuestIds.length}</span><span>Очки развития {game.skillPoints}</span></div>{game.skillPoints > 0 && <div className="skill-spend"><h3>Развитие</h3><button type="button" onClick={() => setGame(spendSkillPoint(game, 'health'))}>+2 здоровья</button><button type="button" onClick={() => setGame(spendSkillPoint(game, 'stamina'))}>+2 силы</button><button type="button" onClick={() => setGame(spendSkillPoint(game, 'insight'))}>+2 чутья</button></div>}<div className="inventory"><h3>Снаряжение</h3>{game.inventory.length ? game.inventory.map((item, index) => <span key={`${item}-${index}`}>{item}</span>) : <p>Пусто</p>}</div><div className="chronicle"><h3>Последние события</h3>{game.history.map((entry, index) => <p key={`${entry}-${index}`}>{entry}</p>)}</div></section>}
        {view === 'chat' && <ChatPanel author={online?.user.displayName ?? game.playerName} guildId={online?.guild?.id ?? null} />}
        {view === 'guild' && <ServerGuildPanel game={game} snapshot={online} onGame={setGame} onSnapshot={setOnline} onGoAccount={() => setView('account')} />}
        {view === 'account' && <AccountPanel snapshot={online} status={onlineStatus} onRefresh={refreshOnline} onLogout={async () => { await logoutOnline(); setOnline(null); setOnlineStatus('guest'); clearGuildCache() }} />}
      </main>

      <footer className="mobile-nav"><button className={view === 'journey' ? 'active' : ''} onClick={() => setView('journey')} type="button">Путь</button><button className={view === 'journal' ? 'active' : ''} onClick={() => setView('journal')} type="button">Заказы</button><button className={view === 'character' ? 'active' : ''} onClick={() => setView('character')} type="button">Герой</button><button className={view === 'chat' ? 'active' : ''} onClick={() => setView('chat')} type="button">Чаты</button><button className={view === 'guild' ? 'active' : ''} onClick={() => setView('guild')} type="button">Гильдия</button><button className={view === 'account' ? 'active' : ''} onClick={() => setView('account')} type="button">Вход</button></footer>
    </div>
  )
}

export default App
