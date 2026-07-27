const channels = new Set(['general', 'trade', 'guild'])

export const cleanText = (value, limit) => String(value ?? '')
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
  .replace(/\s+/g, ' ')
  .trim()
  .slice(0, limit)

export const cleanAuthor = (value) => cleanText(value, 24) || 'Странник'
export const cleanGuildId = (value) => cleanText(value, 64) || null
export const cleanPlayerId = (value) => cleanText(value, 64) || null

export function parsePacket(raw) {
  let payload
  try {
    payload = JSON.parse(String(raw))
  } catch {
    return { ok: false, error: 'invalid-json' }
  }

  if (payload?.type === 'hello') {
    const playerId = cleanPlayerId(payload.playerId)
    if (!playerId) return { ok: false, error: 'missing-player-id' }
    return {
      ok: true,
      packet: {
        type: 'hello',
        playerId,
        author: cleanAuthor(payload.author),
        guildId: cleanGuildId(payload.guildId),
      },
    }
  }

  if (payload?.type === 'message') {
    const channel = cleanText(payload.channel, 16)
    const text = cleanText(payload.text, 280)
    if (!channels.has(channel) || !text) return { ok: false, error: 'invalid-message' }
    return { ok: true, packet: { type: 'message', channel, text } }
  }

  return { ok: false, error: 'unknown-packet' }
}

export function createChatMessage({ channel, author, text, guildId = null, system = false }) {
  return {
    id: crypto.randomUUID(),
    channel,
    author: cleanAuthor(author),
    text: cleanText(text, 280),
    timestamp: Date.now(),
    guildId: channel === 'guild' ? cleanGuildId(guildId) : null,
    system,
  }
}

export function canReceive(message, session) {
  if (message.channel !== 'guild') return true
  return Boolean(message.guildId && session.guildId && message.guildId === session.guildId)
}

export function visibleHistory(messages, session, limit = 120) {
  return messages.filter((message) => canReceive(message, session)).slice(-limit)
}
