/**
 * Offline fixtures: a synthetic DSH home with real multi-frame Zstandard v4
 * session logs and content-addressed attachment objects. Every test builds its
 * own directory under the OS temp root and removes it afterwards.
 */
import { link, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { zstdCompressSync } from 'node:zlib'

export async function makeHome(prefix = 'dsh-file-library-test-') {
  const home = await mkdtemp(join(tmpdir(), prefix))
  await mkdir(join(home, 'sessions'), { recursive: true })
  await mkdir(join(home, 'attachments', 'v1', 'objects'), { recursive: true })
  return home
}

export async function cleanup(home) {
  await rm(home, { recursive: true, force: true })
}

/** Write one content-addressed object and return its digest. */
export async function writeObject(home, data) {
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data)
  const sha = createHash('sha256').update(buffer).digest('hex')
  const path = join(home, 'attachments', 'v1', 'objects', sha.slice(0, 2), sha)
  await mkdir(join(home, 'attachments', 'v1', 'objects', sha.slice(0, 2)), { recursive: true })
  await writeFile(path, buffer)
  return { sha, bytes: buffer.length, path }
}

/**
 * Write one generic-file object — PDFs, Office files, archives — exactly like
 * DSH's file store does: bytes in `file-objects/<prefix>/<sha>` and a read-only
 * named link in `files/<prefix>/<sha>/<name>`. Returns the object digests.
 */
export async function writeFileObject(home, data, name) {
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data)
  const sha = createHash('sha256').update(buffer).digest('hex')
  const prefix = sha.slice(0, 2)
  const objectDir = join(home, 'attachments', 'v1', 'file-objects', prefix)
  await mkdir(objectDir, { recursive: true })
  const path = join(objectDir, sha)
  await writeFile(path, buffer)
  const refDir = join(home, 'attachments', 'v1', 'files', prefix, sha)
  await mkdir(refDir, { recursive: true })
  const refPath = join(refDir, name)
  await link(path, refPath).catch(async () => {
    // A filesystem without hard links still gets the reference path.
    await writeFile(refPath, buffer)
  })
  return { sha, bytes: buffer.length, path, refPath }
}

/** Frame-per-line Zstandard container, exactly like the appender writes. */
export function encodeFrames(lines) {
  return Buffer.concat(lines.map(line => zstdCompressSync(Buffer.from(`${typeof line === 'string' ? line : JSON.stringify(line)}\n`))))
}

/**
 * Write one session.log with a header, a title and user messages carrying
 * attachments.
 * @param {string} home
 * @param {{workspaceDir?: string, sessionId: string, cwd: string, title?: string,
 *   messages: Array<{time?: number, name: string, mime: string, bytes: number, sha: string}>,
 *   extraFrames?: Array<string|object>, createdAt?: number}} session
 */
export async function writeSession(home, session) {
  const workspaceDir = session.workspaceDir ?? '--test-workspace--'
  const dir = join(home, 'sessions', workspaceDir, session.sessionId)
  await mkdir(dir, { recursive: true })
  const createdAt = session.createdAt ?? 1_700_000_000_000
  const frames = [
    {
      type: 'session', version: 4, id: session.sessionId, createdAt,
      cwd: session.cwd, isSeeded: false, origin: 'user', agentPreset: 'standard',
    },
  ]
  if (session.title !== undefined) {
    frames.push({ type: 'session/title', seq: 1, time: createdAt + 10, data: { title: session.title, messageSeqs: [], source: { kind: 'user' } } })
  }
  let seq = 2
  let time = createdAt + 100
  for (const message of session.messages) {
    time = message.time ?? time + 1000
    // DSH writes image parts with a media type; a generic file part carries only
    // an id, a name and a byte count, exactly like the real log.
    const image = typeof message.mime === 'string' && message.mime.startsWith('image/')
    frames.push({
      type: 'user/message',
      seq: seq += 1,
      time,
      data: {
        content: [
          {
            type: image ? 'image' : 'file',
            attachment: {
              attachmentId: `sha256:${message.sha}`,
              ...(image ? { mediaType: message.mime } : {}),
              bytes: message.bytes,
              ...(typeof message.name === 'string' && message.name !== '' ? { name: message.name } : {}),
            },
          },
          { type: 'text', text: `Please look at ${message.name}` },
        ],
      },
    })
    frames.push({ type: 'turn/start', seq: seq += 1, time: time + 1, data: { turn: seq } })
  }
  for (const extra of session.extraFrames ?? []) frames.push(extra)
  const log = join(dir, 'session.v4.jsonl.zstd')
  await writeFile(log, encodeFrames(frames))
  return { dir, log, frames: frames.length }
}

/** Append bytes to a log without rewriting it, emulating the next append. */
export async function appendFrame(log, value) {
  const { appendFile } = await import('node:fs/promises')
  await appendFile(log, zstdCompressSync(Buffer.from(`${typeof value === 'string' ? value : JSON.stringify(value)}\n`)))
}

/** Minimal fetch/post helpers for a route test server. */
export async function startRouteServer(handler) {
  const { createServer } = await import('node:http')
  const server = createServer((req, res) => { void handler(req, res) })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  const base = `http://127.0.0.1:${address.port}`
  return {
    base,
    url: path => `${base}${path}`,
    close: () => new Promise(resolve => server.close(resolve)),
  }
}

export function serialize(vnode) {
  const escape = text => String(text)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
  const render = node => {
    if (node === null || node === undefined || node === false || node === true) return ''
    if (typeof node === 'string' || typeof node === 'number') return escape(node)
    if (Array.isArray(node)) return node.map(render).join('')
    if (typeof node !== 'object') return ''
    if (typeof node.type === 'function') return render(node.type(node.props))
    const props = node.props ?? {}
    const attrs = Object.entries(props)
      .filter(([key, value]) => key !== 'children' && key !== 'ref' && !key.startsWith('on') && typeof value !== 'function' && value !== undefined && value !== null && value !== false)
      .map(([key, value]) => {
        const name = key === 'className' ? 'class' : key
        return value === true ? ` ${name}` : ` ${name}="${escape(value)}"`
      })
      .join('')
    return `<${node.type}${attrs}>${render(props.children)}</${node.type}>`
  }
  return render(vnode)
}

/** Load client.js under a fake module loader and return its exports. */
export async function loadClient() {
  const { readFile } = await import('node:fs/promises')
  const { fileURLToPath } = await import('node:url')
  const path = fileURLToPath(new URL('../client.js', import.meta.url))
  const code = await readFile(path, 'utf8')
  let captured
  const windowObject = { __ModuleLoader__: { load: definition => { captured = definition } } }
  const factory = new Function('window', 'module', `${code}\n`)
  factory(windowObject, { exports: {} })
  if (captured === undefined) throw new Error('client.js did not call the module loader')
  const react = {
    createElement(type, props, ...children) {
      return {
        type,
        props: {
          ...(props ?? {}),
          children: children.length === 0 ? undefined : children.length === 1 ? children[0] : children,
        },
      }
    },
    useState: value => [value, () => {}],
    useEffect: () => {},
    useRef: () => ({ current: null }),
    useMemo: fn => fn(),
    useCallback: fn => fn,
  }
  const api = captured.factory(name => {
    if (name === 'react') return react
    throw new Error(`unexpected require(${name})`)
  })
  return api
}
