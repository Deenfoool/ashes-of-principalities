import test from 'node:test'
import assert from 'node:assert/strict'
import { canReceive, cleanAuthor, cleanText, parsePacket, visibleHistory } from './protocol.mjs'

test('cleanText removes control characters and compresses whitespace', () => {
  assert.equal(cleanText('  привет\u0000   мир  ', 30), 'привет мир')
})

test('author always has a safe fallback and a length limit', () => {
  assert.equal(cleanAuthor('   '), 'Странник')
  assert.equal(cleanAuthor('а'.repeat(40)).length, 24)
})

test('hello packet requires a player id', () => {
  assert.equal(parsePacket(JSON.stringify({ type: 'hello', author: 'Мирослав' })).ok, false)
  const result = parsePacket(JSON.stringify({ type: 'hello', playerId: 'abc', author: 'Мирослав', guildId: 'guild-1' }))
  assert.equal(result.ok, true)
  assert.equal(result.packet.guildId, 'guild-1')
})

test('message packet rejects unknown channels and empty text', () => {
  assert.equal(parsePacket(JSON.stringify({ type: 'message', channel: 'admin', text: 'test' })).ok, false)
  assert.equal(parsePacket(JSON.stringify({ type: 'message', channel: 'general', text: '   ' })).ok, false)
  assert.equal(parsePacket(JSON.stringify({ type: 'message', channel: 'trade', text: 'Продам меч' })).ok, true)
})

test('guild messages are visible only to the same guild', () => {
  const message = { channel: 'guild', guildId: 'g1' }
  assert.equal(canReceive(message, { guildId: 'g1' }), true)
  assert.equal(canReceive(message, { guildId: 'g2' }), false)
  assert.equal(canReceive({ channel: 'general', guildId: null }, { guildId: null }), true)
})

test('visibleHistory filters foreign guild messages', () => {
  const messages = [
    { id: '1', channel: 'general', guildId: null },
    { id: '2', channel: 'guild', guildId: 'g1' },
    { id: '3', channel: 'guild', guildId: 'g2' },
  ]
  assert.deepEqual(visibleHistory(messages, { guildId: 'g1' }).map((item) => item.id), ['1', '2'])
})
