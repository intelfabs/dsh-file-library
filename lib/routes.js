/**
 * Same-origin HTTP routes for the library, registered on the host's existing
 * web server. The handler only ever reads an attachment by an indexed SHA-256
 * and writes inside a session workspace resolved from the host's own session
 * header, never from a client-supplied path.
 */
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { escapeXml, atomicWrite, boundedInt, isSha256 } from './util.js'
import { iconSvg } from './icons.js'
import { publicEntry } from './library.js'
import { readManifest } from './filing.js'

export const ROUTE_PREFIX = '/plugins/dsh-file-library'
const SESSION_ID = /^[A-Za-z0-9._-]{1,128}$/

class HttpError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

function headersFor(res, extra = {}) {
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Referrer-Policy', 'no-referrer')
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin')
  for (const [key, value] of Object.entries(extra)) res.setHeader(key, value)
}

function sendJson(res, status, body, extra = {}) {
  if (res.writableEnded) return
  const data = Buffer.from(JSON.stringify(body))
  headersFor(res, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(data.length),
    'Cache-Control': 'no-store',
    ...extra,
  })
  res.statusCode = status
  if (res.req?.method === 'HEAD') res.end()
  else res.end(data)
}

function sendText(res, status, text, extra = {}) {
  if (res.writableEnded) return
  const data = Buffer.from(text)
  headersFor(res, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': String(data.length),
    'Cache-Control': 'no-store',
    ...extra,
  })
  res.statusCode = status
  if (res.req?.method === 'HEAD') res.end()
  else res.end(data)
}

function sendBytes(res, status, data, contentType, extra = {}) {
  if (res.writableEnded) return
  headersFor(res, {
    'Content-Type': contentType,
    'Content-Length': String(data.length),
    ...extra,
  })
  res.statusCode = status
  if (res.req?.method === 'HEAD') res.end()
  else res.end(data)
}

/**
 * Same-origin gate. `Sec-Fetch-Site` is browser-set and cannot be forged by
 * page script; when a proxy rewrites Host, a same-origin fetch still passes.
 * An auth proxy may sit in front, but authorization never relies on it.
 */
export function isSameOrigin(req) {
  const site = String(req.headers['sec-fetch-site'] ?? '').toLowerCase()
  if (site === 'cross-site') return false
  if (site === 'same-origin' || site === 'none') return true
  const origin = req.headers.origin
  if (typeof origin !== 'string' || origin === '') return true
  let originHost
  try {
    originHost = new URL(origin).host.toLowerCase()
  } catch {
    return false
  }
  const candidates = [
    req.headers.host,
    req.headers['x-forwarded-host'],
  ].filter(value => typeof value === 'string').map(value => value.split(',')[0].trim().toLowerCase())
  return candidates.includes(originHost)
}

async function readJsonBody(req, maxBytes) {
  const chunks = []
  let size = 0
  let tooLarge = false
  for await (const chunk of req) {
    size += chunk.length
    if (size > maxBytes) {
      tooLarge = true
      chunks.length = 0
      continue
    }
    if (!tooLarge) chunks.push(chunk)
  }
  if (tooLarge) throw new HttpError(413, 'request body is too large')
  const text = Buffer.concat(chunks).toString('utf8')
  try {
    const parsed = JSON.parse(text)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('not an object')
    }
    return parsed
  } catch {
    throw new HttpError(400, 'request body must be a JSON object')
  }
}

function publicStats(stats) {
  if (stats === null || typeof stats !== 'object') return {}
  return {
    sessionsSeen: stats.sessionsSeen ?? 0,
    logsDecoded: stats.logsDecoded ?? 0,
    logsReused: stats.logsReused ?? 0,
    logsSkipped: stats.logsSkipped ?? 0,
    framesDecoded: stats.framesDecoded ?? 0,
    missingObjects: stats.missingObjects ?? 0,
    durationMs: stats.durationMs ?? 0,
    warningCount: Array.isArray(stats.warnings) ? stats.warnings.length : 0,
    truncated: stats.truncated === true,
  }
}

/**
 * Build the route handler.
 * @param {{
 *   library: ReturnType<typeof import('./library.js').createLibrary>,
 *   filer: ReturnType<typeof import('./filing.js').createFiler>,
 *   resolveWorkspace: (sessionId: string) => Promise<{workspace: string, title?: string} | undefined>,
 *   cacheDir: string,
 *   limits: object,
 * }} deps
 */
