import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { applyAction, createState, viewState, WorkflowError } from './docs/workflow.js';

const root = new URL('./', import.meta.url);
const defaultDatabase = fileURLToPath(new URL('data/voting.sqlite', root));
const tokenPattern = /^[A-Za-z0-9_-]{43}$/;
const sessionSeconds = 12 * 60 * 60;
const maxBodyBytes = 32 * 1024;
const roleNames = ['member', 'reviewer', 'representative', 'coordinator', 'admin'];
const loopbackHosts = ['127.0.0.1', 'localhost', '[::1]'];
const contentTypes = {
  html: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  avif: 'image/avif',
  woff2: 'font/woff2',
};
const staticPaths = new Set([
  '/index.html', '/styles.css', '/app.js', '/workflow.js', '/demo.js',
  '/favicon.svg', '/favicon.ico',
]);
const assetPath = /^\/assets\/[A-Za-z0-9][A-Za-z0-9_.-]*\.(?:svg|png|jpe?g|webp|avif|woff2)$/;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function openDatabase(path) {
  if (path !== ':memory:') {
    mkdirSync(dirname(resolve(path)), { recursive: true, mode: 0o700 });
  }
  const db = new DatabaseSync(path, { timeout: 5000 });
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      region TEXT NOT NULL,
      member_group TEXT NOT NULL,
      roles TEXT NOT NULL,
      login_hash TEXT NOT NULL UNIQUE,
      enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1))
    ) STRICT;

    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      expires_at INTEGER NOT NULL
    ) STRICT;

    CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);

    CREATE TABLE IF NOT EXISTS organization (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      state TEXT NOT NULL
    ) STRICT;
  `);
  db.prepare('INSERT OR IGNORE INTO organization (id, state) VALUES (1, ?)')
    .run(JSON.stringify(createState()));
  return db;
}

function transaction(db, operation) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = operation();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function toActor(user) {
  if (!user) return null;
  return {
    id: user.id,
    name: user.name,
    region: user.region,
    group: user.member_group,
    roles: JSON.parse(user.roles),
  };
}

function newToken() {
  return randomBytes(32).toString('base64url');
}

function hashToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

function cookieToken(request, cookieName) {
  const cookies = (request.headers.cookie || '').split(';');
  for (const cookie of cookies) {
    const value = cookie.trim();
    if (value.startsWith(`${cookieName}=`)) {
      const token = value.slice(cookieName.length + 1);
      return tokenPattern.test(token) ? token : null;
    }
  }
  return null;
}

function sessionCookie(name, token, maxAge, secure) {
  return `${name}=${token}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`;
}

function responseHeaders(response) {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader('Content-Security-Policy', [
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
  ].join('; '));
}

function json(response, status, data) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  response.end(JSON.stringify(data));
}

async function readJson(request) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] || '')) {
    throw new HttpError(415, '请求须使用 JSON。');
  }
  if (Number(request.headers['content-length']) > maxBodyBytes) {
    throw new HttpError(413, '请求内容过长。');
  }
  const chunks = [];
  let length = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    length += chunk.length;
    if (length > maxBodyBytes) throw new HttpError(413, '请求内容过长。');
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
  }
  throw new HttpError(400, '无法读取请求内容。');
}

function configuredOrigin(value) {
  if (!value) return null;
  const url = new URL(value);
  if (!['https:', 'http:'].includes(url.protocol) || url.href !== `${url.origin}/`) {
    throw new Error('VOTING_ORIGIN 须为网站源，例如 https://vote.example.org。');
  }
  if (url.protocol === 'http:' && !loopbackHosts.includes(url.hostname)) {
    throw new Error('对外地址须使用 HTTPS。');
  }
  return url.origin;
}

function requestOrigin(request, publicOrigin) {
  if (publicOrigin) return publicOrigin;
  try {
    const url = new URL(`http://${request.headers.host || ''}`);
    if (loopbackHosts.includes(url.hostname) && url.href === `${url.origin}/`) {
      return url.origin;
    }
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
  }
  throw new HttpError(400, '网站地址无效。');
}

