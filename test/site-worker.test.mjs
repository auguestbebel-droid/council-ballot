import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import worker from '../site/worker.js'

const migration = readFileSync(new URL('../site/drizzle/0000_voting.sql', import.meta.url), 'utf8')
const origin = 'https://voting.example'

function database(t) {
  const sqlite = new DatabaseSync(':memory:')
  sqlite.exec(migration)
  t.after(() => sqlite.close())
  const session = {
    prepare(sql) {
      const query = sqlite.prepare(sql)
      function bind(...params) {
        return {
          first: async () => query.get(...params) ?? null,
          all: async () => ({ results: query.all(...params) }),
          run: async () => ({ meta: query.run(...params) }),
          runInBatch: () => ({ meta: query.run(...params) }),
        }
      }
      return { ...bind(), bind }
    },
    async batch(statements) {
      sqlite.exec('BEGIN')
      try {
        const results = statements.map(statement => statement.runInBatch())
        sqlite.exec('COMMIT')
        return results
      } catch (error) {
        sqlite.exec('ROLLBACK')
        throw error
      }
    },
  }
  return { withSession: () => session }
}

function browser(env) {
  let cookie = ''
  return async (path, body, from = origin) => {
    const headers = { Cookie: cookie }
    if (body !== undefined) Object.assign(headers, { Origin: from, 'Content-Type': 'application/json' })
    const response = await worker.fetch(new Request(origin + path, {
      headers,
      method: body === undefined ? 'GET' : 'POST',
      body: body === undefined ? undefined : JSON.stringify(body),
    }), env)
    const newCookie = response.headers.get('Set-Cookie')
    if (newCookie) cookie = newCookie.split(';', 1)[0]
    return { status: response.status, cookie: newCookie, data: await response.json() }
  }
}

test('hosted accounts, revocation and concurrent voting use shared authenticated state', async t => {
  const token = randomBytes(32).toString('base64url')
  const env = { DB: database(t), OPERATOR_CODE_HASH: createHash('sha256').update(token).digest('hex') }
  const operator = browser(env)
  const member = browser(env)
  const other = browser(env)
  assert.deepEqual((await member('/api/session')).data, { actor: null, operator: false })
  assert.equal((await operator('/api/admin/login', { token }, 'https://elsewhere.example')).status, 403)
  assert.equal((await operator('/api/admin/login', { token })).data.operator, true)
  assert.equal((await operator('/api/state')).status, 401)

  const account = { action: 'create', codename: 'Rose-1', region: '东区', group: '第一小组', roles: ['member', 'coordinator'] }
  const { status, data: credentials } = await operator('/api/admin/users', account)
  assert.equal(status, 201)
  assert.equal(credentials.token.length, 43)
  assert.equal((await operator('/api/admin/users', { ...account, codename: 'ＲＯＳＥ-１' })).status, 409)
  const second = (await operator('/api/admin/users', { ...account, codename: 'Rose-2' })).data
  assert.equal((await operator('/api/admin/users')).data.users.length, 2)
  assert.equal((await member('/api/login', { codename: 'Rose-2', token: credentials.token })).status, 401)
  const signedIn = await member('/api/login', { codename: 'ROSE-1', token: credentials.token })
  assert.equal(signedIn.status, 200)
  assert.match(signedIn.cookie, /__Host-voting_session=.*HttpOnly; Secure; SameSite=Strict/)
  assert.equal((await member('/api/admin/users')).status, 401)
  await other('/api/login', second)

  const action = { type: 'create', title: '东区事项', description: '组织内说明', scope: 'regional' }
  const created = await member('/api/actions', { ...action, actor: { id: second.id } })
  const motionId = created.data.state.motions[0].id
  assert.equal(created.data.state.motions[0].author.id, credentials.id)
  const results = await Promise.all(['yes', 'no'].map(choice => member('/api/actions', { type: 'vote', motionId, choice })))
  assert.deepEqual(results.map(result => result.status).sort(), [200, 422])
  const ballot = (await other('/api/state')).data.state.motions[0].ballot
  assert.equal(ballot.cast, 1)
  assert.equal(ballot.myVote, null)
  assert.equal(Object.hasOwn(ballot, 'votes'), false)

  const rotated = await operator('/api/admin/users', { action: 'rotate', id: credentials.id })
  assert.equal(rotated.data.codename, credentials.codename)
  assert.equal((await member('/api/state')).status, 401)
  assert.equal((await member('/api/login', credentials)).status, 401)
  assert.equal((await member('/api/login', rotated.data)).status, 200)
  await operator('/api/admin/users', { action: 'disable', id: credentials.id })
  assert.equal((await member('/api/state')).status, 401)
  assert.equal((await member('/api/login', rotated.data)).status, 401)
  assert.equal((await other('/api/actions', { type: 'vote', motionId, choice: 'yes' })).status, 200)
  assert.equal((await operator('/api/logout', {})).status, 200)
  assert.equal((await operator('/api/admin/users')).status, 401)
})
