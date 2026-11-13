import { applyAction, viewState, WorkflowError } from '../docs/workflow.js'

const cookieName = '__Host-voting_session'
const memberSessionSeconds = 12 * 60 * 60
const operatorSessionSeconds = 60 * 60
const tokenPattern = /^[A-Za-z0-9_-]{43}$/
const hashPattern = /^[0-9a-f]{64}$/
const unsafeLabel = /[\p{Cc}\p{Cf}]/u
const maxBodyBytes = 32 * 1024
const roleNames = new Set(['member', 'reviewer', 'representative', 'coordinator'])
const apiMethods = new Map([
  ['/api/session', ['GET']],
  ['/api/state', ['GET']],
  ['/api/login', ['POST']],
  ['/api/logout', ['POST']],
  ['/api/actions', ['POST']],
  ['/api/admin/login', ['POST']],
  ['/api/admin/users', ['GET', 'POST']],
])

class HttpError extends Error {
  constructor(status, message, headers = {}) {
    super(message)
    this.status = status
    this.headers = headers
  }
}

function secureResponse(response) {
  const headers = new Headers(response.headers)
  headers.set('X-Content-Type-Options', 'nosniff')
  headers.set('Referrer-Policy', 'no-referrer')
  headers.set('X-Frame-Options', 'DENY')
  headers.set('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data:",
    "connect-src 'self'",
    "base-uri 'none'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
  ].join('; '))
  return new Response(response.body, { status: response.status, headers })
}

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers },
  })
}

async function requestBody(request) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') || '')) {
    throw new HttpError(415, '请求须使用 JSON。')
  }
  if (Number(request.headers.get('content-length')) > maxBodyBytes) throw new HttpError(413, '请求内容过长。')
  const reader = request.body?.getReader()
  if (!reader) throw new HttpError(400, '无法读取请求内容。')
  const decoder = new TextDecoder()
  let text = ''
  let bytes = 0
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    bytes += value.length
    if (bytes > maxBodyBytes) {
      await reader.cancel()
      throw new HttpError(413, '请求内容过长。')
    }
    text += decoder.decode(value, { stream: true })
  }
  try {
    const data = JSON.parse(text + decoder.decode())
    if (data && typeof data === 'object' && !Array.isArray(data)) return data
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error
  }
  throw new HttpError(400, '无法读取请求内容。')
}

function newToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

async function hashToken(token) {
  const bytes = new TextEncoder().encode(token)
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
    .map(value => value.toString(16).padStart(2, '0')).join('')
}

function sameHash(left, right) {
  if (!hashPattern.test(left ?? '') || !hashPattern.test(right ?? '')) return false
  let difference = 0
  for (let index = 0; index < 64; index++) difference |= left.charCodeAt(index) ^ right.charCodeAt(index)
  return difference === 0
}

function cookieValue(token, seconds) {
  return `${cookieName}=${token}; Path=/; Max-Age=${seconds}; HttpOnly; Secure; SameSite=Strict`
}

async function sessionHash(request) {
  for (const item of (request.headers.get('cookie') || '').split(';')) {
    const cookie = item.trim()
    if (!cookie.startsWith(`${cookieName}=`)) continue
    const token = cookie.slice(cookieName.length + 1)
    return tokenPattern.test(token) ? hashToken(token) : null
  }
  return null
}

function toActor(user) {
  return { id: user.id, name: user.name, region: user.region, group: user.member_group, roles: JSON.parse(user.roles) }
}

function cleanLabel(value) {
  if (typeof value !== 'string' || unsafeLabel.test(value)) return null
  const label = value.trim().normalize('NFC')
  return label.length > 0 && label.length <= 100 ? label : null
}

function codenameKey(label) {
  return label?.normalize('NFKC').trim().toLowerCase() || null
}

function statement(db, sql, ...args) {
  return db.prepare(sql).bind(...args)
}

async function sessionDetails(db, hash, operatorHash, now) {
  if (!hash) return { actor: null, operator: false }
  const record = await statement(db, `
    SELECT s.operator_hash, u.id, u.name, u.region, u.member_group, u.roles, u.enabled
    FROM sessions s LEFT JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ? AND s.expires_at > ?
  `, hash, now).first()
  return {
    actor: record?.enabled === 1 ? toActor(record) : null,
    operator: sameHash(record?.operator_hash, operatorHash),
  }
}

