/**
 * In-memory library state and its size+mtime cache. The cache only holds
 * metadata derived from session logs; attachment bytes stay in DSH's store.
 */
import { join } from 'node:path'
import { buildIndex, DEFAULT_LIMITS, resolveHome } from './indexer.js'
import { atomicWrite, boundedInt, extensionFor, isoTime, kindOf, readJson } from './util.js'

export const CACHE_VERSION = 1

/** Shape an index entry for the browser: no absolute paths leave the host. */
export function publicEntry(entry) {
  return {
    sha256: entry.sha256,
    name: entry.name,
    mediaType: entry.mediaType ?? 'application/octet-stream',
    bytes: entry.bytes ?? 0,
    sentAt: entry.sentAt ?? null,
    sessionId: entry.sessionId,
    sessionTitle: entry.sessionTitle ?? '',
    kind: entry.kind ?? 'other',
    ext: entry.ext ?? 'bin',
    occurrences: entry.occurrences ?? 1,
  }
}

/**
 * Create the library. `init()` loads the cache immediately when one exists and
 * schedules a background rebuild; without a cache it builds once before it
 * resolves, so the first page request already has data.
 */
export function createLibrary(options = {}) {
  const home = resolveHome(options.home)
  const limits = { ...DEFAULT_LIMITS, ...(options.limits ?? {}) }
  const cacheDir = options.cacheDir ?? join(home, 'cache', 'dsh-file-library')
  const cachePath = join(cacheDir, 'index.v1.json')
  const schedule = options.schedule ?? ((fn, ms) => {
    const timer = setTimeout(fn, ms)
    timer.unref?.()
    return timer
  })

  let entries = []
  let bySha = new Map()
  let sessionById = new Map()
  let sessions = {}
  let generatedAt = null
  let stats = null
  let state = 'cold'
  let source = 'none'
  let error = null
  let initPromise
  let buildPromise

  const apply = async (result) => {
    entries = result.entries
    bySha = new Map(entries.map(entry => [entry.sha256, entry]))
    sessions = result.sessions
    generatedAt = result.generatedAt
    stats = result.stats
    sessionById = new Map()
    for (const record of Object.values(sessions)) {
      if (record?.sessionId === undefined) continue
      sessionById.set(record.sessionId, {
        sessionId: record.sessionId,
        title: record.title ?? '',
        workspace: record.cwd,
        workspaceDir: record.workspaceDir,
      })
    }
    state = 'ready'
  }

  const rebuild = async () => {
    if (buildPromise !== undefined) return buildPromise
    buildPromise = (async () => {
      try {
        const result = await buildIndex({ home, limits, previous: { sessions } })
        await apply(result)
        source = 'scan'
        error = null
        await atomicWrite(cachePath, JSON.stringify({
          version: CACHE_VERSION,
          generatedAt: result.generatedAt,
          sessions: result.sessions,
          entries: result.entries,
        }))
        return { ok: true, ...status() }
      } catch (cause) {
        error = cause instanceof Error ? cause.message : String(cause)
        state = entries.length > 0 ? 'ready' : 'error'
        return { ok: false, error, ...status() }
      } finally {
        buildPromise = undefined
      }
    })()
    return buildPromise
  }

  const loadCache = async () => {
    const cache = await readJson(cachePath)
    if (cache?.version !== CACHE_VERSION || typeof cache.sessions !== 'object' || cache.sessions === null) {
      return false
    }
    const flat = []
    const sessionMap = {}
    for (const [logPath, record] of Object.entries(cache.sessions)) {
      if (record === null || typeof record !== 'object' || !Array.isArray(record.entries)) continue
      sessionMap[logPath] = record
      for (const entry of record.entries) {
        if (entry !== null && typeof entry === 'object' && typeof entry.sha256 === 'string') flat.push(entry)
      }
    }
    // Re-merge the cached per-session rows exactly like a fresh build so a warm
    // start and a cold build order and dedupe identically.
    const merged = new Map()
    for (const entry of flat) {
      const existing = merged.get(entry.sha256)
      if (existing === undefined) {
        merged.set(entry.sha256, { ...entry, sessionIds: entry.sessionIds ?? [entry.sessionId], occurrences: entry.occurrences ?? 1 })
        continue
      }
      existing.occurrences += 1
      if (!existing.sessionIds.includes(entry.sessionId) && existing.sessionIds.length < 12) existing.sessionIds.push(entry.sessionId)
      if (existing.sentAt === undefined || (entry.sentAt !== undefined && entry.sentAt < existing.sentAt)) {
        existing.sentAt = entry.sentAt
        existing.sessionId = entry.sessionId
        existing.sessionTitle = entry.sessionTitle
        existing.workspace = entry.workspace
      }
      const existingName = existing.name ?? ''
      const candidateName = entry.name ?? ''
      if (/^image\.(png|jpe?g|gif|webp|avif)$/i.test(existingName) && candidateName !== '' && !/^image\.(png|jpe?g|gif|webp|avif)$/i.test(candidateName)) {
        existing.name = candidateName
        existing.sentAt = entry.sentAt
        existing.sessionId = entry.sessionId
        existing.sessionTitle = entry.sessionTitle
        existing.workspace = entry.workspace
      }
      if (existing.mediaType === undefined && entry.mediaType !== undefined) existing.mediaType = entry.mediaType
      if (existing.bytes === undefined && entry.bytes !== undefined) existing.bytes = entry.bytes
    }
    let list = [...merged.values()].sort((a, b) => (b.sentAt ?? 0) - (a.sentAt ?? 0) || a.name.localeCompare(b.name))
    if (Array.isArray(cache.entries) && cache.entries.length > 0) {
      const fromCache = cache.entries.filter(entry => entry !== null && typeof entry === 'object' && typeof entry.sha256 === 'string')
      if (fromCache.length > 0) list = fromCache
    }
    for (const entry of list) {
      if (entry.kind === undefined) entry.kind = kindOf(entry.mediaType, entry.name)
      if (entry.ext === undefined) entry.ext = extensionFor(entry.mediaType, entry.name)
      if (entry.available === undefined) entry.available = true
    }
    sessions = sessionMap
    sessionById = new Map()
    for (const record of Object.values(sessions)) {
      if (record?.sessionId === undefined) continue
      sessionById.set(record.sessionId, {
        sessionId: record.sessionId,
        title: record.title ?? '',
        workspace: record.cwd,
        workspaceDir: record.workspaceDir,
      })
    }
    entries = list
    bySha = new Map(list.map(entry => [entry.sha256, entry]))
    generatedAt = Number.isFinite(cache.generatedAt) ? cache.generatedAt : null
    state = 'ready'
    source = 'cache'
    stats = { sessionsReused: Object.keys(sessionMap).length, cached: true, entries: list.length }
    return true
  }

  const init = async ({ background = true } = {}) => {
    if (initPromise !== undefined) return initPromise
    initPromise = (async () => {
      const loaded = await loadCache()
      if (!loaded) {
        await rebuild()
      } else if (background) {
        schedule(() => { void rebuild() }, 250)
      }
      return status()
    })()
    return initPromise
  }

  const status = () => ({
    state,
    source,
    ready: state === 'ready',
    count: entries.length,
    generatedAt,
    ...(error === null ? {} : { error }),
    stats: stats ?? {},
  })

  const query = ({ q = '', kind = 'all', limit = 500 } = {}) => {
    const needle = String(q).trim().toLowerCase()
    const tokens = needle.split(/\s+/).filter(Boolean)
    const kinds = new Set(['all', 'pdf', 'image', 'doc', 'xlsx', 'zip', 'other'])
    const wanted = kinds.has(kind) ? kind : 'all'
    const matched = []
    for (const entry of entries) {
      if (wanted !== 'all' && entry.kind !== wanted) continue
      if (tokens.length > 0) {
        const haystack = [
          entry.name,
          entry.kind,
          entry.ext,
          entry.mediaType,
          entry.sessionTitle,
          entry.sessionId,
        ].join(' ').toLowerCase()
        if (!tokens.every(token => haystack.includes(token))) continue
      }
      matched.push(entry)
    }
    const capped = matched.slice(0, boundedInt(String(limit), 500, 1, limits.maxIndexEntries))
    return { total: matched.length, entries: capped.map(publicEntry) }
  }

  return {
    home,
    limits,
    cachePath,
    init,
    rebuild,
    ensureReady: async () => {
      await init({ background: false })
      if (state !== 'ready') await rebuild()
      return status()
    },
    query,
    get: sha => bySha.get(sha),
    sessionInfo: id => sessionById.get(id),
    entryCount: () => entries.length,
    all: () => entries,
    status,
    cacheFilePath: () => cachePath,
    iso: isoTime,
  }
}
