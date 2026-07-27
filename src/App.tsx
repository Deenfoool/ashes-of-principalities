import { useEffect, useMemo, useRef, useState } from 'react'
import type { ChangeEvent, FormEvent } from 'react'
import { enemyById, professionById, professions, questById, quests } from './game/content'
import {
  applyChoice,
  canChoose,
  clearGame,
  createGame,
  createGuild,
  depositGuildCoins,
  experienceForNextLevel,
  getGuildBonusMultiplier,
  getScene,
  guildExperienceForNextLevel,
  loadGame,
  loadGuild,
  loadLegacy,
  performCombatAction,
  resetGuildTree,
  saveGame,
  spendSkillPoint,
  upgradeGuildBranch,
} from './game/engine'
import type { CombatAction } from './game/engine'
import type { Choice, GameState, GuildBranchId, GuildState, LegacyState, ProfessionId } from './game/types'

type View = 'journey' | 'journal' | 'character' | 'chat' | 'guild'
type ChatChannel = 'general' | 'trade' | 'guild'

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
  foraging: { name: 'Промысел', description: 'Подготавливает будущую добычу ресурсов и снижает дорожные потери.' },
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
          <button
            className={`profession-card ${selected === item.id ? 'selected' : ''}`}
            key={item.id}
            onClick={() => setSelected(item.id)}
            type="button"
          >
            <span>{item.name}</span>
            <small>{item.epithet}</small>
          </button>
        ))}
      </section>

      <section className="profession-detail">
        <div>
          <p className="eyebrow">Новый человек</p>
          <h2>{profession.name}</h2>
          <p>{profession.description}</p>
        </div>
        <label className="field-label">
          Имя персонажа
          <input maxLength={24} onChange={(event: ChangeEvent<HTMLInputElement>) => setName(event.target.value)} placeholder="Например, Мирослав" value={name} />
        </label>
        <dl>
          <div><dt>Преимущество</dt><dd>{profession.bonus}</dd></div>
          <div><dt>Начальный предмет</dt><dd>{profession.startingItem}</dd></div>
          {legacy.heirlooms[0] && <div><dt>Наследство</dt><dd>{legacy.heirlooms[0]}</dd></div>}
        </dl>
        <button className="primary-action" disabled={name.trim().length < 2} type="button" onClick={() => onCreate(name, selected)}>
          Выйти на дорогу
        </button>
      </section>
    </main>
  )
}

function Stat({ label, value, max }: { label: string; value: number; max: number }) {
  const width = `${Math.min(100, Math.max(0, (value / Math.max(1, max)) * 100))}%`
  return (
    <div className="stat">
      <div><span>{label}</span><strong>{value}/{max}</strong></div>
      <div className="stat-track"><span style={{ width }} /></div>
    </div>
  )
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
        <div>
          <p className="eyebrow">Опасное столкновение · ход {combat.turn}</p>
          <h1>{enemy.name}</h1>
          <p>{enemy.description}</p>
        </div>
        <div className="enemy-health">
          <span>Здоровье врага</span>
          <strong>{combat.enemyHealth}/{enemy.maxHealth}</strong>
          <div className="enemy-track"><span style={{ width: enemyPercent }} /></div>
        </div>
      </header>

      <div className="enemy-intent"><strong>Намерение:</strong> противник {intentLabels[combat.intent]}.</div>

      <div className="combat-actions">
        <button type="button" onClick={() => onAction('strike')}>Атаковать</button>
        <button type="button" onClick={() => onAction('guard')}>Защищаться</button>
        <button disabled={game.stamina < 1} type="button" onClick={() => onAction('focus')}>Изучить противника</button>
        <button disabled={combat.professionUsed || (game.professionId === 'hunter' && game.stamina < 2)} type="button" onClick={() => onAction('profession')}>
          {professionCombatLabels[game.professionId]}
        </button>
        <button disabled={!game.inventory.includes('Лечебный сбор')} type="button" onClick={() => onAction('heal')}>Лечебный сбор</button>
        <button className="flee-action" disabled={game.stamina < 3} type="button" onClick={() => onAction('flee')}>Отступить</button>
      </div>

      <div className="combat-log">
        <h3>Ход боя</h3>
        {combat.log.map((entry, index) => <p key={`${entry}-${index}`}>{entry}</p>)}
      </div>
    </section>
  )
}

