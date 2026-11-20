import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { cleanup, loadClient, makeHome, serialize } from './helpers.mjs'

const NOW = 1_800_000_000_000

function entry(overrides) {
  return {
    sha256: 'a'.repeat(64),
    name: 'Q3 review.pdf',
    mediaType: 'application/pdf',
    bytes: 2048,
    sentAt: NOW - 90 * 24 * 60 * 60 * 1000,
    sessionId: 'session-1',
    sessionTitle: 'Quarterly reports',
    kind: 'pdf',
    ext: 'pdf',
    occurrences: 1,
    filed: false,
    tags: [],
    ...overrides,
  }
}

test('the panel renders at 768px, in fullscreen, with zero files (empty state, no broken image)', async () => {
  const api = await loadClient()
  const model = api.__internals.buildModel({
    entries: [], width: 768, fullscreen: true, view: 'grid', now: NOW,
  })
  const html = serialize(api.__internals.buildView(model))
  assert.match(html, /data-dfl-width="768"/)
  assert.match(html, /data-dfl-fullscreen="true"/)
  assert.match(html, /data-dfl-empty="true"/)
  assert.match(html, /data-dfl-count="0"/)
  assert.match(html, /Your file library is empty/)
  assert.match(html, /shared attachment store/)
  assert.doesNotMatch(html, /<img\b/, 'an empty library must not render a broken image')
  assert.match(html, /data-dfl-empty-state="library-empty"/)
})

test('the grid renders thumbnail sources, type chips, recency and session title', async () => {
  const api = await loadClient()
  const image = entry({
    sha256: 'b'.repeat(64), name: 'pixel.png', mediaType: 'image/png', kind: 'image', ext: 'png',
  })
  const pdf = entry({})
  const model = api.__internals.buildModel({
    entries: [image, pdf], width: 900, fullscreen: false, view: 'grid', now: NOW,
  })
  const html = serialize(api.__internals.buildView(model))
  assert.match(html, /data-dfl-count="2"/)
  assert.match(html, /data-dfl-kind="image"/)
  assert.match(html, /data-dfl-kind="pdf"/)
  assert.equal((html.match(/<img\b/g) ?? []).length, 1, 'only image rows carry an <img>')
  assert.match(html, new RegExp(`src="/plugins/dsh-file-library/thumb/${image.sha256}"`))
  assert.match(html, /sent 3 months ago/)
  assert.match(html, /Quarterly reports/)
  assert.match(html, /data-dfl-chip="pdf"/)
  assert.match(html, /pixel\.png/)
})

