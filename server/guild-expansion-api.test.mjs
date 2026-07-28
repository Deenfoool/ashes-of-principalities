import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createApiHandler } from './api.mjs'
import { createGuildExpansionApiHandler } from './guild-expansion-api.mjs'
import { GuildExpansionStore } from './guild-expansion-store.mjs'
import { installGuildV014Migrations } from './guild-v014-migrations.mjs'
import { PlayerStore } from './player-store.mjs'
import { GameStore } from './store.mjs'

async function startApi() {
  const game = new GameStore(':memory:')
  const players = new PlayerStore(game)
  installGuildV014Migrations(game.db)
  const expansion = new GuildExpansionStore(game, players)
  const expansionApi = createGuildExpansionApiHandler(game, expansion)
  const accountApi = createApiHandler(game)
  const server = createServer(async (request, response) => {
    if (await expansionApi(request, response)) return
    if (await accountApi(request, response)) return
    response.writeHead(404).end()
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  return {
    game,
    players,
    base: `http://127.0.0.1:${address.port}`,
    close: async () => {
      await new Promise((resolve) => server.close(resolve))
      game.close()
    },
  }
}

async function request(base, path, { method = 'GET', token, body } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  return {
    status: response.status,
    data: await response.json(),
    cacheControl: response.headers.get('cache-control'),
  }
}

test('guild expansion API requires auth and never caches private state', async () => {
  const api = await startApi()
  try {
    const guest = await request(api.base, '/api/guilds/expansion')
    assert.equal(guest.status, 401)
    assert.equal(guest.cacheControl, 'no-store')

    const account = api.game.register({ username: 'guild_api_v014', password: '12345678', displayName: 'Казначей' })
    api.players.createCharacter(account.user.id, {
      requestId: 'guild-api-character-v014',
      name: 'Казначей',
      profession: 'carter',
    })
    api.game.createGuild(account.user.id, { name: 'Казна API', tag: 'КА' })
    const snapshot = await request(api.base, '/api/guilds/expansion', { token: account.token })
    assert.equal(snapshot.status, 200)
    assert.equal(snapshot.cacheControl, 'no-store')
    assert.equal(snapshot.data.raid.boss.status, 'preparing')
  } finally { await api.close() }
})

test('resource API spends inventory exactly once for duplicate request id', async () => {
  const api = await startApi()
  try {
    const account = api.game.register({ username: 'guild_deposit_v014', password: '12345678', displayName: 'Складник' })
    api.players.createCharacter(account.user.id, {
      requestId: 'guild-api-character-v014-2',
      name: 'Складник',
      profession: 'carter',
    })
    const guild = api.game.createGuild(account.user.id, { name: 'Склад API', tag: 'СК' })
    api.players.addInventory(account.user.id, 'cloth', 'Грубая ткань', 5)
    const body = { itemId: 'cloth', quantity: 3, requestId: 'guild-api-deposit-v014' }
    const first = await request(api.base, '/api/guilds/resources/deposit', { method: 'POST', token: account.token, body })
    const repeated = await request(api.base, '/api/guilds/resources/deposit', { method: 'POST', token: account.token, body })
    assert.equal(first.status, 200)
    assert.equal(repeated.status, 200)
    assert.deepEqual(repeated.data, first.data)
    assert.equal(api.game.db.prepare("SELECT quantity FROM player_inventory WHERE user_id = ? AND item_id = 'cloth'").get(account.user.id).quantity, 2)
    assert.equal(api.game.db.prepare("SELECT quantity FROM guild_resource_stock WHERE guild_id = ? AND item_id = 'cloth'").get(guild.id).quantity, 3)
  } finally { await api.close() }
})