function ChatPanel({ author, guild }: { author: string; guild: GuildState | null }) {
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
        socket.send(JSON.stringify({ type: 'hello', playerId: getPlayerId(), author, guildId: guild?.id ?? null }))
      })
      socket.addEventListener('message', (event) => {
        try {
          const payload = JSON.parse(String(event.data)) as { type: string; messages?: ChatMessage[]; message?: ChatMessage }
          if (payload.type === 'history' && payload.messages) setMessages(payload.messages)
          if (payload.type === 'message' && payload.message) setMessages((current) => [...current.slice(-119), payload.message!])
        } catch {
          // A malformed packet must not break the game interface.
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
  }, [author, guild?.id])

  useEffect(() => {
    if (channel === 'guild' && !guild) setChannel('general')
  }, [channel, guild])

  const visibleMessages = messages.filter((message) => message.channel === channel && (channel !== 'guild' || message.guildId === guild?.id))

  const submit = (event: FormEvent) => {
    event.preventDefault()
    const clean = text.trim()
    if (!clean || socketRef.current?.readyState !== WebSocket.OPEN) return
    socketRef.current.send(JSON.stringify({ type: 'message', channel, text: clean }))
    setText('')
  }

  return (
    <section className="panel chat-panel">
      <header className="panel-header">
        <div><p className="eyebrow">Связь между путниками</p><h2>Чаты</h2></div>
        <span className={`connection ${status}`}>{status === 'online' ? 'В сети' : status === 'connecting' ? 'Подключение' : 'Нет связи'}</span>
      </header>
      <div className="channel-tabs">
        {(Object.keys(channelLabels) as ChatChannel[]).map((id) => (
          <button disabled={id === 'guild' && !guild} className={channel === id ? 'active' : ''} key={id} onClick={() => setChannel(id)} type="button">
            {channelLabels[id]}
          </button>
        ))}
      </div>
      <div className="messages" aria-live="polite">
        {visibleMessages.length === 0 ? (
          <p className="empty-state">Здесь пока тихо. Первое сообщение тоже становится частью истории.</p>
        ) : visibleMessages.map((message) => (
          <article className={message.system ? 'system-message' : ''} key={message.id}>
            <div><strong>{message.author}</strong><time>{new Date(message.timestamp).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}</time></div>
            <p>{message.text}</p>
          </article>
        ))}
      </div>
      <form className="chat-form" onSubmit={submit}>
        <input maxLength={280} onChange={(event: ChangeEvent<HTMLInputElement>) => setText(event.target.value)} placeholder={`Написать в ${channelLabels[channel]}`} value={text} />
        <button disabled={status !== 'online' || !text.trim()} type="submit">Отправить</button>
      </form>
    </section>
  )
}

function JournalPanel({ game }: { game: GameState }) {
  return (
    <section className="panel journal-panel">
      <header className="panel-header"><div><p className="eyebrow">Не список поручений, а след решений</p><h2>Контракты</h2></div><strong>{game.completedQuestIds.length}/3</strong></header>
      <div className="quest-list">
        {quests.map((quest) => {
          const active = game.activeQuestId === quest.id
          const completed = game.completedQuestIds.includes(quest.id)
          return (
            <article className={active ? 'active' : completed ? 'completed' : ''} key={quest.id}>
              <div><span>{completed ? 'Завершён' : active ? 'Активен' : quest.danger}</span><h3>{quest.title}</h3></div>
              <p>{quest.summary}</p>
              <small>{quest.reward}</small>
            </article>
          )
        })}
      </div>
    </section>
  )
}