test('list view and multi-select toolbar render, and search filters deterministically', async () => {
  const api = await loadClient()
  const pdf = entry({})
  const doc = entry({ sha256: 'c'.repeat(64), name: 'notes.docx', mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', kind: 'doc', ext: 'docx' })
  const list = api.__internals.buildModel({
    entries: [pdf, doc], width: 500, view: 'list', selected: [pdf.sha256], now: NOW,
  })
  const html = serialize(api.__internals.buildView(list))
  assert.match(html, /data-dfl-view="list"/)
  assert.match(html, /class="dfl-list"/)
  assert.match(html, /data-dfl-selected="1"/)
  assert.match(html, /Use in chat/)
  assert.match(html, /File this/)

  const filtered = api.__internals.buildModel({ entries: [pdf, doc], query: 'notes', width: 700, now: NOW })
  assert.equal(filtered.entries.length, 1)
  assert.equal(filtered.entries[0].name, 'notes.docx')
  const noResults = serialize(api.__internals.buildView(
    api.__internals.buildModel({ entries: [pdf], query: 'zzz', width: 700, now: NOW }),
  ))
  assert.match(noResults, /data-dfl-empty-state="no-results"/)
  assert.match(noResults, /No files match that search/)
})

test('a name with a space is quoted so the reference token does not stop early', async () => {
  const api = await loadClient()
  const reference = api.__internals.buildReference({ name: 'Q3 review.pdf' })
  assert.equal(reference, '@"library/Q3 review.pdf"')
  assert.match(reference, /^@"library\/[^/]+"$/)
  assert.equal(api.__internals.buildReference({ name: 'pixel.png' }), '@library/pixel.png')
  assert.equal(api.__internals.buildReference({ name: 'report.' }), '@"library/report."')

  const home = await makeHome()
  try {
    await mkdir(join(home, 'workspace', 'library'), { recursive: true })
    const relative = reference.slice(2, -1)
    await writeFile(join(home, 'workspace', relative), 'readable')
    const { readFile } = await import('node:fs/promises')
    assert.equal(await readFile(join(home, 'workspace', relative), 'utf8'), 'readable')
  } finally {
    await cleanup(home)
  }
})

test('use in chat emits one composer text insertion with a trailing space', async () => {
  const api = await loadClient()
  const emitted = []
  const fakeScope = {
    bail(name, request) {
      emitted.push({ name, request })
      return name === 'slash/input-insert-text' && typeof request.text === 'string'
    },
  }
  const fakeCtx = {
    effect: fn => fn(),
    sidebarRightTabs: { register: () => () => undefined },
    slots: { inject: (_name, fn) => fn(), register: () => () => undefined },
    sessions: { scope: () => fakeScope },
    conversation: { input: { for: () => ({ state: { getSnapshot: () => ({ draft: 'hello ', draftRev: 7 }) }, focus: () => {} }) } },
  }
  api.apply(fakeCtx)
  const result = api.__internals.insertReference('session-1', '@library/Q3 review.pdf')
  assert.equal(result.ok, true)
  assert.equal(emitted.length, 1)
  assert.equal(emitted[0].name, 'slash/input-insert-text')
  assert.equal(emitted[0].request.text, '@library/Q3 review.pdf ')
  assert.deepEqual(emitted[0].request.span, { start: 6, end: 6, draftRev: 7 })
})

test('a failing composer insertion is reported instead of pretending success', async () => {
  const api = await loadClient()
  const fakeCtx = {
    effect: fn => fn(),
    sidebarRightTabs: { register: () => () => undefined },
    slots: { inject: (_name, fn) => fn(), register: () => () => undefined },
    sessions: { scope: () => ({ bail: () => false }) },
    conversation: { input: { for: () => ({ state: { getSnapshot: () => ({ draft: '', draftRev: 1 }) } }) } },
  }
  api.apply(fakeCtx)
  const result = api.__internals.insertReference('session-1', '@library/x.pdf')
  assert.equal(result.ok, false)
  assert.match(result.error, /rejected/)
})

test('the stylesheet is responsive at 768px and has no fixed-width or remote asset assumption', async () => {
  const api = await loadClient()
  const css = api.__internals.CSS
  assert.match(css, /@media \(max-width:768px\)/)
  assert.match(css, /@container \(max-width:520px\)/)
  assert.match(css, /min-width:0/)
  assert.match(css, /height:100%/)
  assert.doesNotMatch(css, /[{;\s]width:\s*768px/)
  assert.doesNotMatch(css, /https?:\/\//)
  assert.doesNotMatch(css, /position:\s*fixed/)
  assert.match(css, /prefers-reduced-motion/)
})

test('a prefixed deployment builds same-origin URLs under the prefix', async () => {
  const api = await loadClient()
  const previous = globalThis.document
  globalThis.document = { baseURI: 'https://example.test/dsh/' }
  try {
    assert.equal(api.__internals.apiUrl('index'), '/dsh/plugins/dsh-file-library/index')
    assert.equal(api.__internals.appRoot(), '/dsh/')
  } finally {
    if (previous === undefined) delete globalThis.document
    else globalThis.document = previous
  }
})

test('the header defaults to this workspace and offers the all-files switch', async () => {
  const api = await loadClient()
  const model = api.__internals.buildModel({ entries: [entry({})], totalAll: 5, width: 900, now: NOW })
  assert.equal(model.scope, 'workspace')
  assert.equal(model.totalAll, 5)
  const html = serialize(api.__internals.buildView(model))
  assert.match(html, /data-dfl-scope="workspace"/)
  assert.match(html, /data-dfl-scope="all"/)
  assert.match(html, /class="dfl-scope-btn is-active" aria-pressed data-dfl-scope="workspace">This workspace/)
  assert.match(html, /class="dfl-scope-btn" data-dfl-scope="all">All files/)
  assert.match(html, /1 of 5 files/)
  assert.match(html, /data-dfl-total-all="5"/)

  const wide = api.__internals.buildModel({ entries: [entry({})], totalAll: 5, scope: 'all', width: 900, now: NOW })
  assert.equal(wide.scope, 'all')
  const allHtml = serialize(api.__internals.buildView(wide))
  assert.match(allHtml, /class="dfl-scope-btn" data-dfl-scope="workspace">This workspace/)
  assert.match(allHtml, /class="dfl-scope-btn is-active" aria-pressed data-dfl-scope="all">All files/)
})

test('an empty workspace view offers the all-files escape hatch', async () => {
  const api = await loadClient()
  const model = api.__internals.buildModel({ entries: [], totalAll: 4, width: 700, now: NOW })
  const html = serialize(api.__internals.buildView(model))
  assert.match(html, /data-dfl-empty-state="workspace-empty"/)
  assert.match(html, /No files in this workspace yet/)
  assert.match(html, /data-dfl-switch-scope="all"/)
  assert.match(html, /Show all files/)
  assert.match(html, /holds 4 files sent in other chats/)

  const trulyEmpty = api.__internals.buildModel({ entries: [], totalAll: 0, width: 700, now: NOW })
  assert.match(serialize(api.__internals.buildView(trulyEmpty)), /data-dfl-empty-state="library-empty"/)
})

test('a scope fallback is surfaced instead of silently listing every file', async () => {
  const api = await loadClient()
  const model = api.__internals.buildModel({
    entries: [entry({})], scope: 'all', scopeFallback: 'unknown-session', totalAll: 9, width: 800, now: NOW,
  })
  const html = serialize(api.__internals.buildView(model))
  assert.match(html, /data-dfl-scope-fallback="unknown-session"/)
  assert.match(html, /Showing all files instead — this session has no resolvable workspace\./)
  assert.equal(api.__internals.scopeFallbackText('http-404'), 'Showing all files instead — the host did not return a scoped list.')
})

test('the scope is sent as a name and remembered per chat', async () => {
  const api = await loadClient()
  assert.equal(api.__internals.SCOPE_STORAGE_KEY, 'dsh-file-library:scope')
  assert.equal(api.__internals.scopeStorageKey('session-1'), 'dsh-file-library:scope:session-1')
  assert.equal(api.__internals.indexQuery('session-1', 'workspace'), 'index?sessionId=session-1&scope=workspace&limit=2000')
  assert.equal(api.__internals.indexQuery('a b', 'all'), 'index?sessionId=a%20b&scope=all&limit=2000')
  assert.equal(api.__internals.indexQuery('session-1', null), 'index?sessionId=session-1&scope=workspace&limit=2000')

  assert.equal(api.__internals.readScopePreference('session-1'), 'workspace')
  const map = new Map()
  const store = {
    getItem(key) { return map.get(key) ?? null },
    setItem(key, value) { map.set(key, value) },
    removeItem(key) { map.delete(key) },
  }
  assert.equal(api.__internals.saveScopePreference('session-1', 'all', store), 'all')
  assert.equal(api.__internals.readScopePreference('session-1', store), 'all')
  // A choice in one chat must not widen another chat.
  assert.equal(api.__internals.readScopePreference('session-2', store), 'workspace')
  assert.equal(api.__internals.saveScopePreference('session-1', 'workspace', store), 'workspace')
  assert.equal(api.__internals.readScopePreference('session-1', store), 'workspace')

  // The pre-0.2.3 global key leaked "all" into every chat; it is dropped, not inherited.
  const legacy = {
    map: new Map([['dsh-file-library:scope', 'all']]),
    getItem(key) { return this.map.get(key) ?? null },
    setItem(key, value) { this.map.set(key, value) },
    removeItem(key) { this.map.delete(key) },
  }
  assert.equal(api.__internals.readScopePreference('session-9', legacy), 'workspace')
  assert.equal(legacy.map.has('dsh-file-library:scope'), false)

  const denied = {
    getItem() { throw new Error('denied') },
    setItem() { throw new Error('denied') },
    removeItem() { throw new Error('denied') },
  }
  assert.equal(api.__internals.readScopePreference('session-1', denied), 'workspace')
  assert.equal(api.__internals.saveScopePreference('session-1', 'all', denied), 'all')
})

 test('the import form takes an absolute path and marks an imported row', async () => {
  const api = await loadClient()
  const model = api.__internals.buildModel({
    entries: [entry({ imported: true })], importOpen: true, importPath: 'C:\\Users\\me\\a.pdf', width: 900, now: NOW,
  })
  const html = serialize(api.__internals.buildView(model))
  assert.match(html, /data-dfl-import-form="1"/)
  assert.match(html, /data-dfl-import-path="1"/)
  assert.match(html, /C:\\Users\\me\\a\.pdf/)
  assert.match(html, /data-dfl-imported="1"/)
  const closed = api.__internals.buildModel({ entries: [], width: 900, now: NOW })
  assert.doesNotMatch(serialize(api.__internals.buildView(closed)), /data-dfl-import-form/)
})

test('the all-files view labels rows from other workspaces', async () => {
  const api = await loadClient()
  const own = entry({ sha256: 'b'.repeat(64), state: 'in-workspace', inWorkspace: true })
  const foreign = entry({ sha256: 'c'.repeat(64), state: 'global', inWorkspace: false })
  const model = api.__internals.buildModel({
    entries: [own, foreign], scope: 'all', totalAll: 9, width: 900, now: NOW,
  })
  assert.equal(model.foreignCount, 1)
  const html = serialize(api.__internals.buildView(model))
  assert.match(html, /1 from other workspaces/)
  assert.match(html, /data-dfl-foreign="1"/)
  assert.match(html, /Other workspace/)
})

 test('a type chip with no rows explains that only sent files are indexed', async () => {
  const api = await loadClient()
  const model = api.__internals.buildModel({ entries: [], totalAll: 4, kind: 'pdf', width: 800, now: NOW })
  const html = serialize(api.__internals.buildView(model))
  assert.match(html, /data-dfl-empty-state="kind-empty"/)
  assert.match(html, /No PDF files in this view/)
  assert.match(html, /not stored as an attachment/)
})
test('the Open action points at /object/<sha> and never files anything', async () => {
  const api = await loadClient()
  const sha = 'd'.repeat(64)
  assert.equal(api.__internals.objectUrl(sha), `/plugins/dsh-file-library/object/${sha}`)
  const pdf = entry({ sha256: sha })
  const html = serialize(api.__internals.buildView(api.__internals.buildModel({
    entries: [pdf], width: 900, now: NOW,
  })))
  assert.match(html, new RegExp(`data-dfl-open="${sha}"`))
  assert.match(html, />Preview</)
  assert.match(html, /“Open” streams the original from the attachment store/)
  const doc = serialize(api.__internals.buildView(api.__internals.buildModel({
    entries: [entry({ sha256: 'e'.repeat(64), name: 'notes.docx', kind: 'doc', ext: 'docx' })], width: 900, now: NOW,
  })))
  assert.match(doc, />Open</)
})

test('a missing row is marked and its Open and Use actions are disabled', async () => {
  const api = await loadClient()
  const gone = entry({ sha256: 'f'.repeat(64), state: 'missing' })
  const html = serialize(api.__internals.buildView(api.__internals.buildModel({
    entries: [gone], width: 900, now: NOW,
  })))
  assert.match(html, /data-dfl-state="missing"/)
  assert.match(html, /data-dfl-missing="1"/)
  assert.match(html, /Missing · bytes are gone/)
  assert.match(html, /data-dfl-open="ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"[^>]*disabled/)
})

test('a truncated scan shows the coverage banner, with counts when known', async () => {
  const api = await loadClient()
  assert.equal(
    api.__internals.coverageText({ truncated: true, sessionsSeen: 70, sessionsFound: 120 }),
    'The index covers 70 of 120 sessions.',
  )
  assert.equal(
    api.__internals.coverageText({ truncated: true }),
    'Some sessions were not indexed because of scan limits.',
  )
  const html = serialize(api.__internals.buildView(api.__internals.buildModel({
    entries: [entry({})], width: 900, now: NOW,
    coverage: { truncated: true, sessionsSeen: 70, sessionsFound: 120 },
  })))
  assert.match(html, /data-dfl-coverage="truncated"/)
  assert.match(html, /The index covers 70 of 120 sessions\./)

  const quiet = serialize(api.__internals.buildView(api.__internals.buildModel({
    entries: [entry({})], width: 900, now: NOW,
    coverage: { truncated: false, sessionsSeen: 120, sessionsFound: 120 },
  })))
  assert.doesNotMatch(quiet, /data-dfl-coverage/)
})
