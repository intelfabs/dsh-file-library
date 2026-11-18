import assert from 'node:assert/strict'
import { mkdir, readFile, stat } from 'node:fs/promises'
import { join, sep } from 'node:path'
import test from 'node:test'
import { createLibrary, publicCoverage, resolveState } from '../lib/library.js'
import { readSessionLog } from '../lib/indexer.js'
import { decodeZstdLog } from '../lib/zstd-log.js'
import { addWorkspace, workspaceKey } from '../lib/util.js'
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
    assert.equal(cache.version, 3)
    assert.equal(cache.entries.find(row => row.sha256 === report.sha).workspaces.length, 1)
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

async function twoWorkspaceFixture() {
  const home = await makeHome()
  const workspaceA = join(home, 'workspace-a')
  const workspaceB = join(home, 'workspace-b')
  await mkdir(workspaceA, { recursive: true })
  await mkdir(workspaceB, { recursive: true })
  const aOnly = await writeObject(home, Buffer.from('a only bytes'))
  const shared = await writeObject(home, Buffer.from('shared bytes'))
  const bOnly = await writeObject(home, Buffer.from('b only bytes'))
  await writeSession(home, {
    workspaceDir: '--a--', sessionId: 'sess-a', cwd: workspaceA, title: 'Chat A', createdAt: 1_700_000_000_000,
    messages: [
      { name: 'a-only.pdf', mime: 'application/pdf', bytes: aOnly.bytes, sha: aOnly.sha },
      { name: 'shared.pdf', mime: 'application/pdf', bytes: shared.bytes, sha: shared.sha },
    ],
  })
  await writeSession(home, {
    workspaceDir: '--b--', sessionId: 'sess-b', cwd: workspaceB, title: 'Chat B', createdAt: 1_700_100_000_000,
    messages: [
      { name: 'shared.pdf', mime: 'application/pdf', bytes: shared.bytes, sha: shared.sha },
      { name: 'b-only.pdf', mime: 'application/pdf', bytes: bOnly.bytes, sha: bOnly.sha },
    ],
  })
  return { home, workspaceA, workspaceB, aOnly, shared, bOnly }
}

test('a workspace scope sees only the files its sessions sent, while all files sees every row', async () => {
  const { home, workspaceA, workspaceB, aOnly, shared } = await twoWorkspaceFixture()
  try {
    const library = createLibrary({ home, cacheDir: join(home, 'cache') })
    await library.init({ background: false })
    const names = rows => rows.map(row => row.name).sort()
    assert.deepEqual(names(library.query({ workspace: workspaceA, onlyWorkspace: true }).entries), ['a-only.pdf', 'shared.pdf'])
    assert.deepEqual(names(library.query({ workspace: workspaceB, onlyWorkspace: true }).entries), ['b-only.pdf', 'shared.pdf'])
    assert.deepEqual(names(library.query({}).entries), ['a-only.pdf', 'b-only.pdf', 'shared.pdf'])

    // A trailing separator names the same directory.
    assert.equal(library.query({ workspace: workspaceA + sep, onlyWorkspace: true }).total, 2)

    // The merged row remembers every sender, while the public row stays
    // path-free and only carries a boolean.
    const row = library.query({ workspace: workspaceA, onlyWorkspace: true }).entries
      .find(entry => entry.sha256 === shared.sha)
    assert.equal(row.inWorkspace, true)
    assert.equal(Object.hasOwn(row, 'workspace'), false)
    assert.equal(Object.hasOwn(row, 'workspaces'), false)
    assert.equal(JSON.stringify(row).includes(workspaceA), false)
    assert.deepEqual(library.get(shared.sha).workspaces.slice().sort(), [workspaceA, workspaceB].sort())
    assert.equal(library.get(aOnly.sha).workspaces.length, 1)

    // A file sent only from A is absent from B.
    assert.equal(library.query({ workspace: workspaceB, onlyWorkspace: true }).entries
      .some(entry => entry.sha256 === aOnly.sha), false)
  } finally {
    await cleanup(home)
  }
})

test('a warm cache and a cold build scope to exactly the same rows', async () => {
  const { home, workspaceA, workspaceB } = await twoWorkspaceFixture()
  try {
    const scoped = library => ({
      a: library.query({ workspace: workspaceA, onlyWorkspace: true }).entries.map(row => row.sha256).sort(),
      b: library.query({ workspace: workspaceB, onlyWorkspace: true }).entries.map(row => row.sha256).sort(),
      all: library.query({}).entries.map(row => row.sha256).sort(),
    })
    const cold = createLibrary({ home, cacheDir: join(home, 'cache') })
    await cold.init({ background: false })
    const before = scoped(cold)
    assert.equal(before.a.length, 2)
    assert.equal(before.b.length, 2)
    assert.equal(before.all.length, 3)

    const warm = createLibrary({ home, cacheDir: join(home, 'cache') })
    const warmStatus = await warm.init({ background: false })
    assert.equal(warmStatus.source, 'cache')
    assert.deepEqual(scoped(warm), before)
  } finally {
    await cleanup(home)
  }
})

