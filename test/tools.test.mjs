import assert from 'node:assert/strict'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { createFiler } from '../lib/filing.js'
import { createLibrary } from '../lib/library.js'
import { createToolDefinitions, findEntry } from '../lib/tools.js'
import { createWorkspaceResolver } from '../lib/sessions.js'
import { DEFAULT_LIMITS } from '../lib/indexer.js'
import { cleanup, makeHome, writeObject, writeSession } from './helpers.mjs'

const SESSION = '11111111-1111-4111-8111-111111111111'
const OTHER_SESSION = '22222222-2222-4222-8222-222222222222'

const TEXT_BODY = 'row one,row two\n'.repeat(40)

async function setup() {
  const home = await makeHome()
  const workspace = join(home, 'workspace')
  await mkdir(workspace, { recursive: true })
  const text = await writeObject(home, Buffer.from(TEXT_BODY))
  const pdf = await writeObject(home, Buffer.from('%PDF-1.7 binary fixture'))
  const png = await writeObject(home, Buffer.from('89504e470d0a1a0a png fixture'))
  // Two different files with the same exact name: a real ambiguity.
  const duplicateA = await writeObject(home, Buffer.from('first report body'))
  const duplicateB = await writeObject(home, Buffer.from('second report body'))
  await writeSession(home, {
    sessionId: SESSION,
    cwd: workspace,
    title: 'Data drop',
    messages: [
      { name: 'data.csv', mime: 'text/csv', bytes: text.bytes, sha: text.sha },
      { name: 'brief.pdf', mime: 'application/pdf', bytes: pdf.bytes, sha: pdf.sha },
      { name: 'chart.png', mime: 'image/png', bytes: png.bytes, sha: png.sha },
      { name: 'report.txt', mime: 'text/plain', bytes: duplicateA.bytes, sha: duplicateA.sha },
    ],
  })
  await writeSession(home, {
    sessionId: OTHER_SESSION,
    cwd: join(home, 'elsewhere'),
    title: 'Other workspace',
    messages: [
      { name: 'report.txt', mime: 'text/plain', bytes: duplicateB.bytes, sha: duplicateB.sha },
    ],
  })
  const library = createLibrary({ home, cacheDir: join(home, 'cache') })
  await library.init({ background: false })
  const filer = createFiler({ home, limits: DEFAULT_LIMITS })
  const resolveWorkspace = createWorkspaceResolver({ home, library })
  const definitions = createToolDefinitions({ library, filer, resolveWorkspace })
  const byName = Object.fromEntries(definitions.map(definition => [definition.name, definition]))
  const exec = {
    agent: { session: { id: SESSION, header: { cwd: workspace } } },
    signal: new AbortController().signal,
  }
  return { home, workspace, text, pdf, png, duplicateA, duplicateB, library, filer, exec, byName }
}

test('library_read returns text bytes without copying anything into the workspace', async () => {
  const ctx = await setup()
  try {
    const result = await ctx.byName.library_read.execute({ nameOrSha: 'data.csv' }, ctx.exec)
    assert.equal(result.text, TEXT_BODY)
    assert.equal(result.truncated, false)
    assert.equal(result.state, 'in-workspace')
    assert.equal(result.sha256, ctx.text.sha)
    assert.equal(result.bytesTotal, Buffer.byteLength(TEXT_BODY))
    // The tool never hands the agent an absolute path.
    const serialized = JSON.stringify(result)
    assert.equal(serialized.includes(ctx.home), false)
    assert.equal(serialized.includes(ctx.workspace), false)
    // Nothing was written to the workspace.
    await assert.rejects(() => import('node:fs/promises').then(fs => fs.stat(join(ctx.workspace, 'library'))))
  } finally {
    await cleanup(ctx.home)
  }
})

