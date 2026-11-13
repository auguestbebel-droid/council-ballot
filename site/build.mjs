import assert from 'node:assert/strict'
import { copyFile, cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const fistAsset = 'assets/fist-outline.svg'
const textAssets = new Map([
  ['index.html', 'text/html; charset=utf-8'],
  ['styles.css', 'text/css; charset=utf-8'],
  ['app.js', 'text/javascript; charset=utf-8'],
  ['admin.js', 'text/javascript; charset=utf-8'],
  ['favicon.svg', 'image/svg+xml'],
  [fistAsset, 'image/svg+xml'],
])

async function prepare(checkout) {
  assert.ok(isAbsolute(checkout), 'Use the absolute path returned by the Sites source helper.')
  assert.notEqual(resolve(checkout), resolve(root), 'Prepare in a dedicated Sites checkout.')
  const manifest = JSON.parse(await readFile(join(checkout, '.openai/hosting.json'), 'utf8'))
  assert.ok(typeof manifest.project_id === 'string' && manifest.project_id, 'Persist the Site project ID first.')
  assert.equal(manifest.d1, 'DB', 'Declare the DB binding in the Site hosting manifest.')
  const files = ['site/build.mjs', 'site/worker.js', 'docs/workflow.js', ...Array.from(textAssets.keys(), path => `docs/${path}`)]
  for (const name of files) {
    const path = join(checkout, name)
    await mkdir(dirname(path), { recursive: true })
    await copyFile(join(root, name), path)
  }
  await cp(join(root, 'site/drizzle'), join(checkout, 'drizzle'), { recursive: true })
  await writeFile(join(checkout, '.gitignore'), '/dist/\n/node_modules/\n/.env*\n/.dev.vars*\n/.wrangler/\n')
  await writeFile(join(checkout, 'package.json'), `${JSON.stringify({
    name: 'council-ballot-site',
    private: true,
    type: 'module',
    scripts: { build: 'node site/build.mjs' },
  }, null, 2)}\n`)
  console.log(`Prepared Sites source in ${checkout}`)
}

async function assetModule() {
  const assets = {}
  for (const [name, type] of textAssets) {
    let body = await readFile(join(root, 'docs', name), 'utf8')
    if (name === 'index.html') {
      assert.match(body, /data-mode="portal"/)
      body = body.replace('data-mode="portal"', 'data-mode="live" data-admin="true"')
    }
    assets[`/${name}`] = { type, body }
  }
  return `const staticAssets = ${JSON.stringify(assets)};
function serveAsset(request) {
  const pathname = new URL(request.url).pathname;
  const path = pathname === '/' ? '/index.html' : pathname;
  const asset = Object.hasOwn(staticAssets, path) ? staticAssets[path] : null;
  if (!asset) return new Response('找不到页面。', { status: 404 });
  if (!['GET', 'HEAD'].includes(request.method)) {
    return new Response('该请求方式不可用。', { status: 405, headers: { allow: 'GET, HEAD' } });
  }
  const body = request.method === 'HEAD' ? null : asset.body;
  return new Response(body, { headers: { 'content-type': asset.type, 'cache-control': 'no-cache' } });
}`
}

async function build() {
  const manifestPath = join(root, '.openai/hosting.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  assert.ok(typeof manifest.project_id === 'string' && manifest.project_id)
  assert.equal(manifest.d1, 'DB')
  assert.equal(manifest.static, undefined, 'Sites Workers must omit static hosting configuration.')
  const workflow = await readFile(join(root, 'docs/workflow.js'), 'utf8')
  const worker = await readFile(join(root, 'site/worker.js'), 'utf8')
  const imports = [...worker.matchAll(/^import\s*\{([\s\S]*?)\}\s*from\s*['"]\.\.\/docs\/workflow\.js['"];?[\t ]*$/gm)]
  assert.equal(imports.length, 1, 'Worker must import its workflow symbols from ../docs/workflow.js.')
  const [statement, bindings] = imports[0]
  assert.match(worker, /^export default createWorker\(\)$/m)
  const names = [...workflow.matchAll(/^export (?:async )?(?:function|class|const|let) (\w+)/gm)].map(match => match[1])
  assert.ok(names.includes('applyAction') && names.includes('viewState'), 'The workflow must export its shared functions.')
  const workflowModule = `const sharedWorkflow = (() => {\n${workflow.replace(/^export /gm, '')}\nreturn { ${names.join(', ')} };\n})();\n`
  const workerModule = worker.replace(statement, `const {${bindings}} = sharedWorkflow;`)
    .replace(/^export default createWorker\(\)$/m, 'export default createWorker(serveAsset)')
  const source = [workflowModule, await assetModule(), workerModule].join('\n\n')
  const dist = join(root, 'dist')
  const entrypoint = join(dist, 'server/index.js')
  await mkdir(dirname(entrypoint), { recursive: true })
  await mkdir(join(dist, '.openai'), { recursive: true })
  await writeFile(entrypoint, source)
  await copyFile(manifestPath, join(dist, '.openai/hosting.json'))

  const { default: app } = await import(pathToFileURL(entrypoint))
  assert.equal(typeof app?.fetch, 'function', 'The artifact must export default.fetch.')
  const response = await app.fetch(new Request('https://build-check.example/'), {})
  assert.equal(response.status, 200)
  assert.match(await response.text(), /data-mode="live" data-admin="true"/)
  const image = await app.fetch(new Request(`https://build-check.example/${fistAsset}`), {})
  assert.equal(image.headers.get('content-type'), 'image/svg+xml')
  assert.match(await image.text(), /<svg\b/)
  assert.equal((await app.fetch(new Request('https://build-check.example/server.mjs'), {})).status, 404)
  console.log(`Built and checked ${entrypoint}`)
}

const [flag, checkout, ...extra] = process.argv.slice(2)
if (flag === '--prepare' && checkout && !extra.length) await prepare(checkout)
else if (flag === undefined) await build()
else throw new Error('Usage: node site/build.mjs [--prepare ABSOLUTE_SITE_CHECKOUT]')