async function serveStatic(request, response, pathname) {
  const file = pathname === '/' ? '/index.html' : pathname;
  if (!staticPaths.has(file) && !assetPath.test(file)) {
    throw new HttpError(404, '找不到页面。');
  }
  if (!['GET', 'HEAD'].includes(request.method)) {
    response.setHeader('Allow', 'GET, HEAD');
    throw new HttpError(405, '该请求方式不可用。');
  }
  let contents;
  try {
    contents = await readFile(new URL(`docs${file}`, root));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    throw new HttpError(404, '找不到页面。');
  }
  const extension = file.split('.').at(-1);
  if (file === '/index.html') {
    contents = Buffer.from(contents.toString('utf8').replace('data-mode="demo"', 'data-mode="live"'));
  }
  response.writeHead(200, {
    'Content-Type': contentTypes[extension],
    'Content-Length': contents.length,
    'Cache-Control': 'no-cache',
  });
  response.end(request.method === 'GET' ? contents : undefined);
}

export function createVotingServer({ databasePath = defaultDatabase, origin } = {}) {
  const publicOrigin = configuredOrigin(origin);
  const secure = publicOrigin?.startsWith('https:') ?? false;
  const cookieName = secure ? '__Host-voting_session' : 'voting_session';
  const db = openDatabase(databasePath);
  const lookupSession = db.prepare(`
    SELECT u.id, u.name, u.region, u.member_group, u.roles
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ? AND s.expires_at > ? AND u.enabled = 1
  `);
  const lookupUser = db.prepare(`
    SELECT id, name, region, member_group, roles FROM users
    WHERE login_hash = ? AND enabled = 1
  `);
  const lookupRoster = db.prepare(`
    SELECT id, name, region, member_group, roles FROM users WHERE enabled = 1
    ORDER BY id
  `);
  const getState = db.prepare('SELECT state FROM organization WHERE id = 1');
  const saveState = db.prepare('UPDATE organization SET state = ? WHERE id = 1');
  const insertSession = db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)');
  const deleteSession = db.prepare('DELETE FROM sessions WHERE token_hash = ?');
  const deleteExpiredSessions = db.prepare('DELETE FROM sessions WHERE expires_at <= ?');

  function authenticate(token, now) {
    return token ? toActor(lookupSession.get(hashToken(token), now)) : null;
  }

  function requireActor(token, now) {
    const actor = authenticate(token, now);
    if (!actor) throw new HttpError(401, '请先登录。');
    return actor;
  }

  function stateFor(actor, state = JSON.parse(getState.get().state)) {
    return { actor, state: viewState(state, actor) };
  }

  async function handleApi(request, response, pathname, expectedOrigin) {
    const routes = {
      '/api/session': 'GET',
      '/api/state': 'GET',
      '/api/login': 'POST',
      '/api/logout': 'POST',
      '/api/actions': 'POST',
    };
    const method = routes[pathname];
    if (!method) throw new HttpError(404, '找不到该接口。');
    if (request.method !== method) {
      response.setHeader('Allow', method);
      throw new HttpError(405, '该请求方式不可用。');
    }
    if (method === 'POST' && request.headers.origin !== expectedOrigin) {
      throw new HttpError(403, '请求须从本站发起。');
    }
    const session = cookieToken(request, cookieName);
    const body = method === 'POST' && pathname !== '/api/logout' ? await readJson(request) : null;
    const now = Date.now();

    switch (pathname) {
      case '/api/session':
        json(response, 200, { actor: authenticate(session, now) });
        return;
      case '/api/state':
        json(response, 200, stateFor(requireActor(session, now)));
        return;
      case '/api/login': {
        const loginToken = typeof body.token === 'string' ? body.token.trim() : '';
        if (!tokenPattern.test(loginToken)) throw new HttpError(401, '登录码无效或已停用。');
        const token = newToken();
        const actor = transaction(db, () => {
          const actor = toActor(lookupUser.get(hashToken(loginToken)));
          if (!actor) throw new HttpError(401, '登录码无效或已停用。');
          deleteExpiredSessions.run(now);
          if (session) deleteSession.run(hashToken(session));
          insertSession.run(hashToken(token), actor.id, now + sessionSeconds * 1000);
          return actor;
        });
        response.setHeader('Set-Cookie', sessionCookie(cookieName, token, sessionSeconds, secure));
        json(response, 200, { actor });
        return;
      }
      case '/api/logout':
        if (session) deleteSession.run(hashToken(session));
        response.setHeader('Set-Cookie', sessionCookie(cookieName, '', 0, secure));
        json(response, 200, { actor: null });
        return;
      case '/api/actions': {
        const result = transaction(db, () => {
          const actor = requireActor(session, now);
          const state = JSON.parse(getState.get().state);
          const next = applyAction(state, actor, body, now, lookupRoster.all().map(toActor));
          saveState.run(JSON.stringify(next));
          return stateFor(actor, next);
        });
        json(response, 200, result);
      }
    }
  }

  const server = createServer({ headersTimeout: 15000, requestTimeout: 30000 }, async (request, response) => {
    responseHeaders(response);
    try {
      const origin = requestOrigin(request, publicOrigin);
      if (!request.url?.startsWith('/') || request.url.startsWith('//')) {
        throw new HttpError(400, '网站地址无效。');
      }
      const { pathname } = new URL(request.url, origin);
      if (pathname.startsWith('/api/')) {
        await handleApi(request, response, pathname, origin);
      } else {
        await serveStatic(request, response, pathname);
      }
    } catch (error) {
      if (response.destroyed) return;
      if (error instanceof HttpError) {
        if (error.status === 413) response.setHeader('Connection', 'close');
        json(response, error.status, { error: error.message });
      } else if (error instanceof WorkflowError) {
        json(response, 422, { error: error.message });
      } else if (error.code === 'ERR_SQLITE_ERROR' && [5, 6].includes(error.errcode)) {
        json(response, 503, { error: '服务正忙，请重试。' });
      } else {
        console.error('Voting request failed:', error.name, error.code ?? '');
        json(response, 500, { error: '暂时无法处理请求。' });
      }
    }
  });
  server.once('close', () => db.close());
  return server;
}