function GuildPanel({ game, guild, onGame, onGuild }: { game: GameState; guild: GuildState | null; onGame: (game: GameState) => void; onGuild: (guild: GuildState) => void }) {
  const [name, setName] = useState('')
  const [tag, setTag] = useState('')
  const [deposit, setDeposit] = useState('10')
  const [error, setError] = useState<string | null>(null)

  if (!guild) {
    const hasSeal = game.inventory.includes('Печать основателя')
    return (
      <section className="panel guild-panel">
        <p className="eyebrow">Общее дело</p>
        <h2>Основать гильдию</h2>
        <p>Гильдия объединяет до 20 игроков. Для основания нужны 12 монет и редкая Печать основателя, которую получает человек после первого завершённого контракта.</p>
        <div className="guild-cost"><span className={game.coins >= 12 ? 'ready' : ''}>Монеты: {game.coins}/12</span><span className={hasSeal ? 'ready' : ''}>Печать: {hasSeal ? 'есть' : 'нет'}</span></div>
        <div className="guild-create-form">
          <label className="field-label">Название<input maxLength={28} value={name} onChange={(event: ChangeEvent<HTMLInputElement>) => setName(event.target.value)} placeholder="Например, Серые вороны" /></label>
          <label className="field-label">Тег<input maxLength={5} value={tag} onChange={(event: ChangeEvent<HTMLInputElement>) => setTag(event.target.value)} placeholder="СВ" /></label>
          <button className="primary-action" type="button" onClick={() => {
            const result = createGuild(game, name, tag)
            setError(result.error)
            if (result.guild) {
              onGame(result.game)
              onGuild(result.guild)
            }
          }}>Основать гильдию</button>
        </div>
        {error && <p className="form-error">{error}</p>}
      </section>
    )
  }

  const bonusMultiplier = getGuildBonusMultiplier(guild)
  const guildXpTarget = guildExperienceForNextLevel(guild.level)
  return (
    <section className="panel guild-panel">
      <header className="guild-heading">
        <div><p className="eyebrow">[{guild.tag}] · 1/20 участников</p><h2>{guild.name}</h2></div>
        <div><span>Уровень {guild.level}</span><strong>{guild.experience}/{guildXpTarget} опыта</strong></div>
      </header>

      <div className="guild-status-grid">
        <article><span>Бонус участника</span><strong>×{bonusMultiplier.toFixed(1)}</strong><small>{bonusMultiplier === 0 ? 'Включится через 4 часа после вступления' : bonusMultiplier === 0.5 ? 'Полная сила включится через 8 часов' : 'Работает полностью'}</small></article>
        <article><span>Казна</span><strong>{guild.treasuryCoins} монет</strong><small>{guild.treasuryResources} ресурсов</small></article>
        <article><span>Очки дерева</span><strong>{guild.treePoints}</strong><small>Новые очки выдаются за уровни гильдии</small></article>
      </div>

      <div className="guild-section">
        <div className="section-title"><div><p className="eyebrow">Пять путей развития</p><h3>Дерево гильдии</h3></div><button type="button" onClick={() => {
          const result = resetGuildTree(guild)
          setError(result.error)
          onGuild(result.guild)
        }}>Сбросить раз в сезон</button></div>
        <div className="branch-grid">
          {(Object.keys(branchInfo) as GuildBranchId[]).map((branch) => (
            <article key={branch}>
              <div><h4>{branchInfo[branch].name}</h4><strong>{guild.branches[branch]}/5</strong></div>
              <p>{branchInfo[branch].description}</p>
              <button disabled={guild.treePoints < 1 || guild.branches[branch] >= 5} type="button" onClick={() => {
                const result = upgradeGuildBranch(guild, branch)
                setError(result.error)
                onGuild(result.guild)
              }}>Улучшить</button>
            </article>
          ))}
        </div>
      </div>

      <div className="guild-section">
        <p className="eyebrow">Обновляются каждый понедельник</p><h3>Еженедельные задания</h3>
        <div className="guild-tasks">
          {guild.tasks.map((task) => (
            <article className={task.completed ? 'completed' : ''} key={task.id}>
              <div><strong>{task.title}</strong><span>{task.current}/{task.target}</span></div>
              <div className="task-track"><span style={{ width: `${Math.min(100, task.current / task.target * 100)}%` }} /></div>
              <small>Награда: {task.experienceReward} опыта гильдии</small>
            </article>
          ))}
        </div>
      </div>

      <div className="guild-section treasury-form">
        <div><p className="eyebrow">Все операции должны попадать в журнал</p><h3>Взнос в казну</h3></div>
        <input min="1" type="number" value={deposit} onChange={(event: ChangeEvent<HTMLInputElement>) => setDeposit(event.target.value)} />
        <button type="button" onClick={() => {
          const result = depositGuildCoins(game, guild, Number(deposit))
          setError(result.error)
          onGame(result.game)
          onGuild(result.guild)
        }}>Внести монеты</button>
      </div>
      {error && <p className="form-error">{error}</p>}
    </section>
  )
}

