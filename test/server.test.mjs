import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createVotingServer } from '../server.mjs';
import { applyAction, createState } from '../docs/workflow.js';

const serverPath = fileURLToPath(new URL('../server.mjs', import.meta.url));

function runCli(databasePath, ...args) {
  const output = execFileSync(process.execPath, [serverPath, ...args], {
    env: { ...process.env, VOTING_DB: databasePath, NODE_NO_WARNINGS: '1' },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return JSON.parse(output);
}

function addUser(databasePath, codename, region, roles, nameFlag = '--codename') {
  const credentials = runCli(databasePath, 'add-user', nameFlag, codename, '--region', region, '--group', '第一小组', '--roles', roles);
  return { ...credentials, codename };
}

async function startServer(databasePath, origin) {
  const server = createVotingServer({ databasePath, origin });
  const socketPath = process.platform === 'win32'
    ? `\\\\.\\pipe\\voting-test-${randomUUID()}`
    : join(databasePath, '..', 'http.sock');
  server.listen(socketPath);
  await once(server, 'listening');
  return {
    socketPath,
    close: () => new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    }),
  };
}

function send(socketPath, path, method, headers, body) {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ socketPath, path, method, headers }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('error', reject);
      response.on('end', () => resolve({
        status: response.statusCode,
        ok: response.statusCode >= 200 && response.statusCode < 300,
        headers: new Headers(response.headers),
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    request.on('error', reject);
    request.end(body);
  });
}

function browser(socketPath, siteOrigin = 'http://localhost') {
  let cookie;
  async function request(path, { data, method = data ? 'POST' : 'GET', origin = siteOrigin } = {}) {
    const headers = { host: 'localhost' };
    if (cookie) headers.cookie = cookie;
    if (method === 'POST' && origin) headers.origin = origin;
    if (data) headers['content-type'] = 'application/json';
    const response = await send(socketPath, path, method, headers, data ? JSON.stringify(data) : undefined);
    const newCookie = response.headers.get('set-cookie');
    if (newCookie) cookie = newCookie.split(';', 1)[0];
    return { response, data: JSON.parse(response.body) };
  }
  return {
    request,
    login: ({ codename, token }) => request('/api/login', { data: { codename, token } }),
    logout: () => request('/api/logout', { method: 'POST' }),
    session: () => request('/api/session'),
    state: () => request('/api/state'),
    action: (data) => request('/api/actions', { data }),
  };
}

