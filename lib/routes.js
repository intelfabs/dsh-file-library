/**
 * Same-origin HTTP routes for the library, registered on the host's existing
 * web server. The handler only ever reads an attachment by an indexed SHA-256
 * and writes inside a session workspace resolved from the host's own session
 * header, never from a client-supplied path.
 */
import { createReadStream } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import {
  atomicWrite, boundedInt, contentDisposition, isInlineMediaType, isSha256, libraryReference,
} from './util.js'
import { isAttachmentObjectPath } from './indexer.js'
import { iconSvg } from './icons.js'
import { publicCoverage } from './library.js'
import { readManifest } from './filing.js'
import { createImporter, ImportError } from './import.js'

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
 * Parse one `Range: bytes=a-b` header against a known entity size.
 *
 * @param {string|undefined} value raw header
 * @param {number} size entity size in bytes
 * @returns {{start: number, end: number}|null|undefined} a satisfiable range,
 *   `null` when the range cannot be satisfied (416), or `undefined` when the
 *   header should be ignored and the whole entity returned.
 */
function parseRange(value, size) {
  if (typeof value !== 'string' || value.trim() === '') return undefined
  const match = /^bytes=([0-9]*)-([0-9]*)$/.exec(value.trim())
  if (match === null) return undefined
  const [, rawStart, rawEnd] = match
  if (rawStart === '' && rawEnd === '') return undefined
  if (size <= 0) return null
  let start
  let end
  if (rawStart === '') {
    const suffix = Number(rawEnd)
    if (!Number.isFinite(suffix) || suffix <= 0) return null
    start = Math.max(0, size - suffix)
    end = size - 1
  } else {
    start = Number(rawStart)
    end = rawEnd === '' ? size - 1 : Math.min(size - 1, Number(rawEnd))
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) return null
  return { start, end }
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
    fileObjects: stats.fileObjects ?? 0,
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
  const importer = createImporter({ home: library.home, cacheDir, limits })
  /** A read this old is re-scanned once before it is served, so a newly sent file appears without a host restart. */
  const autoReindexMs = limits.autoReindexMs ?? 30_000

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

  /**
   * Browse the library, optionally scoped to the workspace of one session.
   *
   * `scope=workspace` (the default when a session resolves) resolves the
   * workspace from host-owned data — never from the client — and keeps rows
   * that were sent to it, plus rows already filed into its manifest from any
   * other session. `scope=all` keeps every row. An unresolvable session falls
   * back to `all` and says why in `scopeFallback`.
   */
  const indexRoute = async (req, res, url) => {
    await library.ensureReady()
    // Reading the library must not serve a stale scan. An explicit refresh
    // always rebuilds; otherwise a scan older than the window is rebuilt once.
    const force = url.searchParams.get('refresh') === '1'
    const current = library.status()
    if (force || (current.generatedAt !== null && Date.now() - current.generatedAt > autoReindexMs)) {
      await library.rebuild()
    }
    const q = (url.searchParams.get('q') ?? '').slice(0, 200).trim().toLowerCase()
    const kind = url.searchParams.get('kind') ?? 'all'
    const limit = boundedInt(url.searchParams.get('limit'), 500, 1, limits.maxIndexEntries)
    const sessionId = url.searchParams.get('sessionId') ?? ''
    const scopeParam = url.searchParams.get('scope')
    const asked = scopeParam === 'all' ? 'all' : scopeParam === 'workspace' ? 'workspace' : undefined

    // Resolve the workspace host-side. A stale, unknown or hostile session id
    // must not break browsing, so it degrades to the whole library instead.
    let workspace
    let fallback
    if (sessionId === '') {
      fallback = 'no-session'
    } else {
      try {
        workspace = (await workspaceOf(sessionId)).workspace
      } catch (error) {
        fallback = error instanceof HttpError && error.status === 400 ? 'invalid-session' : 'unknown-session'
      }
    }
    const scope = asked === 'all' || workspace === undefined ? 'all' : 'workspace'
    const scopeFallback = scope === 'all' && asked !== 'all' ? fallback : undefined

    let filed = {}
    let filedCount = 0
    if (workspace !== undefined) {
      try {
        const manifest = await readManifest(workspace)
        filed = Object.fromEntries(manifest.files.map(file => [file.sha, {
          path: `library/${file.name}`,
          tags: file.tags,
          addedAt: file.addedAt,
        }]))
        filedCount = manifest.files.length
      } catch {
        // A corrupt manifest must not hide the rest of the library.
      }
    }

    // Query the kind without the text first: tags live in the workspace
    // manifest and must be part of the text match. Rows are marked with the
    // path-free `inWorkspace` flag, so both scopes come from one pass.
    const result = library.query({ kind, limit: limits.maxIndexEntries, workspace })
    const tokens = q.split(/\s+/).filter(Boolean)
    const matched = result.entries
      .map(entry => ({
        ...entry,
        filed: Object.hasOwn(filed, entry.sha256),
        state: entry.state === 'missing'
          ? 'missing'
          : Object.hasOwn(filed, entry.sha256) ? 'filed-here' : entry.state,
        tags: filed[entry.sha256]?.tags ?? [],
        filedPath: filed[entry.sha256]?.path ?? null,
      }))
      .filter(entry => {
        if (tokens.length === 0) return true
        const haystack = [entry.name, entry.kind, entry.ext, entry.mediaType, entry.sessionTitle, ...entry.tags].join(' ').toLowerCase()
        return tokens.every(token => haystack.includes(token))
      })
    const scoped = scope === 'workspace'
      ? matched.filter(entry => entry.inWorkspace === true || entry.filed === true)
      : matched
    const status = library.status()
    sendJson(res, 200, {
      ok: true,
      version: 1,
      scope,
      ...(scopeFallback === undefined ? {} : { scopeFallback }),
      state: status.state,
      warm: status.source === 'cache',
      generatedAt: status.generatedAt,
      coverage: publicCoverage(status.stats),
      count: scoped.length,
      totalAll: matched.length,
      entries: scoped.slice(0, limit),
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
        reference: libraryReference(file.name),
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

  /**
   * Stream one indexed attachment object. Every byte read is gated on the SHA
   * being in the index, its `available` flag, and its object path resolving
   * inside the attachment store — no client value ever reaches the path join.
   *
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   * @param {object} entry index row
   * @param {{contentType: string, inline: boolean, allowRanges?: boolean,
   *   maxBytes?: number, cacheControl?: string, extra?: object}} options
   */
  const serveObject = async (req, res, entry, options) => {
    // Image objects and generic-file objects are two stores; the entry's digest
    // decides which one, and a path outside both is never served.
    const objectPath = entry.objectPath
    if (!isAttachmentObjectPath(library.home, objectPath, entry.sha256)) {
      throw new HttpError(404, 'not found')
    }
    const info = await stat(objectPath).catch(() => undefined)
    if (info === undefined || !info.isFile()) throw new HttpError(404, 'not found')
    if (options.maxBytes !== undefined && info.size > options.maxBytes) throw new HttpError(404, 'not found')
    const etag = `"${entry.sha256}"`
    const headers = {
      'Content-Type': options.contentType,
      ETag: etag,
      'Cache-Control': options.cacheControl ?? 'public, max-age=31536000, immutable',
      'Content-Disposition': contentDisposition(entry.name, options.inline),
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      ...(options.allowRanges === true ? { 'Accept-Ranges': 'bytes' } : {}),
      ...(options.extra ?? {}),
    }
    if (req.headers['if-none-match'] === etag) {
      headersFor(res, { ETag: etag, 'Cache-Control': headers['Cache-Control'] })
      res.statusCode = 304
      res.end()
      return
    }
    const range = options.allowRanges === true ? parseRange(req.headers.range, info.size) : undefined
    if (range === null) {
      headersFor(res, { ...headers, 'Accept-Ranges': 'bytes', 'Content-Range': `bytes */${info.size}` })
      res.statusCode = 416
      res.end()
      return
    }
    const start = range === undefined ? 0 : range.start
    const end = range === undefined ? info.size - 1 : range.end
    const length = info.size === 0 ? 0 : end - start + 1
    headersFor(res, {
      ...headers,
      ...(range === undefined ? {} : { 'Content-Range': `bytes ${start}-${end}/${info.size}` }),
      'Content-Length': String(length),
    })
    res.statusCode = range === undefined ? 200 : 206
    if (req.method === 'HEAD' || length === 0) {
      res.end()
      return
    }
    const stream = createReadStream(objectPath, { start, end })
    stream.on('error', () => {
      if (!res.writableEnded) res.destroy()
    })
    stream.pipe(res)
  }

  /**
   * Raw bytes for one indexed object, used by "Open"/"Preview".
   *
   * Only an allowlist renders inline. `image/svg+xml`, `text/html` and every
   * other type is forced to `application/octet-stream` with an `attachment`
   * disposition, so user markup can never execute in the GUI's origin.
   */
  const objectRoute = async (req, res, sha) => {
    const entry = library.get(sha)
    if (entry === undefined || entry.available !== true) throw new HttpError(404, 'not found')
    const declared = typeof entry.mediaType === 'string' ? entry.mediaType.toLowerCase() : ''
    const inline = isInlineMediaType(declared)
    await serveObject(req, res, entry, {
      contentType: inline && declared.startsWith('text/') ? `${declared}; charset=utf-8` : inline ? declared : 'application/octet-stream',
      inline,
      allowRanges: true,
    })
  }

  const thumbRoute = async (req, res, sha) => {
    if (!isSha256(sha)) throw new HttpError(404, 'not found')
    const entry = library.get(sha)
    if (entry === undefined || entry.available !== true) throw new HttpError(404, 'not found')
    const isImage = typeof entry.mediaType === 'string'
      && entry.mediaType.startsWith('image/')
      && entry.mediaType !== 'image/svg+xml'
      && entry.bytes <= limits.maxThumbBytes
    if (isImage) {
      await serveObject(req, res, entry, {
        contentType: entry.mediaType,
        inline: true,
        allowRanges: false,
        maxBytes: limits.maxThumbBytes,
      })
      return
    }
    const etag = `"${sha}"`
    if (req.headers['if-none-match'] === etag) {
      headersFor(res, { ETag: etag, 'Cache-Control': 'public, max-age=31536000, immutable' })
      res.statusCode = 304
      res.end()
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

  /**
   * Copy one existing file into the attachment store. This is the explicit
   * fallback for a surface where the composer's file picker is unavailable; the
   * bytes are stored exactly like a DSH file upload, and the row is listed from
   * the plugin's import manifest.
   */
  const importRoute = async (req, res) => {
    if (!/^application\/json\b/i.test(String(req.headers['content-type'] ?? ''))) {
      throw new HttpError(415, 'Content-Type must be application/json')
    }
    const body = await readJsonBody(req, limits.maxRequestBodyBytes)
    const info = await workspaceOf(body.sessionId)
    let imported
    try {
      imported = await importer.importFile({
        path: body.path,
        workspace: info.workspace,
        sessionId: body.sessionId,
      })
    } catch (error) {
      if (error instanceof ImportError) throw new HttpError(error.status, error.message)
      throw error
    }
    await library.reloadImports()
    sendJson(res, 200, { ok: true, ...imported })
  }

  /**
   * Re-scan the session logs on demand. The tab's Refresh button calls this so a
   * file sent after the host process started is visible without a restart.
   */
  const reindexRoute = async (req, res) => {
    const result = await library.rebuild()
    const status = library.status()
    sendJson(res, 200, {
      ok: true,
      rebuilt: result.ok === true,
      state: status.state,
      count: status.count,
      generatedAt: status.generatedAt,
      ...(result.error === undefined ? {} : { error: result.error }),
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
      if (rest === '/reindex' && method === 'POST') return await reindexRoute(req, res)
      if (rest === '/import' && method === 'POST') return await importRoute(req, res)
      if (rest === '/filed' && readMethod) return await filedRoute(req, res, url)
      if (rest === '/file' && method === 'POST') return await fileRoute(req, res)
      if (rest === '/status' && readMethod) return await statusRoute(req, res)
      const thumb = /^\/thumb\/([a-f0-9]{64})$/.exec(rest)
      if (thumb !== null && readMethod) return await thumbRoute(req, res, thumb[1])
      const object = /^\/object\/([a-f0-9]{64})$/.exec(rest)
      if (object !== null && readMethod) return await objectRoute(req, res, object[1])

      if (rest.startsWith('/thumb/') || rest.startsWith('/object/')) {
        if (readMethod) throw new HttpError(404, 'not found')
        throw new HttpError(405, 'method not allowed')
      }
      if (['/index', '/filed', '/status', '/file', '/reindex', '/import', '/object'].includes(rest)) {
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