test('workspace comparison folds Windows case and trailing separators', () => {
  const bs = String.fromCharCode(92)
  const winDir = ['C:', 'Users', 'Test', 'Workspace-A'].join(bs)
  assert.equal(workspaceKey(winDir + bs, 'win32'), workspaceKey('c:/users/test/workspace-a', 'win32'))
  assert.equal(workspaceKey('/home/Foo', 'linux') === workspaceKey('/home/foo', 'linux'), false)

  const other = ['C:', 'Work', 'A'].join(bs)
  assert.deepEqual(addWorkspace([], other, 'win32'), [other])
  assert.deepEqual(addWorkspace([other], 'c:/work/a/', 'win32'), [other])
  assert.deepEqual(addWorkspace([other], ['C:', 'Work', 'B'].join(bs), 'win32'), [other, ['C:', 'Work', 'B'].join(bs)])
  assert.deepEqual(addWorkspace([other], undefined, 'win32'), [other])
  assert.deepEqual(addWorkspace(undefined, '/one', 'linux'), ['/one'])
})
test('scan coverage survives a warm start from the cache', async () => {
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
    const cold = createLibrary({ home, cacheDir: join(home, 'cache'), limits: { maxSessions: 1 } })
    const coldStatus = await cold.init({ background: false })
    assert.equal(coldStatus.stats.truncated, true)
    assert.equal(coldStatus.stats.sessionsFound, 2)
    assert.equal(coldStatus.stats.sessionsSkipped, 1)
    assert.equal(coldStatus.stats.sessionsSeen, 1)

    const warm = createLibrary({ home, cacheDir: join(home, 'cache') })
    const warmStatus = await warm.init({ background: false })
    assert.equal(warmStatus.source, 'cache')
    // The cache carries the coverage, so a restart still reports truncation.
    assert.equal(warm.status().stats.truncated, true)
    assert.equal(warm.status().stats.sessionsFound, 2)
    const coverage = publicCoverage(warm.status().stats)
    assert.equal(coverage.truncated, true)
    assert.equal(coverage.sessionsSkipped, 1)
    assert.equal(coverage.sessionsFound, 2)
    assert.equal(coverage.sessionsSeen, 1)
  } finally {
    await cleanup(home)
  }
})

test('public rows carry one state value and keep inWorkspace for compatibility', async () => {
  const { home, workspaceA, bOnly, aOnly } = await twoWorkspaceFixture()
  try {
    const library = createLibrary({ home, cacheDir: join(home, 'cache') })
    await library.init({ background: false })
    const scoped = library.query({ workspace: workspaceA, onlyWorkspace: true }).entries
    assert.equal(scoped.find(row => row.sha256 === aOnly.sha).state, 'in-workspace')
    assert.equal(scoped.find(row => row.sha256 === aOnly.sha).inWorkspace, true)

    const all = library.query({ workspace: workspaceA }).entries
    assert.equal(all.find(row => row.sha256 === bOnly.sha).state, 'global')

    const entry = library.get(aOnly.sha)
    entry.available = false
    try {
      const missing = library.query({ workspace: workspaceA }).entries
      assert.equal(missing.find(row => row.sha256 === aOnly.sha).state, 'missing')
      assert.equal(resolveState(entry, { filed: true, inWorkspace: true }), 'missing')
    } finally {
      entry.available = true
    }
    assert.equal(resolveState({ available: true }, { filed: true, inWorkspace: true }), 'filed-here')
    assert.equal(resolveState({ available: true }, { inWorkspace: true }), 'in-workspace')
    assert.equal(resolveState({ available: true }, {}), 'global')
  } finally {
    await cleanup(home)
  }
})
test('an agent tool-loop user message is not indexed, only what the user sent', async () => {
  const home = await makeHome()
  try {
    const sent = await writeObject(home, Buffer.from('user screenshot bytes'))
    const rendered = await writeObject(home, Buffer.from('tool page render bytes'))
    const sessionId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
    await writeSession(home, {
      workspaceDir: '--d--', sessionId, cwd: join(home, 'ws'), title: 'PDF reading',
      messages: [{ name: 'screenshot.png', mime: 'image/png', bytes: sent.bytes, sha: sent.sha }],
      extraFrames: [{
        // DSH records an agent tool loop as a user-role message with a source
        // kind that is not "user" (current logs put it on `data.source`);
        // a read_image result must stay out of the library.
        type: 'user/message',
        seq: 50,
        time: 1_700_000_900_000,
        data: {
          source: { kind: 'ptc-mode' },
          role: 'user',
          content: [{
            type: 'image',
            attachment: {
              attachmentId: `sha256:${rendered.sha}`,
              mediaType: 'image/png',
              bytes: rendered.bytes,
              name: 'report.pdf-p4-66x73.png',
            },
          }],
        },
      }, {
        // The older nested shape is refused the same way.
        type: 'user/message',
        seq: 51,
        time: 1_700_000_910_000,
        data: {
          message: {
            role: 'user',
            source: { kind: 'runtime-context' },
            content: [{
              type: 'image',
              attachment: { attachmentId: `sha256:${rendered.sha}`, mediaType: 'image/png', bytes: rendered.bytes },
            }],
          },
        },
      }],
    })
    const library = createLibrary({ home, cacheDir: join(home, 'cache') })
    const status = await library.init({ background: false })
    const rows = library.query({}).entries
    assert.equal(status.count, 1)
    assert.equal(rows.length, 1)
    assert.equal(rows[0].sha256, sent.sha)
    assert.equal(rows.some(row => row.sha256 === rendered.sha), false, 'a tool-generated image must not be listed')
    assert.equal(status.stats.attachmentRecords, 1)
  } finally {
    await cleanup(home)
  }
})