test('library_read caps text and reports truncation with the total size', async () => {
  const ctx = await setup()
  try {
    const result = await ctx.byName.library_read.execute({ nameOrSha: 'data.csv', maxBytes: 20 }, ctx.exec)
    assert.equal(result.truncated, true)
    assert.equal(result.bytes, 20)
    assert.equal(result.bytesTotal, Buffer.byteLength(TEXT_BODY))
    assert.equal(result.text.length, 20)
    assert.match(result.hint, /read cap/)
  } finally {
    await cleanup(ctx.home)
  }
})

test('library_read returns metadata and a hint for binaries and images', async () => {
  const ctx = await setup()
  try {
    const pdf = await ctx.byName.library_read.execute({ nameOrSha: 'brief.pdf' }, ctx.exec)
    assert.equal(pdf.text, null)
    assert.equal(pdf.truncated, false)
    assert.equal(pdf.mediaType, 'application/pdf')
    assert.match(pdf.hint, /library_use/)

    const image = await ctx.byName.library_read.execute({ nameOrSha: 'chart.png' }, ctx.exec)
    assert.equal(image.text, null)
    assert.match(image.hint, /library_use|sidebar/)
  } finally {
    await cleanup(ctx.home)
  }
})

test('library_read reports missing bytes instead of inventing content', async () => {
  const ctx = await setup()
  try {
    const entry = ctx.library.get(ctx.text.sha)
    await rm(entry.objectPath, { force: true })
    const result = await ctx.byName.library_read.execute({ nameOrSha: ctx.text.sha }, ctx.exec)
    assert.equal(result.state, 'missing')
    assert.equal(result.text, undefined)
    assert.match(result.message, /missing/)
  } finally {
    await cleanup(ctx.home)
  }
})

test('duplicate exact names are ambiguous for both tools, with ranked candidates', async () => {
  const ctx = await setup()
  try {
    const resolved = findEntry(ctx.library, 'report.txt')
    assert.equal(resolved.entry, undefined, 'two exact-name matches must not silently pick one')
    assert.equal(resolved.ambiguity, 'exact-name')
    assert.equal(resolved.matches.length, 2)

    const read = await ctx.byName.library_read.execute({ nameOrSha: 'report.txt' }, ctx.exec)
    assert.equal(read.ambiguous, true)
    assert.equal(read.candidates.length, 2)
    for (const candidate of read.candidates) {
      assert.equal(candidate.sha8.length, 8)
      assert.equal(typeof candidate.sha256, 'string')
      assert.equal(typeof candidate.name, 'string')
      assert.equal(typeof candidate.bytes, 'number')
      assert.match(candidate.sentAt, /^\d{4}-\d{2}-\d{2}T/)
      assert.ok(['filed-here', 'in-workspace', 'global', 'missing'].includes(candidate.state))
    }
    assert.match(read.hint, /sha8/)

    const use = await ctx.byName.library_use.execute({ nameOrSha: 'report.txt' }, ctx.exec)
    assert.equal(use.ambiguous, true)
    assert.equal(use.candidates.length, 2)
  } finally {
    await cleanup(ctx.home)
  }
})

test('a sha8 from the candidate list resolves the ambiguity and reads the right file', async () => {
  const ctx = await setup()
  try {
    const candidates = (await ctx.byName.library_read.execute({ nameOrSha: 'report.txt' }, ctx.exec)).candidates
    const wanted = candidates.find(candidate => candidate.sha256 === ctx.duplicateB.sha)
    const result = await ctx.byName.library_read.execute({ nameOrSha: wanted.sha8 }, ctx.exec)
    assert.equal(result.sha256, ctx.duplicateB.sha)
    assert.equal(result.text, 'second report body')
    // The other workspace's file reads fine without being copied anywhere.
    assert.equal(result.state, 'global')
  } finally {
    await cleanup(ctx.home)
  }
})

test('an unknown name fails with a plain error, not an empty result', async () => {
  const ctx = await setup()
  try {
    await assert.rejects(
      () => ctx.byName.library_read.execute({ nameOrSha: 'nothing-like-this.pdf' }, ctx.exec),
      /no library file matches/,
    )
  } finally {
    await cleanup(ctx.home)
  }
})