function nextSession(db, previousHash, now, insert) {
  return db.batch([
    statement(db, 'DELETE FROM sessions WHERE expires_at <= ? OR token_hash = ?', now, previousHash),
    insert,
  ])
}

async function login(db, hash, body, now) {
  const label = cleanLabel(body.codename)
  const loginToken = typeof body.token === 'string' ? body.token.trim() : ''
  const failure = () => new HttpError(401, '代号或登录码无效。')
  if (!label || !tokenPattern.test(loginToken)) throw failure()
  const loginHash = await hashToken(loginToken)
  const user = await statement(db, `
    SELECT id, name, region, member_group, roles FROM users
    WHERE codename_key = ? AND login_hash = ? AND enabled = 1
  `, codenameKey(label), loginHash).first()
  if (!user) throw failure()
  const token = newToken()
  const [, inserted] = await nextSession(db, hash, now, statement(db, `
    INSERT INTO sessions (token_hash, user_id, expires_at)
    SELECT ?, id, ? FROM users WHERE id = ? AND login_hash = ? AND enabled = 1
  `, await hashToken(token), now + memberSessionSeconds * 1000, user.id, loginHash))
  if (!inserted.meta.changes) throw failure()
  return json({ actor: toActor(user), operator: false }, 200, { 'Set-Cookie': cookieValue(token, memberSessionSeconds) })
}

async function operatorLogin(db, hash, body, operatorHash, now) {
  if (!hashPattern.test(operatorHash ?? '')) throw new HttpError(503, '管理员登录尚未配置。')
  const code = typeof body.token === 'string' ? body.token.trim() : ''
  if (!tokenPattern.test(code) || !sameHash(await hashToken(code), operatorHash)) {
    throw new HttpError(401, '管理员登录码无效。')
  }
  const token = newToken()
  await nextSession(db, hash, now, statement(db, `
    INSERT INTO sessions (token_hash, operator_hash, expires_at) VALUES (?, ?, ?)
  `, await hashToken(token), operatorHash, now + operatorSessionSeconds * 1000))
  return json({ actor: null, operator: true }, 200, { 'Set-Cookie': cookieValue(token, operatorSessionSeconds) })
}

async function manageUsers(db, method, body) {
  if (method === 'GET') {
    const { results } = await db.prepare('SELECT id, name, region, member_group, roles, enabled FROM users ORDER BY codename_key').all()
    return json({ users: results.map(user => ({ ...toActor(user), enabled: user.enabled === 1 })) })
  }
  const advanceRosterRevision = db.prepare('UPDATE organization SET revision = revision + 1 WHERE id = 1')
  if (body.action === 'create') {
    const codename = cleanLabel(body.codename)
    const region = cleanLabel(body.region)
    const group = cleanLabel(body.group)
    const roles = Array.isArray(body.roles) ? [...new Set(body.roles)] : []
    if (!codename || !region || !group || !roles.length || roles.some(role => !roleNames.has(role))) {
      throw new HttpError(400, '请填写代号、地区、小组并选择有效角色。')
    }
    const id = crypto.randomUUID()
    const token = newToken()
    const [created] = await db.batch([statement(db, `
      INSERT INTO users (id, name, codename_key, region, member_group, roles, login_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (codename_key) DO NOTHING
    `, id, codename, codenameKey(codename), region, group, JSON.stringify(roles), await hashToken(token)), advanceRosterRevision])
    if (!created.meta.changes) throw new HttpError(409, '此代号已登记。')
    return json({ id, codename, token }, 201)
  }
  const { id, action } = body
  if (!['rotate', 'disable'].includes(action) || typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id)) {
    throw new HttpError(400, '无效的账户操作。')
  }
  const user = await statement(db, 'SELECT name, login_hash FROM users WHERE id = ? AND enabled = 1', id).first()
  if (!user) throw new HttpError(404, '找不到可操作的账户。')
  const token = action === 'rotate' ? newToken() : null
  const loginHash = token ? await hashToken(token) : null
  const update = token
    ? statement(db, 'UPDATE users SET login_hash = ? WHERE id = ? AND login_hash = ? AND enabled = 1', loginHash, id, user.login_hash)
    : statement(db, 'UPDATE users SET enabled = 0 WHERE id = ? AND enabled = 1', id)
  const revokeSessions = token
    ? statement(db, `DELETE FROM sessions WHERE user_id = ? AND EXISTS (
        SELECT 1 FROM users WHERE id = ? AND login_hash = ?
      )`, id, id, loginHash)
    : statement(db, 'DELETE FROM sessions WHERE user_id = ?', id)
  const [updated] = await db.batch([
    update,
    revokeSessions,
    advanceRosterRevision,
  ])
  if (!updated.meta.changes) throw new HttpError(409, '账号已被其他操作更新，请刷新后重试。')
  return json(token ? { id, codename: user.name, token } : { id, enabled: false })
}