function requireLabel(value, label) {
  const clean = value?.trim().normalize('NFC');
  if (!clean || clean.length > 100 || /[\u0000-\u001f\u007f]/u.test(clean)) {
    throw new Error(`${label}须为 1 到 100 个字符。`);
  }
  return clean;
}

function cli(command, args, databasePath) {
  const db = openDatabase(databasePath);
  try {
    if (command === 'add-user') {
      const { values } = parseArgs({ args, options: {
        name: { type: 'string' },
        region: { type: 'string' },
        group: { type: 'string' },
        roles: { type: 'string', default: 'member' },
      } });
      const roles = [...new Set(values.roles.split(',').map((role) => role.trim()))];
      if (roles.some((role) => !roleNames.includes(role))) {
        throw new Error(`可用角色为 ${roleNames.join(', ')}。`);
      }
      const id = randomUUID();
      const token = newToken();
      db.prepare('INSERT INTO users (id, name, region, member_group, roles, login_hash) VALUES (?, ?, ?, ?, ?, ?)')
        .run(id, requireLabel(values.name, '姓名'), requireLabel(values.region, '地区'),
          requireLabel(values.group, '小组'), JSON.stringify(roles), hashToken(token));
      console.log(JSON.stringify({ id, token }));
      return;
    }
    if (command === 'list-users' && args.length === 0) {
      const users = db.prepare('SELECT id, name, region, member_group, roles, enabled FROM users ORDER BY name').all();
      console.log(JSON.stringify(users.map((user) => ({ ...toActor(user), enabled: Boolean(user.enabled) })), null, 2));
      return;
    }
    if (['rotate-token', 'disable-user'].includes(command) && args.length === 1) {
      const [id] = args;
      const token = command === 'rotate-token' ? newToken() : null;
      transaction(db, () => {
        const result = token
          ? db.prepare('UPDATE users SET login_hash = ? WHERE id = ? AND enabled = 1').run(hashToken(token), id)
          : db.prepare('UPDATE users SET enabled = 0 WHERE id = ?').run(id);
        if (!result.changes) throw new Error('找不到可操作的账户。');
        db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
      });
      console.log(JSON.stringify(token ? { id, token } : { id, enabled: false }));
      return;
    }
    throw new Error('可用命令为 add-user、list-users、rotate-token <ID>、disable-user <ID>。');
  } finally {
    db.close();
  }
}

function main() {
  const [command, ...args] = process.argv.slice(2);
  const requestedPath = process.env.VOTING_DB || defaultDatabase;
  const databasePath = requestedPath === ':memory:' ? requestedPath : resolve(requestedPath);
  if (databasePath !== ':memory:') process.umask(0o077);
  if (command) {
    cli(command, args, databasePath);
    return;
  }
  const host = process.env.VOTING_HOST || '127.0.0.1';
  const port = Number(process.env.PORT || 8787);
  const origin = configuredOrigin(process.env.VOTING_ORIGIN);
  if (![...loopbackHosts, '::1'].includes(host) && !origin?.startsWith('https:')) {
    throw new Error('对外监听须设置 HTTPS 的 VOTING_ORIGIN。');
  }
  const server = createVotingServer({ databasePath, origin });
  server.listen(port, host, () => {
    const address = server.address();
    const urlHost = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
    console.log(`投票站已启动 ${origin || `http://${urlHost}:${address.port}`}`);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
