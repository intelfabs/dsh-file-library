import assert from 'node:assert/strict'
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { createLibrary } from '../lib/library.js'
import { readSessionLog } from '../lib/indexer.js'
import { decodeZstdLog } from '../lib/zstd-log.js'
import { cleanup, makeHome, writeObject, writeSession } from './helpers.mjs'

async function fixture() {
  const home = await makeHome()
  const report = await writeObject(home, Buffer.from('%PDF-1.7 synthetic report bytes'))
  const image = await writeObject(home, Buffer.from('89504e470d0a1a0a synthetic png'))
  await writeSession(home, {
    sessionId: '11111111-1111-4111-8111-111111111111',
    cwd: join(home, 'workspace-a'),
    title: 'Quarterly reports',
    createdAt: 1_700_000_000_000,
    messages: [
      { name: 'Q3 review.pdf', mime: 'application/pdf', bytes: report.bytes, sha: report.sha, time: 1_700_000_100_000 },
      { name: 'image.png', mime: 'image/png', bytes: image.bytes, sha: image.sha, time: 1_700_000_200_000 },
    ],
  })
  return { home, report, image }
}

test('a multi-frame log decodes every frame and finds both attachments', async () => {
  const { home, report, image } = await fixture()
  try {
    const log = join(home, 'sessions', '--test-workspace--', '11111111-1111-4111-8111-111111111111', 'session.v4.jsonl.zstd')
    const buffer = await readFile(log)

    const decoded = decodeZstdLog(buffer)
    assert.equal(decoded.error, undefined)
    assert.equal(decoded.frames, 6, 'header + title + two messages + two turn starts')
    assert.match(decoded.text, /Q3 review\.pdf/)
    assert.match(decoded.text, /image\.png/)

    const record = readSessionLog(buffer, { maxObjects: 100, maxFramesPerLog: 1000 })
    assert.equal(record.header.id, '11111111-1111-4111-8111-111111111111')
    assert.equal(record.title, 'Quarterly reports')
    assert.equal(record.attachments.length, 2)
    assert.deepEqual(record.attachments.map(item => item.sha256).sort(), [report.sha, image.sha].sort())
  } finally {
    await cleanup(home)
  }
})

test('cold index builds and caches; warm start reuses the cache without decoding logs', async () => {
  const { home, report, image } = await fixture()
  try {
    const cold = createLibrary({ home, cacheDir: join(home, 'cache') })
    const coldStatus = await cold.init({ background: false })
    assert.equal(coldStatus.state, 'ready')
    assert.equal(coldStatus.count, 2)
    assert.equal(coldStatus.source, 'scan')
    assert.equal(coldStatus.stats.logsDecoded, 1)

    const entries = cold.query({}).entries
    const pdf = entries.find(entry => entry.sha256 === report.sha)
    const png = entries.find(entry => entry.sha256 === image.sha)
    assert.equal(pdf.name, 'Q3 review.pdf')
    assert.equal(pdf.kind, 'pdf')
    assert.equal(pdf.sessionTitle, 'Quarterly reports')
    assert.equal(png.kind, 'image')

    const cacheFile = join(home, 'cache', 'index.v1.json')
    const cacheStat = await stat(cacheFile)
    assert.ok(cacheStat.size > 0)
    const cache = JSON.parse(await readFile(cacheFile, 'utf8'))
    assert.equal(cache.version, 1)
    assert.equal(Object.keys(cache.sessions).length, 1)

    const warm = createLibrary({ home, cacheDir: join(home, 'cache') })
    const warmStatus = await warm.init({ background: false })
    assert.equal(warmStatus.source, 'cache')
    assert.equal(warmStatus.count, 2)
    assert.equal(warm.status().stats.cached, true)
    assert.equal(warm.query({ q: 'Q3 review' }).entries.length, 1)
    assert.equal(warm.query({ kind: 'image' }).entries.length, 1)
  } finally {
    await cleanup(home)
  }
})

test('the same digest sent twice is one row with two occurrences, and a specific name wins over image.png', async () => {
  const home = await makeHome()
  try {
    const image = await writeObject(home, Buffer.from('same image bytes'))
    await writeSession(home, {
      sessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      cwd: join(home, 'ws1'), title: 'First chat', createdAt: 1_700_000_000_000,
      messages: [{ name: 'image.png', mime: 'image/png', bytes: image.bytes, sha: image.sha }],
    })
    await writeSession(home, {
      sessionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      cwd: join(home, 'ws2'), title: 'Chart chat', createdAt: 1_700_100_000_000,
      messages: [{ name: 'revenue chart.png', mime: 'image/png', bytes: image.bytes, sha: image.sha }],
    })
    const library = createLibrary({ home, cacheDir: join(home, 'cache') })
    await library.init({ background: false })
    const rows = library.query({}).entries
    assert.equal(rows.length, 1)
    assert.equal(rows[0].occurrences, 2)
    assert.equal(rows[0].name, 'revenue chart.png')
    assert.equal(rows[0].sessionTitle, 'Chart chat')
  } finally {
    await cleanup(home)
  }
})

test('a log referencing a missing object is reported, not listed as broken', async () => {
  const home = await makeHome()
  try {
    const missing = 'f'.repeat(64)
    await writeSession(home, {
      sessionId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      cwd: join(home, 'ws'), title: 'Missing bytes',
      messages: [{ name: 'gone.pdf', mime: 'application/pdf', bytes: 10, sha: missing }],
    })
    const library = createLibrary({ home, cacheDir: join(home, 'cache') })
    const status = await library.init({ background: false })
    assert.equal(status.count, 0)
    assert.equal(status.stats.missingObjects, 1)
  } finally {
    await cleanup(home)
  }
})

test('the session scan respects its file cap', async () => {
  const home = await makeHome()
  try {
    const one = await writeObject(home, Buffer.from('one'))
    const two = await writeObject(home, Buffer.from('two'))
    await writeSession(home, {
      workspaceDir: '--a--', sessionId: 's-one', cwd: join(home, 'a'), title: 'One',
      messages: [{ name: 'one.txt', mime: 'text/plain', bytes: one.bytes, sha: one.sha }],
    })
    await writeSession(home, {
      workspaceDir: '--b--', sessionId: 's-two', cwd: join(home, 'b'), title: 'Two',
      messages: [{ name: 'two.txt', mime: 'text/plain', bytes: two.bytes, sha: two.sha }],
    })
    const library = createLibrary({ home, cacheDir: join(home, 'cache'), limits: { maxSessions: 1 } })
    const status = await library.init({ background: false })
    assert.equal(status.stats.sessionsSeen, 1)
    assert.equal(status.count, 1)
  } finally {
    await cleanup(home)
  }
})