test('pseudonym login requires the matching code and enforces one ballot across sessions', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'voting-api-'));
  const databasePath = join(directory, 'voting.sqlite');
  let server;
  t.after(async () => {
    if (server) await server.close();
    await rm(directory, { recursive: true, force: true });
  });
  const member = addUser(databasePath, 'Crimson-Heron', '东区', 'member');
  const coordinator = addUser(databasePath, 'Red-Leaf', '东区', 'member,coordinator', '--name');
  const representative = addUser(databasePath, 'Stone-Rose', '西区', 'member,representative');
  assert.throws(() => addUser(databasePath, 'crimson-heron', '西区', 'member'), { status: 1 });
  assert.equal(runCli(databasePath, 'list-users').length, 3);
  server = await startServer(databasePath);
  const alice = browser(server.socketPath);
  const secondDevice = browser(server.socketPath);
  const bob = browser(server.socketPath);
  const chao = browser(server.socketPath);

  const page = await send(server.socketPath, '/', 'GET', { host: 'localhost' });
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type'), /text\/html/);
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal((await alice.request('/server.mjs')).response.status, 404);
  assert.equal((await alice.request('/data/voting.sqlite')).response.status, 404);
  assert.deepEqual((await alice.session()).data, { actor: null });
  assert.equal((await alice.state()).response.status, 401);
  assert.equal((await alice.login({ token: member.token })).response.status, 401);
  assert.equal((await alice.login({ codename: member.codename })).response.status, 401);
  assert.equal((await alice.login({ ...member, codename: 'unknown-heron' })).response.status, 401);
  assert.equal((await alice.login({ ...member, token: coordinator.token })).response.status, 401);
  const crossOrigin = await alice.request('/api/login', {
    data: { codename: member.codename, token: member.token }, origin: 'https://unrelated.example',
  });
  assert.equal(crossOrigin.response.status, 403);

  const login = await alice.login({ ...member, codename: 'CRIMSON-heron' });
  assert.equal(login.response.status, 200);
  assert.equal(login.response.headers.get('cache-control'), 'no-store');
  assert.match(login.response.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
  assert.equal(login.data.actor.id, member.id);
  assert.equal(login.data.actor.name, member.codename);
  assert.deepEqual(login.data.actor.roles, ['member']);
  assert.equal((await secondDevice.login(member)).response.status, 200);
  assert.equal((await bob.login(coordinator)).response.status, 200);
  assert.equal((await chao.login(representative)).response.status, 200);

  const created = await alice.action({
    type: 'create', scope: 'regional', title: '东区内部事项', description: '限东区可见',
    actor: { id: coordinator.id, roles: ['coordinator'], region: '西区' },
  });
  assert.equal(created.response.status, 200);
  const motion = created.data.state.motions[0];
  const motionId = motion.id;
  assert.equal(motion.author.id, member.id);
  assert.equal(motion.region, '东区');
  assert.equal(motion.ballot.total, 2);
  assert.equal((await bob.state()).data.state.motions[0].id, motionId);
  assert.deepEqual((await chao.state()).data.state.motions, []);
  const anonymous = browser(server.socketPath);
  assert.equal((await anonymous.action({ type: 'vote', motionId, choice: 'yes', actor: { id: member.id } })).response.status, 401);
  assert.equal((await chao.action({ type: 'vote', motionId, choice: 'yes' })).response.status, 422);
  assert.equal((await bob.action({ type: 'closeBallot', motionId })).response.status, 422);

  const concurrent = await Promise.all([
    alice.action({ type: 'vote', motionId, choice: 'yes' }),
    secondDevice.action({ type: 'vote', motionId, choice: 'no' }),
  ]);
  assert.deepEqual(concurrent.map(({ response }) => response.status).sort(), [200, 422]);
  const aliceVote = concurrent.find(({ response }) => response.ok).data.state.motions[0].ballot.myVote;
  const bobBeforeVote = (await bob.state()).data.state.motions[0].ballot;
  assert.equal(bobBeforeVote.cast, 1);
  assert.equal(bobBeforeVote.myVote, null);
  assert.equal(bobBeforeVote.result, null);
  assert.equal(Object.hasOwn(bobBeforeVote, 'votes'), false);
  assert.equal(Object.hasOwn(bobBeforeVote, 'electorate'), false);

  assert.equal((await bob.action({ type: 'vote', motionId, choice: 'yes' })).response.status, 200);
  assert.equal((await alice.action({ type: 'closeBallot', motionId })).response.status, 422);
  const closed = await bob.action({ type: 'closeBallot', motionId });
  assert.equal(closed.data.state.motions[0].ballot.result.yes, aliceVote === 'yes' ? 2 : 1);
  assert.equal(closed.data.state.motions[0].ballot.result.cast, 2);
  assert.equal((await bob.action({ type: 'publish', motionId })).response.status, 200);

  const publicView = (await chao.state()).data.state;
  assert.deepEqual(publicView.motions, []);
  assert.equal(publicView.notices.length, 1);
  assert.equal(publicView.notices[0].kind, 'regional');
  assert.equal(Object.hasOwn(publicView.notices[0], 'motionId'), false);
  assert.doesNotMatch(JSON.stringify(publicView), /东区|第一小组|限东区可见/);

  const fresh = runCli(databasePath, 'rotate-token', member.id);
  assert.equal((await alice.state()).response.status, 401);
  assert.equal((await secondDevice.state()).response.status, 401);
  assert.equal((await alice.login(member)).response.status, 401);
  assert.equal((await alice.login({ ...member, token: fresh.token })).response.status, 200);
  assert.deepEqual((await alice.logout()).data, { actor: null });
  assert.equal((await alice.state()).response.status, 401);
  runCli(databasePath, 'disable-user', representative.id);
  assert.equal((await chao.state()).response.status, 401);
  assert.equal((await chao.login(representative)).response.status, 401);

  await server.close();
  server = null;
  server = await startServer(databasePath);
  const afterRestart = browser(server.socketPath);
  assert.equal((await afterRestart.login(coordinator)).response.status, 200);
  assert.equal((await afterRestart.state()).data.state.motions[0].ballot.result.cast, 2);
});

