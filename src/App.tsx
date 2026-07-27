import { useEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { professions, professionById } from './game/content'
import { applyChoice, canChoose, clearGame, createGame, getScene, loadGame, saveGame } from './game/engine'
import type { GameState, ProfessionId } from './game/types'

type View = 'journey' | 'character' | 'chat' | 'guild'
type ChatChannel = 'general' | 'trade' | 'guild'

interface ChatMessage {
  id: string
  channel: ChatChannel
  author: string
  text: string
  timestamp: number
  system?: boolean
}

const channelLabels: Record<ChatChannel, string> = {
  general: '#Общий',
  trade: '#Торговля',
  guild: '#Гильдия',
}

function CharacterCreation({ onCreate }: { onCreate: (professionId: ProfessionId) => void }) {
  const [selected, setSelected] = useState<ProfessionId>('hunter')
  const profession = professionById[selected]

  return (
    <main className="creation-shell">
      <section className="creation-intro">
        <p className="eyebrow">Текстовая RPG-рогалик</p>
        <h1>Пепел Княжеств</h1>
        <p>
          Здесь нет избранных. Есть ремесло, долги и дорога, которая переживёт тебя.
          Выбери, кем ты был до того, как княжества начали гореть.
        </p>
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
          <p className="eyebrow">Выбранное ремесло</p>
          <h2>{profession.name}</h2>
          <p>{profession.description}</p>
        </div>
        <dl>
          <div><dt>Преимущество</dt><dd>{profession.bonus}</dd></div>
          <div><dt>Начальный предмет</dt><dd>{profession.startingItem}</dd></div>
        </dl>
        <button className="primary-action" type="button" onClick={() => onCreate(selected)}>
          Выйти на дорогу
        </button>
      </section>
    </main>
  )
}

function Stat({ label, value, max = 12 }: { label: string; value: number; max?: number }) {
  const width = `${Math.min(100, Math.max(0, (value / max) * 100))}%`
  return (
    <div className="stat">
      <div><span>{label}</span><strong>{value}</strong></div>
      <div className="stat-track"><span style={{ width }} /></div>
    </div>
  )
}

function ChatPanel() {
  const [channel, setChannel] = useState<ChatChannel>('general')
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [text, setText] = useState('')
  const [status, setStatus] = useState<'connecting' | 'online' | 'offline'>('connecting')
  const socketRef = useRef<WebSocket | null>(null)

  useEffect(() => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const socket = new WebSocket(`${protocol}//${window.location.host}/ws`)
    socketRef.current = socket

    socket.addEventListener('open', () => setStatus('online'))
    socket.addEventListener('close', () => setStatus('offline'))
    socket.addEventListener('error', () => setStatus('offline'))
    socket.addEventListener('message', (event) => {
      try {
        const payload = JSON.parse(String(event.data)) as { type: string; messages?: ChatMessage[]; message?: ChatMessage }
        if (payload.type === 'history' && payload.messages) setMessages(payload.messages)
        if (payload.type === 'message' && payload.message) {
          setMessages((current) => [...current.slice(-79), payload.message!])
        }
      } catch {
        // Ignore malformed network payloads without breaking the game shell.
      }
    })

    return () => socket.close()
  }, [])

  const visibleMessages = messages.filter((message) => message.channel === channel)

  const submit = (event: FormEvent) => {
    event.preventDefault()
    const clean = text.trim()
    if (!clean || socketRef.current?.readyState !== WebSocket.OPEN) return
    socketRef.current.send(JSON.stringify({ type: 'message', channel, text: clean, author: 'Странник' }))
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
          <button className={channel === id ? 'active' : ''} key={id} onClick={() => setChannel(id)} type="button">
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
        <input maxLength={280} onChange={(event) => setText(event.target.value)} placeholder={`Написать в ${channelLabels[channel]}`} value={text} />
        <button disabled={status !== 'online' || !text.trim()} type="submit">Отправить</button>
      </form>
    </section>
  )
}

