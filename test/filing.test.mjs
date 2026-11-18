import assert from 'node:assert/strict'
import { mkdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { createFiler, readManifest } from '../lib/filing.js'
import { createLibrary } from '../lib/library.js'
import { DEFAULT_LIMITS } from '../lib/indexer.js'
import { sha256Bytes } from '../lib/util.js'
import { cleanup, makeHome, writeObject, writeSession } from './helpers.mjs'

async function context() {
  const home = await makeHome()
  const workspace = join(home, 'workspace')
  await mkdir(workspace, { recursive: true })
  const pdf = await writeObject(home, Buffer.from('%PDF-1.7 file this fixture'))
  await writeSession(home, {
    sessionId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    cwd: workspace,
    title: 'Contract review',
    messages: [{ name: 'contract.pdf', mime: 'application/pdf', bytes: pdf.bytes, sha: pdf.sha }],
  })
  const library = createLibrary({ home, cacheDir: join(home, 'cache') })
  await library.init({ background: false })
  const filer = createFiler({ home, limits: DEFAULT_LIMITS })
  return { home, workspace, pdf, library, filer }
}

test('file this copies the object, writes the manifest, and regenerates INDEX.md', async () => {
  const { home, workspace, pdf, library, filer } = await context()
  try {
    const entry = library.get(pdf.sha)
    const result = await filer.fileThis({ entry, workspace, tags: ['legal', '2026'] })
    assert.equal(result.deduped, false)
    assert.equal(result.relativePath, 'library/contract.pdf')
    assert.equal(result.reference, '@library/contract.pdf')

    const copied = await readFile(result.path)
    assert.equal(sha256Bytes(copied), pdf.sha)
    assert.equal((await stat(result.path)).size, pdf.bytes)

    const manifest = await readManifest(workspace)
    assert.equal(manifest.files.length, 1)
    const row = manifest.files[0]
    assert.equal(row.sha, pdf.sha)
    assert.equal(row.name, 'contract.pdf')
    assert.equal(row.mime, 'application/pdf')
    assert.deepEqual(row.tags, ['legal', '2026'])
    assert.equal(row.source.sessionId, 'dddddddd-dddd-4ddd-8ddd-dddddddddddd')
    assert.equal(row.source.title, 'Contract review')
    assert.equal(row.bytes, pdf.bytes)
    assert.match(row.addedAt, /^\d{4}-\d{2}-\d{2}T/)

    const index = await readFile(join(workspace, 'library', 'INDEX.md'), 'utf8')
    assert.match(index, /^# File library/m)
    assert.match(index, /contract\.pdf/)
    assert.match(index, new RegExp(pdf.sha.slice(0, 12)))
    assert.match(index, /legal, 2026/)
  } finally {
    await cleanup(home)
  }
})

test('file this is idempotent by SHA: a second call changes neither file nor manifest nor INDEX', async () => {
  const { home, workspace, pdf, library, filer } = await context()
  try {
    const entry = library.get(pdf.sha)
    const first = await filer.fileThis({ entry, workspace, tags: ['legal'] })
    const indexBefore = await readFile(join(workspace, 'library', 'INDEX.md'), 'utf8')
    const manifestBefore = await readFile(join(workspace, 'library', '.manifest.json'), 'utf8')
    const firstStat = await stat(first.path)

    const second = await filer.fileThis({ entry, workspace, tags: ['legal'] })
    assert.equal(second.deduped, true)
    assert.equal(second.name, first.name)
    assert.equal((await stat(second.path)).mtimeMs, firstStat.mtimeMs)
    assert.equal(await readFile(join(workspace, 'library', 'INDEX.md'), 'utf8'), indexBefore)
    assert.equal(await readFile(join(workspace, 'library', '.manifest.json'), 'utf8'), manifestBefore)
    assert.equal((await readManifest(workspace)).files.length, 1)
  } finally {
    await cleanup(home)
  }
})

test('two different files with the same name get a deterministic suffix', async () => {
  const { home, workspace, library, filer } = await context()
  try {
    const other = await writeObject(home, Buffer.from('%PDF-1.7 a different contract'))
    await writeSession(home, {
      sessionId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      cwd: workspace,
      title: 'Another chat',
      messages: [{ name: 'contract.pdf', mime: 'application/pdf', bytes: other.bytes, sha: other.sha }],
    })
    await library.rebuild()

    const first = await filer.fileThis({ entry: library.get(other.sha), workspace })
    const second = await filer.fileThis({ entry: library.get(other.sha), workspace, tags: ['dup'] })
    // The second call is the same SHA, so it is the same file.
    assert.equal(second.deduped, true)
    assert.equal(first.name, 'contract.pdf')

    const third = await writeObject(home, Buffer.from('%PDF-1.7 third'))
    await writeSession(home, {
      sessionId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
      cwd: workspace,
      title: 'Third chat',
      messages: [{ name: 'contract.pdf', mime: 'application/pdf', bytes: third.bytes, sha: third.sha }],
    })
    await library.rebuild()
    const collided = await filer.fileThis({ entry: library.get(third.sha), workspace })
    assert.equal(collided.name, 'contract (2).pdf')
    assert.equal((await readManifest(workspace)).files.length, 2)
  } finally {
    await cleanup(home)
  }
})

test('a crafted traversal name is rejected and writes nothing', async () => {
  const { home, workspace, pdf, library, filer } = await context()
  try {
    const entry = { ...library.get(pdf.sha), name: '../../evil.pdf' }
    await assert.rejects(() => filer.fileThis({ entry, workspace }), /path separator/)
    await assert.rejects(() => filer.fileThis({ entry: { ...library.get(pdf.sha), name: '..\\evil.pdf' }, workspace }), /path separator/)
    await assert.rejects(() => filer.fileThis({ entry: { ...library.get(pdf.sha), name: '.manifest.json' }, workspace }), /reserved/)
    await assert.rejects(() => filer.fileThis({ entry: { ...library.get(pdf.sha), name: 'C:evil.pdf' }, workspace }), /path separator/)

    await assert.rejects(() => stat(join(home, 'evil.pdf')))
    await assert.rejects(() => stat(join(workspace, 'evil.pdf')))
    const manifest = await readManifest(workspace)
    assert.equal(manifest.files.length, 0, 'a rejected name must not add a manifest row')
  } finally {
    await cleanup(home)
  }
})

test('concurrent filing of one SHA publishes exactly one file and one manifest row', async () => {
  const { home, workspace, pdf, library, filer } = await context()
  try {
    const entry = library.get(pdf.sha)
    const results = await Promise.all(Array.from({ length: 5 }, () => filer.fileThis({ entry, workspace })))
    assert.equal(results.filter(result => result.deduped === false).length, 1)
    assert.equal((await readManifest(workspace)).files.length, 1)
    const index = await readFile(join(workspace, 'library', 'INDEX.md'), 'utf8')
    assert.equal(index.match(/\[contract\.pdf\]/g).length, 1)
  } finally {
    await cleanup(home)
  }
})