export function createRoutes(deps) {
  const { library, filer, resolveWorkspace, cacheDir, limits } = deps
  const thumbsDir = join(cacheDir, 'thumbs')

  const workspaceOf = async (sessionId) => {
    if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)) {
      throw new HttpError(400, 'sessionId is invalid')
    }
    const resolved = await resolveWorkspace(sessionId)
    if (resolved === undefined || typeof resolved.workspace !== 'string') {
      throw new HttpError(404, 'session workspace is unknown')
    }
    return resolved
  }

  const indexRoute = async (req, res, url) => {
    await library.ensureReady()
    const q = (url.searchParams.get('q') ?? '').slice(0, 200).trim().toLowerCase()
    const kind = url.searchParams.get('kind') ?? 'all'
    const limit = boundedInt(url.searchParams.get('limit'), 500, 1, limits.maxIndexEntries)
    const sessionId = url.searchParams.get('sessionId') ?? ''
    // Query the kind without the text first: tags live in the workspace
    // manifest and must be part of the text match.
    const result = library.query({ kind, limit: limits.maxIndexEntries })
    let filed = {}
    let filedCount = 0
    if (sessionId !== '') {
      try {
        const info = await workspaceOf(sessionId)
        const manifest = await readManifest(info.workspace)
        filed = Object.fromEntries(manifest.files.map(file => [file.sha, {
          path: `library/${file.name}`,
          tags: file.tags,
          addedAt: file.addedAt,
        }]))
        filedCount = manifest.files.length
      } catch {
        // A stale or unknown session must not break browsing the library.
      }
    }
    const tokens = q.split(/\s+/).filter(Boolean)
    const entries = result.entries
      .map(entry => ({
        ...entry,
        filed: Object.hasOwn(filed, entry.sha256),
        tags: filed[entry.sha256]?.tags ?? [],
        filedPath: filed[entry.sha256]?.path ?? null,
      }))
      .filter(entry => {
        if (tokens.length === 0) return true
        const haystack = [entry.name, entry.kind, entry.ext, entry.mediaType, entry.sessionTitle, ...entry.tags].join(' ').toLowerCase()
        return tokens.every(token => haystack.includes(token))
      })
    sendJson(res, 200, {
      ok: true,
      version: 1,
      state: library.status().state,
      warm: library.status().source === 'cache',
      generatedAt: library.status().generatedAt,
      count: entries.length,
      entries: entries.slice(0, limit),
      filedCount,
    })
  }

  const filedRoute = async (req, res, url) => {
    const info = await workspaceOf(url.searchParams.get('sessionId') ?? '')
    const manifest = await readManifest(info.workspace)
    sendJson(res, 200, {
      ok: true,
      count: manifest.files.length,
      files: manifest.files.map(file => ({
        sha: file.sha,
        name: file.name,
        mime: file.mime,
        bytes: file.bytes,
        addedAt: file.addedAt,
        tags: file.tags,
        relativePath: `library/${file.name}`,
        reference: `@library/${file.name}`,
        source: file.source,
      })),
    })
  }

  const fileRoute = async (req, res) => {
    if (!/^application\/json\b/i.test(String(req.headers['content-type'] ?? ''))) {
      throw new HttpError(415, 'Content-Type must be application/json')
    }
    const body = await readJsonBody(req, limits.maxRequestBodyBytes)
    const sha = typeof body.sha === 'string' ? body.sha : ''
    if (!isSha256(sha)) throw new HttpError(400, 'sha is not a SHA-256 digest')
    const entry = library.get(sha)
    if (entry === undefined) throw new HttpError(404, 'attachment is not in the index')
    const info = await workspaceOf(body.sessionId)
    let filed
    try {
      filed = await filer.fileThis({
        entry,
        workspace: info.workspace,
        tags: body.tags,
        source: { sessionId: body.sessionId, title: info.title ?? entry.sessionTitle ?? '' },
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (/path separator|reserved|safe file name|escapes the workspace|is a link/.test(message)) {
        throw new HttpError(400, message)
      }
      if (/bytes are missing|not an indexed attachment/.test(message)) throw new HttpError(409, message)
      throw error
    }
    sendJson(res, 200, {
      ok: true,
      sha: filed.sha,
      name: filed.name,
      relativePath: filed.relativePath,
      reference: filed.reference,
      deduped: filed.deduped,
      bytes: filed.bytes,
      mime: filed.mime,
      addedAt: filed.addedAt,
      tags: filed.tags,
    })
  }

  const thumbRoute = async (req, res, sha) => {
    if (!isSha256(sha)) throw new HttpError(404, 'not found')
    const entry = library.get(sha)
    if (entry === undefined || entry.available !== true) throw new HttpError(404, 'not found')
    const etag = `"${sha}"`
    if (req.headers['if-none-match'] === etag) {
      headersFor(res, { ETag: etag, 'Cache-Control': 'public, max-age=31536000, immutable' })
      res.statusCode = 304
      res.end()
      return
    }
    const isImage = typeof entry.mediaType === 'string'
      && entry.mediaType.startsWith('image/')
      && entry.mediaType !== 'image/svg+xml'
      && entry.bytes <= limits.maxThumbBytes
    if (isImage) {
      const objectPath = entry.objectPath
      const info = await stat(objectPath).catch(() => undefined)
      if (info === undefined || !info.isFile() || info.size > limits.maxThumbBytes) {
        throw new HttpError(404, 'not found')
      }
      const data = await readFile(objectPath)
      sendBytes(res, 200, data, entry.mediaType, {
        ETag: etag,
        'Cache-Control': 'public, max-age=31536000, immutable',
        'Content-Disposition': `inline; filename="${String(entry.name).replace(/[^\x20-\x7e]/g, '_').replaceAll('"', "'")}"`,
        'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      })
      return
    }
    const cached = join(thumbsDir, `${sha}.svg`)
    let svg
    try {
      svg = await readFile(cached)
    } catch {
      svg = Buffer.from(iconSvg(entry))
      await atomicWrite(cached, svg).catch(() => undefined)
    }
    sendBytes(res, 200, svg, 'image/svg+xml; charset=utf-8', {
      ETag: etag,
      'Cache-Control': 'public, max-age=31536000, immutable',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    })
  }

  const statusRoute = async (req, res) => {
    const status = library.status()
    sendJson(res, 200, {
      ok: true,
      state: status.state,
      ready: status.ready,
      source: status.source,
      count: status.count,
      generatedAt: status.generatedAt,
      stats: publicStats(status.stats),
      cache: true,
      limits: {
        maxSessions: limits.maxSessions,
        maxLogBytes: limits.maxLogBytes,
        maxCopyBytes: limits.maxCopyBytes,
        maxThumbBytes: limits.maxThumbBytes,
      },
    })
  }

  const handle = async (req, res) => {
    try {
      if (!isSameOrigin(req)) {
        sendText(res, 403, 'cross-origin request refused')
        return
      }
      if (typeof req.url !== 'string') throw new HttpError(400, 'bad request')
      const url = new URL(req.url, 'http://localhost')
      if (!url.pathname.startsWith(ROUTE_PREFIX)) throw new HttpError(404, 'not found')
      const rest = url.pathname.slice(ROUTE_PREFIX.length)
      const method = req.method ?? 'GET'

      const readMethod = method === 'GET' || method === 'HEAD'
      if (rest === '/index' && readMethod) return await indexRoute(req, res, url)
      if (rest === '/filed' && readMethod) return await filedRoute(req, res, url)
      if (rest === '/file' && method === 'POST') return await fileRoute(req, res)
      if (rest === '/status' && readMethod) return await statusRoute(req, res)
      const thumb = /^\/thumb\/([a-f0-9]{64})$/.exec(rest)
      if (thumb !== null && readMethod) return await thumbRoute(req, res, thumb[1])

      if (rest.startsWith('/thumb/')) {
        if (readMethod) throw new HttpError(404, 'not found')
        throw new HttpError(405, 'method not allowed')
      }
      if (['/index', '/filed', '/status', '/file'].includes(rest)) {
        throw new HttpError(405, 'method not allowed')
      }
      throw new HttpError(404, 'not found')
    } catch (error) {
      if (res.writableEnded) return
      const status = error instanceof HttpError ? error.status : 500
      const message = error instanceof Error ? error.message : 'internal error'
      sendJson(res, status, { ok: false, error: message.slice(0, 300) })
    }
  }

  return { handle, prefix: ROUTE_PREFIX, thumbsDir }
}