function App() {
  const [game, setGame] = useState<GameState | null>(() => loadGame())
  const [view, setView] = useState<View>('journey')

  useEffect(() => {
    if (game) saveGame(game)
  }, [game])

  const scene = useMemo(() => game ? getScene(game) : null, [game])
  const profession = game ? professionById[game.professionId] : null

  if (!game || !scene || !profession) {
    return <CharacterCreation onCreate={(professionId) => setGame(createGame(professionId))} />
  }

  const restart = () => {
    clearGame()
    setGame(null)
    setView('journey')
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand"><span className="brand-mark">ПК</span><div><strong>Пепел Княжеств</strong><small>{scene.region}</small></div></div>
        <div className="world-clock"><span>День {game.day}</span><strong>{String(game.hour).padStart(2, '0')}:00</strong></div>
      </header>

      <aside className="sidebar">
        <nav aria-label="Основная навигация">
          <button className={view === 'journey' ? 'active' : ''} onClick={() => setView('journey')} type="button">Путь</button>
          <button className={view === 'character' ? 'active' : ''} onClick={() => setView('character')} type="button">Персонаж</button>
          <button className={view === 'chat' ? 'active' : ''} onClick={() => setView('chat')} type="button">Чаты</button>
          <button className={view === 'guild' ? 'active' : ''} onClick={() => setView('guild')} type="button">Гильдия</button>
        </nav>
        <div className="sidebar-stats">
          <Stat label="Здоровье" value={game.health} />
          <Stat label="Силы" value={game.stamina} />
          <Stat label="Чутьё" value={game.insight} />
          <div className="coins"><span>Монеты</span><strong>{game.coins}</strong></div>
        </div>
      </aside>

      <main className="main-content">
        {view === 'journey' && (
          <section className="panel story-panel">
            <header className="story-header"><p className="eyebrow">{scene.region}</p><h1>{scene.title}</h1></header>
            <p className="story-text">{scene.text}</p>
            <div className="choices">
              {scene.choices.map((choice) => {
                const allowed = canChoose(game, choice)
                return (
                  <button
                    disabled={!allowed}
                    key={choice.id}
                    onClick={() => setGame((current) => current ? applyChoice(current, choice) : current)}
                    type="button"
                  >
                    <span>{choice.label}</span>
                    {choice.requiresProfession && <small>{allowed ? `Ремесло: ${professionById[choice.requiresProfession].name}` : `Требуется: ${professionById[choice.requiresProfession].name}`}</small>}
                  </button>
                )
              })}
            </div>
          </section>
        )}

        {view === 'character' && (
          <section className="panel character-panel">
            <header className="panel-header"><div><p className="eyebrow">Живой человек, не класс</p><h2>{profession.name}</h2></div><button className="danger-link" onClick={restart} type="button">Начать заново</button></header>
            <p>{profession.description}</p>
            <div className="inventory"><h3>Снаряжение</h3>{game.inventory.map((item) => <span key={item}>{item}</span>)}</div>
            <div className="chronicle"><h3>Последние события</h3>{game.history.map((entry, index) => <p key={`${entry}-${index}`}>{entry}</p>)}</div>
          </section>
        )}

        {view === 'chat' && <ChatPanel />}

        {view === 'guild' && (
          <section className="panel guild-panel">
            <p className="eyebrow">Общее дело</p>
            <h2>Ты не состоишь в гильдии</h2>
            <p>В первом патче гильдии объединяют до 20 игроков, получают еженедельные задания и развивают пять ветвей общего дерева.</p>
            <div className="guild-rules">
              <span>Вступление по приглашению</span><span>Казна ресурсов и монет</span><span>Свои роли и права</span><span>Сезон: календарный месяц</span>
            </div>
            <button className="primary-action" disabled type="button">Система гильдий — следующий этап</button>
          </section>
        )}
      </main>

      <footer className="mobile-nav">
        <button className={view === 'journey' ? 'active' : ''} onClick={() => setView('journey')} type="button">Путь</button>
        <button className={view === 'character' ? 'active' : ''} onClick={() => setView('character')} type="button">Герой</button>
        <button className={view === 'chat' ? 'active' : ''} onClick={() => setView('chat')} type="button">Чаты</button>
        <button className={view === 'guild' ? 'active' : ''} onClick={() => setView('guild')} type="button">Гильдия</button>
      </footer>
    </div>
  )
}

export default App
