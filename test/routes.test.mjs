import assert from 'node:assert/strict'
import { mkdir, readFile, stat } from 'node:fs/promises'
import { join, sep } from 'node:path'
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
    const [list, , use] = createToolDefinitions({
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

const SESSION_A = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa'
const SESSION_B = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb'
const SESSION_A_TRAILING = 'aaaaaaaa-2222-4222-8222-aaaaaaaaaaaa'
const UNKNOWN_SESSION = '00000000-0000-4000-8000-000000000000'

async function setupScopes() {
  const home = await makeHome()
  const workspaceA = join(home, 'workspace-a')
  const workspaceB = join(home, 'workspace-b')
  await mkdir(workspaceA, { recursive: true })
  await mkdir(workspaceB, { recursive: true })
  const aOnly = await writeObject(home, Buffer.from('%PDF-1.7 a only'))
  const shared = await writeObject(home, Buffer.from('%PDF-1.7 shared'))
  const bOnly = await writeObject(home, Buffer.from('%PDF-1.7 b only'))
  await writeSession(home, {
    workspaceDir: '--a--', sessionId: SESSION_A, cwd: workspaceA, title: 'Chat A',
    messages: [
      { name: 'a-only.pdf', mime: 'application/pdf', bytes: aOnly.bytes, sha: aOnly.sha },
      { name: 'shared.pdf', mime: 'application/pdf', bytes: shared.bytes, sha: shared.sha },
    ],
  })
  await writeSession(home, {
    workspaceDir: '--b--', sessionId: SESSION_B, cwd: workspaceB, title: 'Chat B',
    messages: [
      { name: 'shared.pdf', mime: 'application/pdf', bytes: shared.bytes, sha: shared.sha },
      { name: 'b-only.pdf', mime: 'application/pdf', bytes: bOnly.bytes, sha: bOnly.sha },
    ],
  })
  // Same directory, written with a trailing separator: the host must fold it.
  await writeSession(home, {
    workspaceDir: '--a--', sessionId: SESSION_A_TRAILING, cwd: `${workspaceA}${sep}`, title: 'Chat A again',
    messages: [],
  })
  const library = createLibrary({ home, cacheDir: join(home, 'cache') })
  await library.init({ background: false })
  const filer = createFiler({ home, limits: DEFAULT_LIMITS })
  const resolveWorkspace = createWorkspaceResolver({ home, library })
  const routes = createRoutes({ library, filer, resolveWorkspace, cacheDir: join(home, 'cache'), limits: DEFAULT_LIMITS })
  const server = await startRouteServer(routes.handle)
  return { home, workspaceA, workspaceB, aOnly, shared, bOnly, library, filer, resolveWorkspace, routes, server }
}

async function indexFor(server, query) {
  const response = await get(server, `/plugins/dsh-file-library/index?${query}`)
  assert.equal(response.status, 200)
  return response.json()
}

test('the index defaults to the session workspace and scope=all widens it to the whole host', async () => {
  const ctx = await setupScopes()
  try {
    const a = await indexFor(ctx.server, `sessionId=${SESSION_A}`)
    assert.equal(a.ok, true)
    assert.equal(a.scope, 'workspace')
    assert.equal(a.scopeFallback, undefined)
    assert.equal(a.count, 2)
    assert.equal(a.totalAll, 3)
    assert.deepEqual(a.entries.map(entry => entry.name).sort(), ['a-only.pdf', 'shared.pdf'])
    for (const entry of a.entries) {
      assert.equal(entry.inWorkspace, true)
      assert.equal(Object.hasOwn(entry, 'workspace'), false)
      assert.equal(Object.hasOwn(entry, 'workspaces'), false)
    }
    assert.equal(JSON.stringify(a).includes(ctx.workspaceA), false, 'no absolute path reaches the browser')
    assert.equal(JSON.stringify(a).includes(ctx.workspaceB), false)

    const b = await indexFor(ctx.server, `sessionId=${SESSION_B}`)
    assert.equal(b.scope, 'workspace')
    assert.deepEqual(b.entries.map(entry => entry.name).sort(), ['b-only.pdf', 'shared.pdf'])
    assert.equal(b.totalAll, 3)

    const all = await indexFor(ctx.server, `sessionId=${SESSION_A}&scope=all`)
    assert.equal(all.scope, 'all')
    assert.equal(all.scopeFallback, undefined)
    assert.equal(all.count, 3)
    assert.equal(all.totalAll, 3)
    assert.deepEqual(all.entries.map(entry => entry.name).sort(), ['a-only.pdf', 'b-only.pdf', 'shared.pdf'])

    // A trailing separator in the session header names the same workspace.
    const trailing = await indexFor(ctx.server, `sessionId=${SESSION_A_TRAILING}`)
    assert.equal(trailing.scope, 'workspace')
    assert.deepEqual(trailing.entries.map(entry => entry.name).sort(), ['a-only.pdf', 'shared.pdf'])
  } finally {
    await ctx.server.close()
    await cleanup(ctx.home)
  }
})

test('an unresolvable session falls back to all files and reports why', async () => {
  const ctx = await setupScopes()
  try {
    const unknown = await indexFor(ctx.server, `sessionId=${UNKNOWN_SESSION}`)
    assert.equal(unknown.scope, 'all')
    assert.equal(unknown.scopeFallback, 'unknown-session')
    assert.equal(unknown.count, 3)

    const invalid = await indexFor(ctx.server, 'sessionId=not%20a%20session')
    assert.equal(invalid.scope, 'all')
    assert.equal(invalid.scopeFallback, 'invalid-session')
    assert.equal(invalid.count, 3)

    const none = await indexFor(ctx.server, 'limit=50')
    assert.equal(none.scope, 'all')
    assert.equal(none.scopeFallback, 'no-session')
    assert.equal(none.count, 3)

    // An explicit all-files request is a choice, not a fallback.
    const explicit = await indexFor(ctx.server, `sessionId=${UNKNOWN_SESSION}&scope=all`)
    assert.equal(explicit.scope, 'all')
    assert.equal(explicit.scopeFallback, undefined)
    assert.equal(explicit.count, 3)
  } finally {
    await ctx.server.close()
    await cleanup(ctx.home)
  }
})

test('a file filed into a workspace from another session shows up in that workspace', async () => {
  const ctx = await setupScopes()
  try {
    // a-only.pdf was sent from workspace A; file it into workspace B from B's session.
    const filedResponse = await post(ctx.server, '/plugins/dsh-file-library/file', {
      sha: ctx.aOnly.sha, sessionId: SESSION_B,
    })
    assert.equal(filedResponse.status, 200)
    const filed = await filedResponse.json()
    assert.equal(filed.relativePath, 'library/a-only.pdf')

    const b = await indexFor(ctx.server, `sessionId=${SESSION_B}`)
    const row = b.entries.find(entry => entry.sha256 === ctx.aOnly.sha)
    assert.ok(row, 'a file filed into B belongs to B')
    assert.equal(row.filed, true)
    assert.equal(row.filedPath, 'library/a-only.pdf')
    assert.equal(row.inWorkspace, false)
    assert.equal(b.count, 3)

    const a = await indexFor(ctx.server, `sessionId=${SESSION_A}`)
    assert.equal(a.entries.some(entry => entry.sha256 === ctx.aOnly.sha), true)
    assert.equal(a.entries.length, 2, 'filing into B does not duplicate rows in A')

    const search = await indexFor(ctx.server, `sessionId=${SESSION_B}&q=a-only`)
    assert.equal(search.count, 1)
    assert.equal(search.entries[0].sha256, ctx.aOnly.sha)

    const all = await indexFor(ctx.server, `sessionId=${SESSION_B}&scope=all`)
    assert.equal(all.count, 3)
    assert.equal(all.entries.filter(entry => entry.filed).length, 1)
  } finally {
    await ctx.server.close()
    await cleanup(ctx.home)
  }
})

test('library_list defaults to the agent session workspace and widens on scope=all', async () => {
  const ctx = await setupScopes()
  try {
    const [list] = createToolDefinitions({
      library: ctx.library, filer: ctx.filer, resolveWorkspace: ctx.resolveWorkspace,
    })
    const scoped = await list.execute({}, { agent: { session: { id: SESSION_B, header: { cwd: ctx.workspaceB } } } })
    assert.equal(scoped.scope, 'workspace')
    assert.deepEqual(scoped.entries.map(entry => entry.name).sort(), ['b-only.pdf', 'shared.pdf'])
    assert.equal(scoped.total, 2)

    const explicitAll = await list.execute({ scope: 'all' }, { agent: { session: { id: SESSION_B, header: { cwd: ctx.workspaceB } } } })
    assert.equal(explicitAll.scope, 'all')
    assert.equal(explicitAll.count, 3)

    const noWorkspace = await list.execute({})
    assert.equal(noWorkspace.scope, 'all')
    assert.equal(noWorkspace.count, 3)
  } finally {
    await ctx.server.close()
    await cleanup(ctx.home)
  }
})
const ONE_PIXEL_PNG_2 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

async function setupObjects() {
  const home = await makeHome()
  const workspace = join(home, 'workspace')
  await mkdir(workspace, { recursive: true })
  const png = await writeObject(home, ONE_PIXEL_PNG_2)
  const pdf = await writeObject(home, Buffer.from('%PDF-1.7 object route fixture'))
  const html = await writeObject(home, Buffer.from('<!doctype html><script>alert(1)</script>'))
  const svg = await writeObject(home, Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'))
  const text = await writeObject(home, Buffer.from('plain text fixture\n'))
  const orphan = await writeObject(home, Buffer.from('never referenced by a session'))
  await writeSession(home, {
    sessionId: '12345678-1234-4123-8123-123456789abc',
    cwd: workspace,
    title: 'Object route fixtures',
    messages: [
      { name: 'pixel.png', mime: 'image/png', bytes: png.bytes, sha: png.sha },
      { name: 'brief.pdf', mime: 'application/pdf', bytes: pdf.bytes, sha: pdf.sha },
      { name: 'page.html', mime: 'text/html', bytes: html.bytes, sha: html.sha },
      { name: 'vector.svg', mime: 'image/svg+xml', bytes: svg.bytes, sha: svg.sha },
      { name: 'notes.txt', mime: 'text/plain', bytes: text.bytes, sha: text.sha },
    ],
  })
  const library = createLibrary({ home, cacheDir: join(home, 'cache') })
  await library.init({ background: false })
  const filer = createFiler({ home, limits: DEFAULT_LIMITS })
  const resolveWorkspace = createWorkspaceResolver({ home, library })
  const routes = createRoutes({ library, filer, resolveWorkspace, cacheDir: join(home, 'cache'), limits: DEFAULT_LIMITS })
  const server = await startRouteServer(routes.handle)
  return { home, workspace, png, pdf, html, svg, text, orphan, library, server }
}

test('/object streams a whole indexed object with a strong cache header', async () => {
  const ctx = await setupObjects()
  try {
    const response = await get(ctx.server, `/plugins/dsh-file-library/object/${ctx.png.sha}`)
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('content-type'), 'image/png')
    assert.equal(response.headers.get('accept-ranges'), 'bytes')
    assert.equal(response.headers.get('etag'), `"${ctx.png.sha}"`)
    assert.match(response.headers.get('cache-control'), /immutable/)
    assert.match(response.headers.get('content-disposition'), /^inline;/)
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff')
    assert.match(response.headers.get('content-security-policy'), /default-src 'none'/)
    assert.equal(sha256Bytes(Buffer.from(await response.arrayBuffer())), ctx.png.sha)

    const head = await fetch(ctx.server.url(`/plugins/dsh-file-library/object/${ctx.png.sha}`), {
      method: 'HEAD', headers: { 'sec-fetch-site': 'same-origin' },
    })
    assert.equal(head.status, 200)
    assert.equal(head.headers.get('content-length'), String(ctx.png.bytes))
    assert.equal((await head.arrayBuffer()).byteLength, 0)
  } finally {
    await ctx.server.close()
    await cleanup(ctx.home)
  }
})

test('/object serves a single range and refuses an unsatisfiable one', async () => {
  const ctx = await setupObjects()
  try {
    const partial = await get(ctx.server, `/plugins/dsh-file-library/object/${ctx.pdf.sha}`, { Range: 'bytes=0-3' })
    assert.equal(partial.status, 206)
    assert.equal(partial.headers.get('content-range'), `bytes 0-3/${ctx.pdf.bytes}`)
    assert.equal(partial.headers.get('content-length'), '4')
    assert.equal(Buffer.from(await partial.arrayBuffer()).toString(), '%PDF')

    // An open-ended suffix range starts at the end.
    const tail = await get(ctx.server, `/plugins/dsh-file-library/object/${ctx.pdf.sha}`, { Range: 'bytes=-5' })
    assert.equal(tail.status, 206)
    assert.equal(tail.headers.get('content-range'), `bytes ${ctx.pdf.bytes - 5}-${ctx.pdf.bytes - 1}/${ctx.pdf.bytes}`)

    const unsatisfiable = await get(ctx.server, `/plugins/dsh-file-library/object/${ctx.pdf.sha}`, { Range: 'bytes=99999-' })
    assert.equal(unsatisfiable.status, 416)
    assert.equal(unsatisfiable.headers.get('content-range'), `bytes */${ctx.pdf.bytes}`)
  } finally {
    await ctx.server.close()
    await cleanup(ctx.home)
  }
})

test('an HTML or SVG object downloads instead of rendering same-origin', async () => {
  const ctx = await setupObjects()
  try {
    for (const [sha, name] of [[ctx.html.sha, 'page.html'], [ctx.svg.sha, 'vector.svg']]) {
      const response = await get(ctx.server, `/plugins/dsh-file-library/object/${sha}`)
      assert.equal(response.status, 200)
      assert.equal(response.headers.get('content-type'), 'application/octet-stream')
      assert.match(response.headers.get('content-disposition'), /^attachment;/)
      assert.match(response.headers.get('content-disposition'), new RegExp(`filename="${name}"`))
      assert.equal(response.headers.get('x-content-type-options'), 'nosniff')
    }
  } finally {
    await ctx.server.close()
    await cleanup(ctx.home)
  }
})

test('/object renders PDF, plain text and images inline and carries an RFC 5987 name', async () => {
  const ctx = await setupObjects()
  try {
    const pdf = await get(ctx.server, `/plugins/dsh-file-library/object/${ctx.pdf.sha}`)
    assert.equal(pdf.headers.get('content-type'), 'application/pdf')
    assert.match(pdf.headers.get('content-disposition'), /^inline;/)

    const text = await get(ctx.server, `/plugins/dsh-file-library/object/${ctx.text.sha}`)
    assert.match(text.headers.get('content-type'), /^text\/plain/)
    assert.match(text.headers.get('content-disposition'), /^inline;/)
    assert.match(text.headers.get('content-disposition'), /filename\*=UTF-8''notes\.txt/)

    const entry = ctx.library.get(ctx.text.sha)
    const original = entry.name
    entry.name = 'Q3 报告.txt'
    try {
      const named = await get(ctx.server, `/plugins/dsh-file-library/object/${ctx.text.sha}`)
      const disposition = named.headers.get('content-disposition')
      assert.match(disposition, /filename="Q3 __\.txt"/)
      assert.match(disposition, /filename\*=UTF-8''Q3%20%E6%8A%A5%E5%91%8A\.txt/)
    } finally {
      entry.name = original
    }
  } finally {
    await ctx.server.close()
    await cleanup(ctx.home)
  }
})

test('/object refuses unknown, unindexed, cross-site and non-GET requests', async () => {
  const ctx = await setupObjects()
  try {
    assert.equal((await get(ctx.server, `/plugins/dsh-file-library/object/${'a'.repeat(64)}`)).status, 404)
    assert.equal((await get(ctx.server, `/plugins/dsh-file-library/object/${ctx.orphan.sha}`)).status, 404)
    assert.equal((await get(ctx.server, '/plugins/dsh-file-library/object/not-a-sha')).status, 404)
    assert.equal((await get(ctx.server, '/plugins/dsh-file-library/object')).status, 405)
    assert.equal((await get(ctx.server, `/plugins/dsh-file-library/object/${ctx.png.sha}`, { 'sec-fetch-site': 'cross-site' })).status, 403)

    const posted = await fetch(ctx.server.url(`/plugins/dsh-file-library/object/${ctx.png.sha}`), {
      method: 'POST', headers: { 'sec-fetch-site': 'same-origin' },
    })
    assert.equal(posted.status, 405)
  } finally {
    await ctx.server.close()
    await cleanup(ctx.home)
  }
})

test('/index publishes the scan coverage and a per-row state', async () => {
  const ctx = await setupScopes()
  try {
    const a = await indexFor(ctx.server, `sessionId=${SESSION_A}`)
    assert.equal(a.coverage.truncated, false)
    assert.equal(a.coverage.sessionsSkipped, 0)
    assert.equal(typeof a.coverage.sessionsFound, 'number')
    for (const entry of a.entries) {
      assert.ok(['filed-here', 'in-workspace', 'global', 'missing'].includes(entry.state))
    }
    // A file sent only from A is in A's workspace scope.
    const aOnly = a.entries.find(entry => entry.sha256 === ctx.aOnly.sha)
    assert.equal(aOnly.state, 'in-workspace')
    assert.equal(aOnly.inWorkspace, true)
  } finally {
    await ctx.server.close()
    await cleanup(ctx.home)
  }
})