function DeathScreen({ game, onContinue }: { game: GameState; onContinue: () => void }) {
  const legacy = loadLegacy()
  return (
    <main className="death-screen">
      <p className="eyebrow">Дорога запомнила ещё одно имя</p>
      <h1>{game.playerName} погиб</h1>
      <p>{game.deathReason}</p>
      <div className="death-legacy">
        <span>Уровень: <strong>{game.level}</strong></span>
        <span>Завершено контрактов: <strong>{game.completedQuestIds.length}</strong></span>
        <span>Родовая слава: <strong>{legacy.renown}</strong></span>
        <span>Сохранённые реликвии: <strong>{legacy.heirlooms.length}</strong></span>
      </div>
      <button className="primary-action" type="button" onClick={onContinue}>Создать наследника</button>
    </main>
  )
}

function App() {
  const [game, setGame] = useState<GameState | null>(() => loadGame())
  const [guild, setGuild] = useState<GuildState | null>(() => loadGuild())
  const [legacy, setLegacy] = useState<LegacyState>(() => loadLegacy())
  const [view, setView] = useState<View>('journey')

  useEffect(() => {
    if (game) {
      saveGame(game)
      setGuild(loadGuild())
    }
  }, [game])

  const scene = useMemo(() => game ? getScene(game) : null, [game])
  const profession = game ? professionById[game.professionId] : null

  if (!game || !scene || !profession) {
    return <CharacterCreation legacy={legacy} onCreate={(name, professionId) => setGame(createGame(name, professionId, legacy))} />
  }

  if (game.isDead) {
    return <DeathScreen game={game} onContinue={() => {
      clearGame()
      setGame(null)
      setGuild(loadGuild())
      setLegacy(loadLegacy())
      setView('journey')
    }} />
  }

  const restart = () => {
    clearGame()
    setGame(null)
    setLegacy(loadLegacy())
    setView('journey')
  }

  const activeQuest = game.activeQuestId ? questById[game.activeQuestId] : null
  const experienceTarget = experienceForNextLevel(game.level)

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand"><span className="brand-mark">ПК</span><div><strong>Пепел Княжеств</strong><small>{scene.region}</small></div></div>
        <div className="topbar-progress"><span>{game.playerName} · {profession.name}</span><strong>Ур. {game.level} · {game.experience}/{experienceTarget} опыта</strong></div>
        <div className="world-clock"><span>День {game.day}</span><strong>{String(game.hour).padStart(2, '0')}:00</strong></div>
      </header>

      <aside className="sidebar">
        <nav aria-label="Основная навигация">
          <button className={view === 'journey' ? 'active' : ''} onClick={() => setView('journey')} type="button">Путь</button>
          <button className={view === 'journal' ? 'active' : ''} onClick={() => setView('journal')} type="button">Контракты</button>
          <button className={view === 'character' ? 'active' : ''} onClick={() => setView('character')} type="button">Персонаж</button>
          <button className={view === 'chat' ? 'active' : ''} onClick={() => setView('chat')} type="button">Чаты</button>
          <button className={view === 'guild' ? 'active' : ''} onClick={() => setView('guild')} type="button">Гильдия</button>
        </nav>
        <div className="sidebar-stats">
          <Stat label="Здоровье" value={game.health} max={game.maxHealth} />
          <Stat label="Силы" value={game.stamina} max={game.maxStamina} />
          <Stat label="Чутьё" value={game.insight} max={20} />
          <div className="coins"><span>Монеты</span><strong>{game.coins}</strong></div>
          <div className="coins"><span>Репутация</span><strong>{game.reputation}</strong></div>
        </div>
      </aside>

      <main className="main-content">
        {view === 'journey' && (game.combat ? (
          <CombatPanel game={game} onAction={(action) => setGame((current) => current ? performCombatAction(current, action) : current)} />
        ) : (
          <section className="panel story-panel">
            {activeQuest && <div className="active-contract"><span>Активный контракт</span><strong>{activeQuest.title}</strong></div>}
            <header className="story-header"><p className="eyebrow">{scene.region}</p><h1>{scene.title}</h1></header>
            <p className="story-text">{scene.text}</p>
            <div className="choices">
              {scene.choices.map((choice) => {
                const allowed = canChoose(game, choice)
                const requirement = requirementText(game, choice)
                return (
                  <button disabled={!allowed} key={choice.id} onClick={() => setGame((current) => current ? applyChoice(current, choice) : current)} type="button">
                    <span>{choice.label}</span>
                    {requirement && <small>{requirement}</small>}
                    {!requirement && choice.requiresProfession && <small>Ремесло: {professionById[choice.requiresProfession].name}</small>}
                  </button>
                )
              })}
            </div>
          </section>
        ))}

        {view === 'journal' && <JournalPanel game={game} />}

        {view === 'character' && (
          <section className="panel character-panel">
            <header className="panel-header"><div><p className="eyebrow">Живой человек, не класс</p><h2>{game.playerName}</h2></div><button className="danger-link" onClick={restart} type="button">Отказаться от забега</button></header>
            <p><strong>{profession.name}.</strong> {profession.description}</p>
            <div className="character-facts"><span>Уровень {game.level}</span><span>Репутация {game.reputation}</span><span>Контракты {game.completedQuestIds.length}</span><span>Очки развития {game.skillPoints}</span></div>
            {game.skillPoints > 0 && (
              <div className="skill-spend">
                <h3>Развитие</h3>
                <button type="button" onClick={() => setGame((current) => current ? spendSkillPoint(current, 'health') : current)}>+2 здоровья</button>
                <button type="button" onClick={() => setGame((current) => current ? spendSkillPoint(current, 'stamina') : current)}>+2 силы</button>
                <button type="button" onClick={() => setGame((current) => current ? spendSkillPoint(current, 'insight') : current)}>+2 чутья</button>
              </div>
            )}
            <div className="inventory"><h3>Снаряжение</h3>{game.inventory.length ? game.inventory.map((item, index) => <span key={`${item}-${index}`}>{item}</span>) : <p>Пусто</p>}</div>
            <div className="chronicle"><h3>Последние события</h3>{game.history.map((entry, index) => <p key={`${entry}-${index}`}>{entry}</p>)}</div>
          </section>
        )}

        {view === 'chat' && <ChatPanel author={game.playerName} guild={guild} />}
        {view === 'guild' && <GuildPanel game={game} guild={guild} onGame={setGame} onGuild={setGuild} />}
      </main>

      <footer className="mobile-nav">
        <button className={view === 'journey' ? 'active' : ''} onClick={() => setView('journey')} type="button">Путь</button>
        <button className={view === 'journal' ? 'active' : ''} onClick={() => setView('journal')} type="button">Заказы</button>
        <button className={view === 'character' ? 'active' : ''} onClick={() => setView('character')} type="button">Герой</button>
        <button className={view === 'chat' ? 'active' : ''} onClick={() => setView('chat')} type="button">Чаты</button>
        <button className={view === 'guild' ? 'active' : ''} onClick={() => setView('guild')} type="button">Гильдия</button>
      </footer>
    </div>
  )
}

export default App
