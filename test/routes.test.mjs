import assert from 'node:assert/strict'
import { mkdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { createFiler } from '../lib/filing.js'
import { createLibrary } from '../lib/library.js'
import { createRoutes } from '../lib/routes.js'
import { createWorkspaceResolver } from '../lib/sessions.js'
import { createToolDefinitions } from '../lib/tools.js'
import { DEFAULT_LIMITS } from '../lib/indexer.js'
import { sha256Bytes } from '../lib/util.js'
import { cleanup, makeHome, startRouteServer, writeObject, writeSession } from './helpers.mjs'

const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

async function setup() {
  const home = await makeHome()
  const workspace = join(home, 'workspace')
  await mkdir(workspace, { recursive: true })
  const png = await writeObject(home, ONE_PIXEL_PNG)
  const pdf = await writeObject(home, Buffer.from('%PDF-1.7 routes fixture'))
  const orphan = await writeObject(home, Buffer.from('never referenced by a session'))
  await writeSession(home, {
    sessionId: '12345678-1234-4123-8123-123456789abc',
    cwd: workspace,
    title: 'Launch assets',
    messages: [
      { name: 'pixel.png', mime: 'image/png', bytes: png.bytes, sha: png.sha },
      { name: 'brief.pdf', mime: 'application/pdf', bytes: pdf.bytes, sha: pdf.sha },
    ],
  })
  const library = createLibrary({ home, cacheDir: join(home, 'cache') })
  await library.init({ background: false })
  const filer = createFiler({ home, limits: DEFAULT_LIMITS })
  const resolveWorkspace = createWorkspaceResolver({ home, library })
  const routes = createRoutes({ library, filer, resolveWorkspace, cacheDir: join(home, 'cache'), limits: DEFAULT_LIMITS })
  const server = await startRouteServer(routes.handle)
  return { home, workspace, png, pdf, orphan, library, filer, resolveWorkspace, routes, server }
}

async function get(server, path, headers = {}) {
  return fetch(server.url(path), {
    headers: { 'sec-fetch-site': 'same-origin', Accept: '*/*', ...headers },
  })
}

async function post(server, path, body, headers = {}) {
  return fetch(server.url(path), {
    method: 'POST',
    headers: { 'sec-fetch-site': 'same-origin', 'Content-Type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

test('index, thumbnail, file and filed routes work over a real same-origin HTTP server', async () => {
  const ctx = await setup()
  try {
    const indexResponse = await get(ctx.server, `/plugins/dsh-file-library/index?sessionId=12345678-1234-4123-8123-123456789abc`)
    assert.equal(indexResponse.status, 200)
    const index = await indexResponse.json()
    assert.equal(index.ok, true)
    assert.equal(index.count, 2)
    assert.equal(index.entries.length, 2)
    assert.equal(index.entries.filter(entry => entry.filed).length, 0)

    const imageResponse = await get(ctx.server, `/plugins/dsh-file-library/thumb/${ctx.png.sha}`)
    assert.equal(imageResponse.status, 200)
    assert.equal(imageResponse.headers.get('content-type'), 'image/png')
    assert.equal(imageResponse.headers.get('x-content-type-options'), 'nosniff')
    assert.equal(sha256Bytes(Buffer.from(await imageResponse.arrayBuffer())), ctx.png.sha)

    const iconResponse = await get(ctx.server, `/plugins/dsh-file-library/thumb/${ctx.pdf.sha}`)
    assert.equal(iconResponse.status, 200)
    assert.match(iconResponse.headers.get('content-type'), /image\/svg\+xml/)
    const icon = await iconResponse.text()
    assert.match(icon, /^<svg/)
    assert.doesNotMatch(icon, /<script/i)
    assert.doesNotMatch(icon, /javascript:/i)

    const fileResponse = await post(ctx.server, '/plugins/dsh-file-library/file', {
      sha: ctx.png.sha,
      sessionId: '12345678-1234-4123-8123-123456789abc',
      tags: ['zebra'],
    })
    assert.equal(fileResponse.status, 200)
    const filed = await fileResponse.json()
    assert.equal(filed.ok, true)
    assert.equal(filed.reference, '@library/pixel.png')
    assert.equal(filed.relativePath, 'library/pixel.png')
    assert.equal(filed.deduped, false)
    assert.equal(sha256Bytes(await readFile(filed.absolutePath ?? join(ctx.workspace, 'library', 'pixel.png'))), ctx.png.sha)

    const filedResponse = await get(ctx.server, `/plugins/dsh-file-library/filed?sessionId=12345678-1234-4123-8123-123456789abc`)
    const filedBody = await filedResponse.json()
    assert.equal(filedBody.count, 1)
    assert.equal(filedBody.files[0].tags[0], 'zebra')

    const byTag = await (await get(ctx.server, `/plugins/dsh-file-library/index?sessionId=12345678-1234-4123-8123-123456789abc&q=zebra`)).json()
    assert.equal(byTag.count, 1)
    assert.equal(byTag.entries[0].sha256, ctx.png.sha)

    const after = await (await get(ctx.server, `/plugins/dsh-file-library/index?sessionId=12345678-1234-4123-8123-123456789abc`)).json()
    const row = after.entries.find(entry => entry.sha256 === ctx.png.sha)
    assert.equal(row.filed, true)
    assert.equal(row.filedPath, 'library/pixel.png')
    assert.equal(after.filedCount, 1)

    const manifest = JSON.parse(await readFile(join(ctx.workspace, 'library', '.manifest.json'), 'utf8'))
    assert.equal(manifest.files.length, 1)
    assert.match(await readFile(join(ctx.workspace, 'library', 'INDEX.md'), 'utf8'), /pixel\.png/)
  } finally {
    await ctx.server.close()
    await cleanup(ctx.home)
  }
})

test('an unindexed SHA gets 404 for bytes even when the object exists', async () => {
  const ctx = await setup()
  try {
    const response = await get(ctx.server, `/plugins/dsh-file-library/thumb/${ctx.orphan.sha}`)
    assert.equal(response.status, 404)
    const random = await get(ctx.server, `/plugins/dsh-file-library/thumb/${'a'.repeat(64)}`)
    assert.equal(random.status, 404)
    const bad = await get(ctx.server, `/plugins/dsh-file-library/thumb/not-a-sha`)
    assert.equal(bad.status, 404)
  } finally {
    await ctx.server.close()
    await cleanup(ctx.home)
  }
})

test('cross-origin and malformed requests are refused', async () => {
  const ctx = await setup()
  try {
    const crossSite = await get(ctx.server, '/plugins/dsh-file-library/index', { 'sec-fetch-site': 'cross-site' })
    assert.equal(crossSite.status, 403)

    const crossOrigin = await get(ctx.server, '/plugins/dsh-file-library/index', {
      origin: 'https://evil.example', 'sec-fetch-site': '',
    })
    assert.equal(crossOrigin.status, 403)

    const wrongType = await post(ctx.server, '/plugins/dsh-file-library/file', 'x', { 'Content-Type': 'text/plain' })
    assert.equal(wrongType.status, 415)

    const badSha = await post(ctx.server, '/plugins/dsh-file-library/file', {
      sha: 'not-a-sha', sessionId: '12345678-1234-4123-8123-123456789abc',
    })
    assert.equal(badSha.status, 400)

    const unknownSha = await post(ctx.server, '/plugins/dsh-file-library/file', {
      sha: 'b'.repeat(64), sessionId: '12345678-1234-4123-8123-123456789abc',
    })
    assert.equal(unknownSha.status, 404)

    const unknownSession = await post(ctx.server, '/plugins/dsh-file-library/file', {
      sha: ctx.png.sha, sessionId: '00000000-0000-4000-8000-000000000000',
    })
    assert.equal(unknownSession.status, 404)

    const tooLarge = await post(ctx.server, '/plugins/dsh-file-library/file', {
      sha: ctx.png.sha, sessionId: '12345678-1234-4123-8123-123456789abc', padding: 'x'.repeat(70 * 1024),
    })
    assert.equal(tooLarge.status, 413)
  } finally {
    await ctx.server.close()
    await cleanup(ctx.home)
  }
})

test('a hostile indexed name is refused by the file route without writing', async () => {
  const ctx = await setup()
  try {
    const entry = ctx.library.get(ctx.png.sha)
    const original = entry.name
    entry.name = '../../escape.png'
    try {
      const response = await post(ctx.server, '/plugins/dsh-file-library/file', {
        sha: ctx.png.sha, sessionId: '12345678-1234-4123-8123-123456789abc',
      })
      assert.equal(response.status, 400)
      await assert.rejects(() => stat(join(ctx.home, 'escape.png')))
      await assert.rejects(() => stat(join(ctx.workspace, 'escape.png')))
    } finally {
      entry.name = original
    }
  } finally {
    await ctx.server.close()
    await cleanup(ctx.home)
  }
})

test('agent tools list and file a library entry', async () => {
  const ctx = await setup()
  try {
    const [list, use] = createToolDefinitions({
      library: ctx.library, filer: ctx.filer, resolveWorkspace: ctx.resolveWorkspace,
    })
    const listed = await list.execute({ query: 'brief', kind: 'pdf' })
    assert.equal(listed.count, 1)
    assert.equal(listed.entries[0].name, 'brief.pdf')
    assert.equal(listed.entries[0].sha256, ctx.pdf.sha)

    const used = await use.execute(
      { nameOrSha: 'brief.pdf' },
      { agent: { session: { id: '12345678-1234-4123-8123-123456789abc', header: { cwd: ctx.workspace } } }, signal: new AbortController().signal },
    )
    assert.equal(used.reference, '@library/brief.pdf')
    assert.equal(used.deduped, false)
    assert.equal(sha256Bytes(await readFile(join(ctx.workspace, 'library', 'brief.pdf'))), ctx.pdf.sha)

    const again = await use.execute(
      { nameOrSha: ctx.pdf.sha.slice(0, 12) },
      { agent: { session: { id: '12345678-1234-4123-8123-123456789abc', header: { cwd: ctx.workspace } } }, signal: new AbortController().signal },
    )
    assert.equal(again.deduped, true)
    assert.equal(again.reference, '@library/brief.pdf')
  } finally {
    await ctx.server.close()
    await cleanup(ctx.home)
  }
})
