import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createApiHandler } from './api.mjs'
import { GameStore } from './store.mjs'

async function startApi() {
  const store = new GameStore(':memory:')
  const handler = createApiHandler(store)
  const server = createServer(async (request, response) => {
    if (!(await handler(request, response))) response.writeHead(404).end()
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
    setCookie,
  }
}

test('account and guild HTTP flow uses HttpOnly session cookies', async () => {
  const api = await startApi()
  try {
    const founder = await request(api.base, '/api/auth/register', {
      method: 'POST',
      body: { username: 'founder', password: '12345678', displayName: 'Основатель' },
    })
    assert.equal(founder.status, 201)
    assert.match(founder.setCookie, /HttpOnly/)
    assert.match(founder.setCookie, /SameSite=Lax/)
    assert.equal('token' in founder.data, false)

    const recruit = await request(api.base, '/api/auth/register', {
      method: 'POST',
      body: { username: 'recruit', password: 'abcdefgh', displayName: 'Новобранец' },
    })
    const created = await request(api.base, '/api/guilds', {
      method: 'POST', cookie: founder.cookie, body: { name: 'Серые вороны', tag: 'СВ' },
    })
    assert.equal(created.status, 201)
    const invite = await request(api.base, '/api/guilds/invites', {
      method: 'POST', cookie: founder.cookie, body: { username: 'recruit' },
    })
    assert.equal(invite.status, 201)
    const snapshot = await request(api.base, '/api/online', { cookie: recruit.cookie })
    assert.equal(snapshot.data.invites.length, 1)
    const accepted = await request(api.base, `/api/guilds/invites/${invite.data.invite.id}/accept`, {
      method: 'POST', cookie: recruit.cookie,
    })
    assert.equal(accepted.data.guild.memberCount, 2)
    const deposit = await request(api.base, '/api/guilds/treasury/deposit', {
      method: 'POST', cookie: recruit.cookie, body: { amount: 7 },
    })
    assert.equal(deposit.data.guild.treasuryCoins, 7)
    const members = await request(api.base, '/api/guilds/members', { cookie: founder.cookie })
    assert.equal(members.data.members.length, 2)
  } finally {
    await api.close()
  }
})

test('protected routes reject missing cookies', async () => {
  const api = await startApi()
  try {
    const response = await request(api.base, '/api/online')
    assert.equal(response.status, 401)
    assert.equal(response.data.error.code, 'unauthorized')
  } finally {
    await api.close()
  }
})

test('logout revokes session and clears cookie', async () => {
  const api = await startApi()
  try {
    const account = await request(api.base, '/api/auth/register', {
      method: 'POST', body: { username: 'logout_user', password: '12345678', displayName: 'Вышедший' },
    })
    const logout = await request(api.base, '/api/auth/logout', { method: 'POST', cookie: account.cookie })
    assert.match(logout.setCookie, /Max-Age=0/)
    const snapshot = await request(api.base, '/api/online', { cookie: account.cookie })
    assert.equal(snapshot.status, 401)
  } finally {
    await api.close()
  }
})
