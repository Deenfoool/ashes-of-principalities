import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createApiHandler } from './api.mjs'
import { createPlayerApiHandler } from './player-api.mjs'
import { PlayerStore } from './player-store.mjs'
import { GameStore } from './store.mjs'

async function startApi() {
  const store = new GameStore(':memory:')
  const players = new PlayerStore(store)
  const playerHandler = createPlayerApiHandler(store, players)
  const apiHandler = createApiHandler(store)
  const server = createServer(async (request, response) => {
    if (await playerHandler(request, response)) return
    if (await apiHandler(request, response)) return
    response.writeHead(404).end()
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  return {
    store,
    base: `http://127.0.0.1:${address.port}`,
    close: async () => {
      await new Promise((resolve) => server.close(resolve))
      store.close()
    },
  }
}

async function request(base, path, { method = 'GET', cookie, body } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(cookie ? { Cookie: cookie } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  const setCookie = response.headers.get('set-cookie')
  return {
    status: response.status,
    data: await response.json(),
    cookie: setCookie?.split(';', 1)[0] ?? cookie ?? null,
  }
}

const rid = () => crypto.randomUUID().replaceAll('-', '')

test('server character flow is authenticated and idempotent', async () => {
  const api = await startApi()
  try {
    const account = await request(api.base, '/api/auth/register', {
      method: 'POST',
      body: { username: 'server_hero', password: '12345678', displayName: 'Серверный герой' },
    })
    const created = await request(api.base, '/api/player', {
      method: 'POST',
      cookie: account.cookie,
      body: { requestId: rid(), name: 'Остромир', profession: 'hunter' },
    })
    assert.equal(created.status, 201)
    assert.equal(created.data.character.name, 'Остромир')

    const startId = rid()
    const started = await request(api.base, '/api/player/expeditions', {
      method: 'POST',
      cookie: account.cookie,
      body: { requestId: startId, contractId: 'ash-wolf' },
    })
    const repeated = await request(api.base, '/api/player/expeditions', {
      method: 'POST',
      cookie: account.cookie,
      body: { requestId: startId, contractId: 'drowned-dead' },
    })
    assert.equal(started.data.character.activeExpedition.id, repeated.data.character.activeExpedition.id)
    assert.equal(repeated.data.character.stamina, created.data.character.stamina - 2)
  } finally {
    await api.close()
  }
})

test('guild progress cannot be posted directly by the client', async () => {
  const api = await startApi()
  try {
    const account = await request(api.base, '/api/auth/register', {
      method: 'POST',
      body: { username: 'progress_cheat', password: '12345678', displayName: 'Проверяющий' },
    })
    const response = await request(api.base, '/api/guilds/progress', {
      method: 'POST',
      cookie: account.cookie,
      body: { taskId: 'victories', amount: 10 },
    })
    assert.equal(response.status, 403)
    assert.equal(response.data.error.code, 'server-derived-progress')
  } finally {
    await api.close()
  }
})

test('treasury deposit requires server character money', async () => {
  const api = await startApi()
  try {
    const account = await request(api.base, '/api/auth/register', {
      method: 'POST',
      body: { username: 'real_coins', password: '12345678', displayName: 'Казначей' },
    })
    await request(api.base, '/api/guilds', {
      method: 'POST',
      cookie: account.cookie,
      body: { name: 'Честная казна', tag: 'ЧК' },
    })
    const withoutCharacter = await request(api.base, '/api/guilds/treasury/deposit', {
      method: 'POST',
      cookie: account.cookie,
      body: { requestId: rid(), amount: 5 },
    })
    assert.equal(withoutCharacter.status, 404)
    assert.equal(withoutCharacter.data.error.code, 'character-required')

    const created = await request(api.base, '/api/player', {
      method: 'POST',
      cookie: account.cookie,
      body: { requestId: rid(), name: 'Радован', profession: 'scribe' },
    })
    const donationId = rid()
    const donated = await request(api.base, '/api/guilds/treasury/deposit', {
      method: 'POST',
      cookie: account.cookie,
      body: { requestId: donationId, amount: 5 },
    })
    const repeated = await request(api.base, '/api/guilds/treasury/deposit', {
      method: 'POST',
      cookie: account.cookie,
      body: { requestId: donationId, amount: 5 },
    })
    assert.equal(donated.data.character.coins, created.data.character.coins - 5)
    assert.equal(repeated.data.guild.treasuryCoins, 5)
  } finally {
    await api.close()
  }
})