test('configured HTTPS origin accepts proxy traffic and uses secure cookies', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'voting-origin-'));
  const databasePath = join(directory, 'voting.sqlite');
  const origin = 'https://vote.example.org';
  const user = addUser(databasePath, '成员', '北区', 'member');
  const server = await startServer(databasePath, origin);
  t.after(async () => {
    await server.close();
    await rm(directory, { recursive: true, force: true });
  });
  const client = browser(server.socketPath, origin);
  const local = browser(server.socketPath);
  assert.equal((await local.login(user)).response.status, 403);
  const login = await client.login(user);
  assert.equal(login.response.status, 200);
  assert.match(login.response.headers.get('set-cookie'), /^__Host-voting_session=.*; HttpOnly; SameSite=Strict; Secure$/);
  assert.equal((await client.state()).response.status, 200);
});

test('upgrading a voting database retains its accounts and ballots and revokes old sessions', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'voting-upgrade-'));
  const databasePath = join(directory, 'voting.sqlite');
  let server;
  t.after(async () => {
    if (server) await server.close();
    await rm(directory, { recursive: true, force: true });
  });
  const voter = { id: randomUUID(), name: 'Legacy-Rose', region: '北区', group: '第一小组', roles: ['member'] };
  const collision = { ...voter, id: randomUUID(), name: 'legacy-rose', region: '南区' };
  const loginToken = randomBytes(32).toString('base64url');
  const collisionToken = randomBytes(32).toString('base64url');
  const oldSession = randomBytes(32).toString('base64url');
  const hash = token => createHash('sha256').update(token).digest('hex');
  const motion = { type: 'create', scope: 'regional', title: '历史动议', description: '升级前的动议' };
  const state = applyAction(createState(), voter, motion, Date.now(), [voter]);
  const db = new DatabaseSync(databasePath);
  try {
    db.exec(`
      CREATE TABLE users (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, region TEXT NOT NULL, member_group TEXT NOT NULL,
        roles TEXT NOT NULL, login_hash TEXT NOT NULL UNIQUE, enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1))
      ) STRICT;
      CREATE TABLE sessions (
        token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), expires_at INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE organization (id INTEGER PRIMARY KEY CHECK (id = 1), state TEXT NOT NULL) STRICT;
    `);
    const insertUser = db.prepare('INSERT INTO users (id, name, region, member_group, roles, login_hash) VALUES (?, ?, ?, ?, ?, ?)');
    insertUser.run(voter.id, voter.name, voter.region, voter.group, JSON.stringify(voter.roles), hash(loginToken));
    insertUser.run(collision.id, collision.name, collision.region, collision.group, JSON.stringify(collision.roles), hash(collisionToken));
    db.prepare('INSERT INTO sessions VALUES (?, ?, ?)').run(hash(oldSession), voter.id, Date.now() + 60_000);
    db.prepare('INSERT INTO organization VALUES (1, ?)').run(JSON.stringify(state));
  } finally {
    db.close();
  }

  server = await startServer(databasePath);
  const oldCookie = await send(server.socketPath, '/api/state', 'GET', {
    host: 'localhost', cookie: `voting_session=${oldSession}`,
  });
  assert.equal(oldCookie.status, 401);
  const accounts = runCli(databasePath, 'list-users');
  assert.deepEqual(new Set(accounts.map(account => account.id)), new Set([voter.id, collision.id]));
  assert.equal(new Set(accounts.map(account => account.name.toLowerCase())).size, 2);
  const migratedVoter = accounts.find(account => account.id === voter.id);
  const migratedCollision = accounts.find(account => account.id === collision.id);
  const otherClient = browser(server.socketPath);
  const otherLogin = await otherClient.login({ codename: migratedCollision.name, token: collisionToken });
  assert.equal(otherLogin.response.status, 200);
  assert.equal(otherLogin.data.actor.id, collision.id);
  const client = browser(server.socketPath);
  const login = await client.login({ codename: migratedVoter.name.toLowerCase(), token: loginToken });
  assert.equal(login.response.status, 200);
  assert.deepEqual(login.data.actor, { ...voter, name: migratedVoter.name });
  const beforeVote = (await client.state()).data.state.motions[0];
  assert.equal(beforeVote.title, motion.title);
  assert.equal(beforeVote.author.id, voter.id);
  assert.equal((await client.action({ type: 'vote', motionId: beforeVote.id, choice: 'yes' })).response.status, 200);

  await server.close();
  server = null;
  server = await startServer(databasePath);
  const afterRestart = browser(server.socketPath);
  assert.equal((await afterRestart.login({ codename: migratedVoter.name, token: loginToken })).response.status, 200);
  assert.equal((await afterRestart.state()).data.state.motions[0].ballot.myVote, 'yes');
});
