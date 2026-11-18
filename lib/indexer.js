/**
 * Host-side index of the DSH attachment store.
 *
 * Attachment bytes live in `$DSH_HOME/attachments/v1/objects/<sha[0:2]>/<sha>`
 * and carry no name. The original name, media type and sending time survive
 * only in `$DSH_HOME/sessions/<workspace>/<session>/session.v4.jsonl.zstd`, so
 * this module reads those logs (bounded), extracts user-sent attachment
 * records, and joins them to the object files.
 */
import { open, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { addWorkspace, baseDisplayName, extensionFor, isSha256, kindOf, normalizeSha } from './util.js'
import { decodeZstdLog, parseLogLines } from './zstd-log.js'

/** Conservative work bounds; every one is documented in the README. */
export const DEFAULT_LIMITS = Object.freeze({
  /** Maximum number of session logs opened per build. */
  maxSessions: 5000,
  /** A log larger than this is skipped instead of decoded. */
  maxLogBytes: 32 * 1024 * 1024,
  /** Maximum complete zstd frames decoded from one log. */
  maxFramesPerLog: 20000,
  /** Directory recursion depth below the sessions root. */
  maxDepth: 4,
  /** Maximum attachment objects stat'ed per build. */
  maxObjects: 50000,
  /** Maximum attachment records collected from one event. */
  maxAttachmentsPerEvent: 100,
  /** Parallel log reads. */
  concurrency: 4,
  /** `file this` refuses a source object larger than this. */
  maxCopyBytes: 256 * 1024 * 1024,
  /** Destination SHA verification is skipped above this size. */
  maxHashBytes: 64 * 1024 * 1024,
  /** Largest image object served as a thumbnail source. */
  maxThumbBytes: 12 * 1024 * 1024,
  /** Largest request body accepted by the routes. */
  maxRequestBodyBytes: 64 * 1024,
  /** Maximum entries returned by one index request. */
  maxIndexEntries: 2000,
})

const GENERIC_IMAGE_NAME = /^image\.(png|jpe?g|gif|webp|avif)$/i

/** Absolute DSH home for a host plugin. */
export function resolveHome(configured) {
  if (typeof configured === 'string' && configured.trim() !== '') return configured
  if (typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.trim() !== '') {
    return process.env.DSH_HOME
  }
  const home = process.env.USERPROFILE ?? process.env.HOME
  return join(home ?? '.', '.dsh')
}

/** Path of one attachment object. */
export function objectPathFor(home, sha) {
  return join(home, 'attachments', 'v1', 'objects', sha.slice(0, 2), sha)
}

async function mapLimit(items, limit, worker) {
  const results = new Array(items.length)
  let next = 0
  const run = async () => {
    for (;;) {
      const index = next
      next += 1
      if (index >= items.length) return
      results[index] = await worker(items[index], index)
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, run))
  return results
}

/** Record one attachment-shaped object into a per-event map. */
function recordAttachment(target, attachment, sentAt) {
  const sha = normalizeSha(attachment?.attachmentId ?? attachment?.sha256 ?? attachment?.sha)
  if (sha === undefined) return
  if (target.has(sha)) return
  const name = typeof attachment.name === 'string' && attachment.name.trim() !== ''
    ? attachment.name
    : undefined
  const mediaType = typeof attachment.mediaType === 'string' ? attachment.mediaType : undefined
  const bytes = Number.isFinite(attachment.bytes) ? Math.max(0, Math.trunc(attachment.bytes)) : undefined
  target.set(sha, {
    sha256: sha,
    ...(name === undefined ? {} : { name }),
    ...(mediaType === undefined ? {} : { mediaType }),
    ...(bytes === undefined ? {} : { bytes }),
    sentAt: Number.isFinite(sentAt) ? sentAt : undefined,
  })
}

/**
 * Collect attachment records from one event. Only user-origin content counts:
 * a file the user sent, not an image a tool generated while reading one.
 */
export function attachmentsFromEvent(event, limits = DEFAULT_LIMITS) {
  const found = new Map()
  const sentAt = Number.isFinite(event?.time) ? event.time : undefined
  const visit = (value, depth) => {
    if (value === null || typeof value !== 'object' || depth > 12) return
    if (found.size >= limits.maxAttachmentsPerEvent) return
    if (!Array.isArray(value)) {
      const attachment = value.attachment
      if (attachment !== null && typeof attachment === 'object') {
        recordAttachment(found, attachment, sentAt)
      }
      if (typeof value.attachmentId === 'string' || typeof value.sha256 === 'string') {
        recordAttachment(found, value, sentAt)
      }
    }
    for (const child of Object.values(value)) visit(child, depth + 1)
  }

  if (event?.type === 'agent/inbox/spliced' && Array.isArray(event?.data?.inserted)) {
    for (const item of event.data.inserted) {
      if (item?.source?.kind === 'user') visit(item, 0)
    }
    return [...found.values()]
  }
  if (event?.type !== 'user/message') return []
  // DSH also records an agent's own tool loop as a `user/message`: the turn that
  // carries a `read_image` (or PDF page render) result has
  // `data.source.kind = "ptc-mode"`, not "user". Those bytes were produced by a
  // tool, not sent by the person, so they stay out of the library. The source
  // lives on `data` in current logs and under `data.message` in older shapes,
  // so both are read. A message with no declared source is still treated as
  // user-origin, which keeps very old logs indexed.
  const source = event?.data?.message?.source ?? event?.data?.source
  const sourceKind = source?.kind
  if (typeof sourceKind === 'string' && sourceKind !== 'user') return []
  visit(event?.data ?? event, 0)
  return [...found.values()]
}

function titleFromEvent(event) {
  if (event?.type !== 'session/title') return undefined
  const title = event?.data?.title
  return typeof title === 'string' && title.trim() !== '' ? title.trim() : undefined
}

function userTextFromEvent(event) {
  if (event?.type === 'agent/inbox/spliced' && Array.isArray(event?.data?.inserted)) {
    for (const item of event.data.inserted) {
      if (item?.source?.kind !== 'user') continue
      for (const part of Array.isArray(item.content) ? item.content : []) {
        if (part?.type === 'text' && typeof part.text === 'string') return part.text
      }
    }
  }
  const content = event?.data?.message?.content ?? event?.data?.content
  if (Array.isArray(content)) {
    for (const part of content) {
      if (part?.type === 'text' && typeof part.text === 'string') return part.text
    }
  }
  return undefined
}

function cleanTitle(text) {
  return text.replace(/\s+/g, ' ').trim().slice(0, 80)
}

/**
 * Decode one session log into a cacheable session record.
 * @param {Buffer} buffer log bytes
 * @param {{maxFramesPerLog: number}} limits
 */
export function readSessionLog(buffer, limits) {
  const decoded = decodeZstdLog(buffer, { maxFrames: limits.maxFramesPerLog })
  const events = parseLogLines(decoded.text, {
    includeLine: line => line.includes('"user/message"')
      || line.includes('"agent/inbox/spliced"')
      || line.includes('"session/title"')
      || line.startsWith('{"type":"session"'),
  })
  let header
  let title
  let fallbackTitle
  const attachments = []
  for (const { event } of events) {
    if (header === undefined && event.type === 'session' && typeof event.id === 'string') {
      header = {
        id: event.id,
        ...(typeof event.cwd === 'string' ? { cwd: event.cwd } : {}),
        ...(Number.isFinite(event.createdAt) ? { createdAt: event.createdAt } : {}),
      }
    }
    const eventTitle = titleFromEvent(event)
    if (eventTitle !== undefined) title = eventTitle
    if (fallbackTitle === undefined) {
      const text = userTextFromEvent(event)
      if (typeof text === 'string' && text.trim() !== '') fallbackTitle = cleanTitle(text)
    }
    if (attachments.length < limits.maxObjects) {
      attachments.push(...attachmentsFromEvent(event, limits))
    }
  }
  return {
    header,
    title: title ?? fallbackTitle,
    attachments,
    frames: decoded.frames,
    ...(decoded.tornStart === undefined ? {} : { torn: true }),
    ...(decoded.error === undefined ? {} : { decodeError: decoded.error }),
  }
}

/**
 * Enumerate session log files under the sessions root, bounded for decoding.
 * Every matching log is counted even past `maxSessions`, so the index can say
 * how many sessions it covers instead of silently truncating.
 * @returns {{logs: string[], found: number}} selected logs and the total found
 */
export async function listSessionLogs(sessionsRoot, limits) {
  const logs = []
  let found = 0
  const walk = async (directory, depth) => {
    if (depth > limits.maxDepth) return
    let entries
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch {
      return
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (const entry of entries) {
      if (entry.isDirectory()) {
        await walk(join(directory, entry.name), depth + 1)
      } else if (entry.isFile() && /^session\.v4\..+\.zstd$/.test(entry.name)) {
        found += 1
        if (logs.length < limits.maxSessions) logs.push(join(directory, entry.name))
      }
    }
  }
  await walk(sessionsRoot, 0)
  return { logs, found }
}

async function readPrefix(path, maxBytes) {
  const handle = await open(path, 'r')
  try {
    const buffer = Buffer.alloc(maxBytes)
    const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0)
    return buffer.subarray(0, bytesRead)
  } finally {
    await handle.close()
  }
}

/**
 * Resolve a session header on demand, used when a client names a session the
 * current index has not seen yet. Returns undefined for an unknown id.
 */
export async function findSessionHeader(home, sessionId, limits = DEFAULT_LIMITS) {
  if (typeof sessionId !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/.test(sessionId)) return undefined
  const sessionsRoot = join(home, 'sessions')
  let workspaces
  try {
    workspaces = await readdir(sessionsRoot, { withFileTypes: true })
  } catch {
    return undefined
  }
  for (const workspace of workspaces) {
    if (!workspace.isDirectory()) continue
    const sessionDir = join(sessionsRoot, workspace.name, sessionId)
    try {
      const info = await stat(sessionDir)
      if (!info.isDirectory()) continue
    } catch {
      continue
    }
    try {
      const entries = await readdir(sessionDir)
      const logName = entries.find(name => /^session\.v4\..+\.zstd$/.test(name))
      if (logName === undefined) continue
      const buffer = await readPrefix(join(sessionDir, logName), Math.min(limits.maxLogBytes, 1024 * 1024))
      const record = readSessionLog(buffer, { ...limits, maxObjects: 1, maxFramesPerLog: 4 })
      if (record.header !== undefined) return record.header
    } catch {
      continue
    }
  }
  return undefined
}

/**
 * Build an index from the logs and the attachment object store.
 * @param {{home: string, limits?: object, previous?: object, now?: number}} options
 */
export async function buildIndex(options) {
  const started = Date.now()
  const home = options.home
  const limits = { ...DEFAULT_LIMITS, ...(options.limits ?? {}) }
  const previous = options.previous
  const sessionsRoot = join(home, 'sessions')
  const { logs, found } = await listSessionLogs(sessionsRoot, limits)
  const stats = {
    sessionsSeen: logs.length,
    /** Every matching log on disk, including the ones the scan cap excluded. */
    sessionsFound: found,
    /** Logs beyond `maxSessions` that were never opened. */
    sessionsSkipped: Math.max(0, found - logs.length),
    logsDecoded: 0,
    logsReused: 0,
    logsSkipped: 0,
    /** Logs skipped because they exceed `maxLogBytes`. */
    logsTooBig: 0,
    framesDecoded: 0,
    attachmentRecords: 0,
    missingObjects: 0,
    objects: 0,
    durationMs: 0,
    warnings: [],
    truncated: found > logs.length,
  }
  const sessions = {}

  const results = await mapLimit(logs, limits.concurrency, async (logPath) => {
    let info
    try {
      info = await stat(logPath)
    } catch {
      stats.logsSkipped += 1
      return
    }
    const fingerprint = `${info.size}:${Math.trunc(info.mtimeMs)}`
    const cached = previous?.sessions?.[logPath]
    if (cached !== undefined && cached.size === info.size && cached.mtimeMs === Math.trunc(info.mtimeMs)) {
      sessions[logPath] = cached
      stats.logsReused += 1
      return
    }
    if (info.size > limits.maxLogBytes) {
      stats.logsSkipped += 1
      stats.logsTooBig += 1
      stats.warnings.push(`log larger than ${limits.maxLogBytes} bytes skipped: ${logPath}`)
      return
    }
    let buffer
    try {
      buffer = await readPrefix(logPath, Math.min(limits.maxLogBytes, info.size))
    } catch {
      stats.logsSkipped += 1
      return
    }
    const record = readSessionLog(buffer, limits)
    stats.logsDecoded += 1
    stats.framesDecoded += record.frames
    if (record.decodeError !== undefined) stats.warnings.push(`decode warning in ${logPath}: ${record.decodeError}`)
    const workspaceDir = logPath.split(/[\\/]/).at(-3)
    const sessionId = record.header?.id ?? logPath.split(/[\\/]/).at(-2)
    const sessionRecord = {
      size: info.size,
      mtimeMs: Math.trunc(info.mtimeMs),
      sessionId,
      ...(record.title === undefined ? {} : { title: record.title }),
      ...(record.header?.cwd === undefined ? {} : { cwd: record.header.cwd }),
      workspaceDir,
      entries: record.attachments.map(attachment => ({
        ...attachment,
        sessionId,
        ...(record.title === undefined ? {} : { sessionTitle: record.title }),
        ...(record.header?.cwd === undefined ? {} : { workspace: record.header.cwd }),
      })),
    }
    sessions[logPath] = sessionRecord
  })
  void results

  // Merge session records by digest. The earliest occurrence owns the row; a
  // generic "image.png" name yields to a later specific one.
  const bySha = new Map()
  const orderedSessions = Object.entries(sessions)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, record]) => record)
  for (const record of orderedSessions) {
    for (const attachment of record.entries ?? []) {
      stats.attachmentRecords += 1
      const existing = bySha.get(attachment.sha256)
      if (existing === undefined) {
        bySha.set(attachment.sha256, {
          ...attachment,
          sessionIds: [attachment.sessionId],
          // Every distinct cwd that ever sent these bytes, so one row can be
          // scoped to any of the workspaces it belongs to.
          workspaces: addWorkspace([], attachment.workspace),
          occurrences: 1,
        })
        continue
      }
      existing.occurrences += 1
      existing.workspaces = addWorkspace(existing.workspaces, attachment.workspace)
      if (!existing.sessionIds.includes(attachment.sessionId) && existing.sessionIds.length < 12) {
        existing.sessionIds.push(attachment.sessionId)
      }
      if (existing.sentAt === undefined || (attachment.sentAt !== undefined && attachment.sentAt < existing.sentAt)) {
        existing.sentAt = attachment.sentAt
        existing.sessionId = attachment.sessionId
        existing.sessionTitle = attachment.sessionTitle
        existing.workspace = attachment.workspace
      }
      const existingName = existing.name ?? ''
      const candidateName = attachment.name ?? ''
      if (GENERIC_IMAGE_NAME.test(existingName) && !GENERIC_IMAGE_NAME.test(candidateName) && candidateName !== '') {
        existing.name = candidateName
        // The row now shows the recognizable name; its source should be the
        // message that carried that name.
        existing.sentAt = attachment.sentAt
        existing.sessionId = attachment.sessionId
        existing.sessionTitle = attachment.sessionTitle
        existing.workspace = attachment.workspace
      }
      if (existing.mediaType === undefined && attachment.mediaType !== undefined) existing.mediaType = attachment.mediaType
      if (existing.bytes === undefined && attachment.bytes !== undefined) existing.bytes = attachment.bytes
    }
  }

  const unique = [...bySha.values()]
  await mapLimit(unique.slice(0, limits.maxObjects), Math.max(2, limits.concurrency * 2), async (entry) => {
    const objectPath = objectPathFor(home, entry.sha256)
    let available = false
    try {
      const objectStat = await stat(objectPath)
      available = objectStat.isFile()
      if (available && (entry.bytes === undefined || entry.bytes === 0)) entry.bytes = objectStat.size
    } catch {
      available = false
    }
    entry.objectPath = objectPath
    entry.available = available
    if (!available) stats.missingObjects += 1
    const name = baseDisplayName(entry.name ?? `attachment.${extensionFor(entry.mediaType, '')}`, `attachment.${extensionFor(entry.mediaType, '')}`)
    const ext = extensionFor(entry.mediaType, name)
    entry.name = name
    entry.ext = ext
    entry.kind = kindOf(entry.mediaType, name)
    entry.bytes = entry.bytes ?? 0
  })

  const entries = unique
    .filter(entry => entry.available)
    .sort((a, b) => (b.sentAt ?? 0) - (a.sentAt ?? 0) || a.name.localeCompare(b.name))
  stats.objects = entries.length
  stats.durationMs = Date.now() - started
  return { entries, sessions, stats, generatedAt: Date.now() }
}
