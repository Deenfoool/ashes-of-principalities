import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'

type Channel = 'general' | 'trade' | 'guild'
interface ChatMessage {
  id: string
  channel: Channel
  author: string
  text: string
  timestamp: number
  system?: boolean
  guildId?: string | null
}

const labels: Record<Channel, string> = {
  general: '#Общий',
  trade: '#Торговля',
  guild: '#Гильдия',
}

function guestId() {
  const key = 'ashes-of-principalities:player-id'
  const existing = localStorage.getItem(key)
  if (existing) return existing
  const created = crypto.randomUUID()
  localStorage.setItem(key, created)
  return created
}

export default function UnifiedChat({ author, guildId }: { author: string; guildId: string | null }) {
  const [channel, setChannel] = useState<Channel>('general')
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [text, setText] = useState('')
  const [status, setStatus] = useState<'connecting' | 'online' | 'offline'>('connecting')
  const socket = useRef<WebSocket | null>(null)

  useEffect(() => {
    let stopped = false
    let timer: number | undefined
    let attempt = 0
    const connect = () => {
      if (stopped) return
      setStatus('connecting')
      const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
      const next = new WebSocket(`${protocol}//${location.host}/ws`)
      socket.current = next
      next.addEventListener('open', () => {
        attempt = 0
        setStatus('online')
        next.send(JSON.stringify({ type: 'hello', playerId: guestId(), author }))
      })
      next.addEventListener('message', (event) => {
        try {
          const packet = JSON.parse(String(event.data)) as { type: string; messages?: ChatMessage[]; message?: ChatMessage }
          if (packet.type === 'history' && packet.messages) setMessages(packet.messages)
          if (packet.type === 'message' && packet.message) setMessages((current) => [...current.slice(-149), packet.message!])
        } catch {
          // A malformed packet never breaks the interface.
        }
      })
      next.addEventListener('close', () => {
        if (stopped) return
        setStatus('offline')
        attempt += 1
        timer = window.setTimeout(connect, Math.min(10000, 600 * 2 ** attempt))
      })
      next.addEventListener('error', () => next.close())
    }
    connect()
    return () => {
      stopped = true
      if (timer) clearTimeout(timer)
      socket.current?.close()
    }
  }, [author, guildId])

  useEffect(() => {
    if (channel === 'guild' && !guildId) setChannel('general')
  }, [channel, guildId])

  const visible = messages.filter((message) => message.channel === channel && (channel !== 'guild' || message.guildId === guildId))
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const clean = text.trim()
    if (!clean || socket.current?.readyState !== WebSocket.OPEN) return
    socket.current.send(JSON.stringify({ type: 'message', channel, text: clean }))
    setText('')
  }

  return <section className="u-panel u-chat">
    <header className="u-section-head"><div><p className="eyebrow">Голоса у общего костра</p><h2>Чаты</h2></div><span className={`u-connection ${status}`}>{status === 'online' ? 'В сети' : status === 'connecting' ? 'Подключение' : 'Нет связи'}</span></header>
    <div className="u-tabs">{(Object.keys(labels) as Channel[]).map((id) => <button className={channel === id ? 'active' : ''} disabled={id === 'guild' && !guildId} key={id} onClick={() => setChannel(id)} type="button">{labels[id]}</button>)}</div>
    <div className="u-messages">{visible.length === 0 ? <p className="u-empty">Здесь пока тихо.</p> : visible.map((message) => <article className={message.system ? 'system' : ''} key={message.id}><div><strong>{message.author}</strong><time>{new Date(message.timestamp).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}</time></div><p>{message.text}</p></article>)}</div>
    <form className="u-chat-form" onSubmit={submit}><input maxLength={280} onChange={(event) => setText(event.target.value)} placeholder={`Написать в ${labels[channel]}`} value={text} /><button disabled={status !== 'online' || !text.trim()} type="submit">Отправить</button></form>
  </section>
}