async function submitAction(db, hash, body) {
  if (!hash) throw new HttpError(401, '请先登录。')
  for (let attempt = 0; attempt < 5; attempt++) {
    const now = Date.now()
    const current = await db.prepare('SELECT revision, state FROM organization WHERE id = 1').first()
    const { actor } = await sessionDetails(db, hash, null, now)
    if (!actor) throw new HttpError(401, '请先登录。')
    const { results } = await db.prepare('SELECT id, name, region, member_group, roles FROM users WHERE enabled = 1 ORDER BY id').all()
    const next = applyAction(JSON.parse(current.state), actor, body, now, results.map(toActor))
    const updated = await statement(db, `
      UPDATE organization SET state = ?, revision = revision + 1
      WHERE id = 1 AND revision = ? AND EXISTS (
        SELECT 1 FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = ? AND s.user_id = ? AND s.expires_at > ? AND u.enabled = 1
      )
    `, JSON.stringify(next), current.revision, hash, actor.id, Date.now()).run()
    if (updated.meta.changes) return json({ actor, state: viewState(next, actor) })
  }
  throw new HttpError(503, '当前操作较多，请重试。')
}

async function handleApi(request, env, url) {
  const methods = apiMethods.get(url.pathname)
  if (!methods) throw new HttpError(404, '找不到该接口。')
  if (!methods.includes(request.method)) throw new HttpError(405, '该请求方式不可用。', { Allow: methods.join(', ') })
  if (request.method === 'POST' && request.headers.get('origin') !== (env.VOTING_ORIGIN || url.origin)) {
    throw new HttpError(403, '请求须从本站发起。')
  }
  if (!env.DB) throw new HttpError(503, '正式投票服务尚未配置。')
  const now = Date.now()
  // Use D1's primary for each request so immediate login, vote, and revocation checks see committed changes.
  const db = env.DB.withSession('first-primary')
  const hash = await sessionHash(request)
  const body = request.method === 'POST' && url.pathname !== '/api/logout' ? await requestBody(request) : null
  const operatorHash = env.OPERATOR_CODE_HASH
  switch (url.pathname) {
    case '/api/session':
      return json(await sessionDetails(db, hash, operatorHash, now))
    case '/api/state': {
      const { actor } = await sessionDetails(db, hash, operatorHash, now)
      if (!actor) throw new HttpError(401, '请先登录。')
      const { state } = await db.prepare('SELECT state FROM organization WHERE id = 1').first()
      return json({ actor, state: viewState(JSON.parse(state), actor) })
    }
    case '/api/login':
      return login(db, hash, body, now)
    case '/api/admin/login':
      return operatorLogin(db, hash, body, operatorHash, now)
    case '/api/admin/users': {
      const { operator } = await sessionDetails(db, hash, operatorHash, now)
      if (!operator) throw new HttpError(401, '请先登录管理员账户。')
      return manageUsers(db, request.method, body)
    }
    case '/api/actions':
      return submitAction(db, hash, body)
    case '/api/logout':
      if (hash) await statement(db, 'DELETE FROM sessions WHERE token_hash = ?', hash).run()
      return json({ actor: null, operator: false }, 200, { 'Set-Cookie': cookieValue('', 0) })
  }
}

export function createWorker(serveAsset = (request, env) => env.ASSETS?.fetch(request)) {
  return {
    async fetch(request, env) {
      try {
        const url = new URL(request.url)
        const response = url.pathname.startsWith('/api/')
          ? await handleApi(request, env, url)
          : await serveAsset(request, env)
        return secureResponse(response ?? json({ error: '找不到页面。' }, 404))
      } catch (error) {
        if (error instanceof HttpError) return secureResponse(json({ error: error.message }, error.status, error.headers))
        if (error instanceof WorkflowError) return secureResponse(json({ error: error.message }, 422))
        console.error('Voting request failed:', error.name)
        return secureResponse(json({ error: '暂时无法处理请求。' }, 500))
      }
    },
  }
}

export default createWorker()
