import { StoreError } from './store.mjs'

const MAX_BODY = 32 * 1024

function sendJson(response, status, payload) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  })
  response.end(JSON.stringify(payload))
}

async function readJson(request) {
  const chunks = []
  let length = 0
  for await (const chunk of request) {
    length += chunk.length
    if (length > MAX_BODY) throw new StoreError('body-too-large', 'Запрос слишком большой.', 413)
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new StoreError('invalid-json', 'Некорректный JSON.', 400)
  }
}

function bearerToken(request) {
  const header = String(request.headers.authorization ?? '')
  return header.startsWith('Bearer ') ? header.slice(7).trim() : null
}

function requireUser(store, request) {
  const token = bearerToken(request)
  const user = store.authenticate(token)
  if (!user) throw new StoreError('unauthorized', 'Требуется вход в аккаунт.', 401)
  return { token, user }
}

export function createApiHandler(store) {
  return async function handleApi(request, response) {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`)
    if (!url.pathname.startsWith('/api/')) return false

    try {
      if (request.method === 'GET' && url.pathname === '/api/health') {
        sendJson(response, 200, { ok: true, service: 'ashes-of-principalities' })
        return true
      }

      if (request.method === 'POST' && url.pathname === '/api/auth/register') {
        const body = await readJson(request)
        sendJson(response, 201, store.register(body))
        return true
      }

      if (request.method === 'POST' && url.pathname === '/api/auth/login') {
        const body = await readJson(request)
        sendJson(response, 200, store.login(body))
        return true
      }

      if (request.method === 'POST' && url.pathname === '/api/auth/logout') {
        const token = bearerToken(request)
        store.logout(token)
        sendJson(response, 200, { ok: true })
        return true
      }

      if (request.method === 'GET' && url.pathname === '/api/online') {
        const { user } = requireUser(store, request)
        sendJson(response, 200, store.getSnapshot(user.id))
        return true
      }

      if (request.method === 'POST' && url.pathname === '/api/guilds') {
        const { user } = requireUser(store, request)
        const body = await readJson(request)
        sendJson(response, 201, { guild: store.createGuild(user.id, body) })
        return true
      }

      if (request.method === 'POST' && url.pathname === '/api/guilds/invites') {
        const { user } = requireUser(store, request)
        const body = await readJson(request)
        sendJson(response, 201, { invite: store.inviteToGuild(user.id, body.username) })
        return true
      }

      const acceptMatch = url.pathname.match(/^\/api\/guilds\/invites\/([^/]+)\/accept$/)
      if (request.method === 'POST' && acceptMatch) {
        const { user } = requireUser(store, request)
        sendJson(response, 200, { guild: store.acceptInvite(user.id, decodeURIComponent(acceptMatch[1])) })
        return true
      }

      if (request.method === 'POST' && url.pathname === '/api/guilds/treasury/deposit') {
        const { user } = requireUser(store, request)
        const body = await readJson(request)
        sendJson(response, 200, { guild: store.depositCoins(user.id, body.amount) })
        return true
      }

      if (request.method === 'GET' && url.pathname === '/api/guilds/treasury/log') {
        const { user } = requireUser(store, request)
        sendJson(response, 200, { entries: store.getTreasuryLog(user.id, url.searchParams.get('limit')) })
        return true
      }

      if (request.method === 'POST' && url.pathname === '/api/guilds/progress') {
        const { user } = requireUser(store, request)
        const body = await readJson(request)
        sendJson(response, 200, { guild: store.progressTask(user.id, body.taskId, body.amount) })
        return true
      }

      if (request.method === 'POST' && url.pathname === '/api/guilds/tree/upgrade') {
        const { user } = requireUser(store, request)
        const body = await readJson(request)
        sendJson(response, 200, { guild: store.upgradeBranch(user.id, body.branch) })
        return true
      }

      if (request.method === 'POST' && url.pathname === '/api/guilds/tree/reset') {
        const { user } = requireUser(store, request)
        sendJson(response, 200, { guild: store.resetTree(user.id) })
        return true
      }

      if (request.method === 'GET' && url.pathname === '/api/guilds/members') {
        const { user } = requireUser(store, request)
        sendJson(response, 200, { members: store.getMembers(user.id) })
        return true
      }

      const memberRoleMatch = url.pathname.match(/^\/api\/guilds\/members\/([^/]+)\/role$/)
      if (request.method === 'POST' && memberRoleMatch) {
        const { user } = requireUser(store, request)
        const body = await readJson(request)
        sendJson(response, 200, { members: store.assignMemberRole(user.id, decodeURIComponent(memberRoleMatch[1]), body.roleId) })
        return true
      }

      const memberMatch = url.pathname.match(/^\/api\/guilds\/members\/([^/]+)$/)
      if (request.method === 'DELETE' && memberMatch) {
        const { user } = requireUser(store, request)
        sendJson(response, 200, { members: store.kickMember(user.id, decodeURIComponent(memberMatch[1])) })
        return true
      }

      if (request.method === 'GET' && url.pathname === '/api/guilds/roles') {
        const { user } = requireUser(store, request)
        sendJson(response, 200, { roles: store.getRoles(user.id) })
        return true
      }

      if (request.method === 'POST' && url.pathname === '/api/guilds/roles') {
        const { user } = requireUser(store, request)
        const body = await readJson(request)
        sendJson(response, 201, { roles: store.createRole(user.id, body) })
        return true
      }

      sendJson(response, 404, { error: { code: 'not-found', message: 'Маршрут не найден.' } })
      return true
    } catch (error) {
      if (error instanceof StoreError) {
        sendJson(response, error.status, { error: { code: error.code, message: error.message } })
        return true
      }
      console.error('API request failed:', error)
      sendJson(response, 500, { error: { code: 'internal-error', message: 'Внутренняя ошибка сервера.' } })
      return true
    }
  }
}
