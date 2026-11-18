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

test('the reference is exactly the @library/<name> grammar and reads back from the workspace', async () => {
  const api = await loadClient()
  const reference = api.__internals.buildReference({ name: 'Q3 review.pdf' })
  assert.equal(reference, '@library/Q3 review.pdf')
  assert.match(reference, /^@library\/[^/]+$/)

  const home = await makeHome()
  try {
    await mkdir(join(home, 'workspace', 'library'), { recursive: true })
    const relative = reference.slice(1)
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
