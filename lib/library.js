/**
 * In-memory library state and its size+mtime cache. The cache only holds
 * metadata derived from session logs; attachment bytes stay in DSH's store.
 */
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { buildIndex, DEFAULT_LIMITS, fileObjectPathFor, resolveHome } from './indexer.js'
import { readImports } from './import.js'
import {
  addWorkspace, atomicWrite, boundedInt, extensionFor, isoTime, kindOf, mediaTypeForName, readJson, workspaceKey,
} from './util.js'

// v2 adds `workspaces` (every distinct cwd that sent the bytes) to each row;
// a v1 cache carries only one workspace, so it is discarded and rebuilt.
// v3 changes which events count as user-origin (agent tool loops are no longer
// indexed), so an older cache holds rows this version would not create and is
// rebuilt rather than trusted.
// v4 resolves bytes from BOTH attachment stores (images and generic files) and
// derives a media type for generic files; a v3 cache has no such rows at all,
// so it is rebuilt instead of trusted.
export const CACHE_VERSION = 4

/**
 * Where one file stands for the row being rendered.
 *
 * - `filed-here`: this workspace's manifest already holds the digest.
 * - `in-workspace`: sent from this workspace, not filed here.
 * - `global`: sent from other workspaces only.
 * - `missing`: the object bytes are gone, so nothing can be read or opened.
 *
 * @param {{available?: boolean}} entry index row
 * @param {{filed?: boolean, inWorkspace?: boolean}} [options] request context
 */
export function resolveState(entry, options = {}) {
  if (entry.available === false) return 'missing'
  if (options.filed === true) return 'filed-here'
  return options.inWorkspace === true ? 'in-workspace' : 'global'
}

/**
 * Shape an index entry for the browser: no absolute paths leave the host.
 * `inWorkspace` is kept for one release (clients and tests read it); `state`
 * is the signal to use from now on.
 */
export function publicEntry(entry, options = {}) {
  const inWorkspace = options.inWorkspace === true
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
    imported: entry.imported === true,
    state: resolveState(entry, { filed: options.filed, inWorkspace }),
    /** @deprecated use `state`; kept so older clients keep working. */
    inWorkspace,
  }
}

/**
 * Coverage of the last scan, shaped for a client. `truncated` says the scan
 * stopped before every session, so the UI can say which.
 * @param {object} stats build statistics
 */
export function publicCoverage(stats) {
  const value = stats !== null && typeof stats === 'object' ? stats : {}
  const found = Number.isFinite(value.sessionsFound) ? value.sessionsFound : undefined
  const seen = Number.isFinite(value.sessionsSeen) ? value.sessionsSeen : 0
  return {
    truncated: value.truncated === true,
    sessionsSkipped: Number.isFinite(value.sessionsSkipped) ? value.sessionsSkipped : 0,
    logsTooBig: Number.isFinite(value.logsTooBig) ? value.logsTooBig : 0,
    sessionsSeen: seen,
    ...(found === undefined ? {} : { sessionsFound: found }),
  }
}

/** Does this row belong to a workspace key (all cwds that sent it count)? */
export function entryInWorkspace(entry, key) {
  const list = Array.isArray(entry.workspaces) ? entry.workspaces : []
  const values = list.length > 0
    ? list
    : (typeof entry.workspace === 'string' ? [entry.workspace] : [])
  return values.some(value => workspaceKey(value) === key)
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

  /**
   * Merge plugin-owned imported files into the current rows. An import that a
   * session log also carries is left to the log; the log's time and title win.
   */
  const applyImports = async () => {
    const imports = await readImports(cacheDir)
    let changed = false
    for (const item of imports) {
      if (bySha.has(item.sha)) continue
      const objectPath = fileObjectPathFor(home, item.sha)
      let info
      try {
        info = await stat(objectPath)
      } catch {
        continue
      }
      if (!info.isFile()) continue
      const name = typeof item.name === 'string' && item.name !== '' ? item.name : 'file'
      const mediaType = typeof item.mediaType === 'string' && item.mediaType !== ''
        ? item.mediaType
        : (mediaTypeForName(name) ?? 'application/octet-stream')
      const workspace = typeof item.workspace === 'string' ? item.workspace : undefined
      const entry = {
        sha256: item.sha,
        name,
        mediaType,
        bytes: info.size,
        sentAt: Number.isFinite(item.importedAt) ? item.importedAt : undefined,
        sessionId: typeof item.sessionId === 'string' ? item.sessionId : 'import',
        sessionTitle: 'Imported from disk',
        ...(workspace === undefined ? {} : { workspace }),
        workspaces: addWorkspace([], workspace),
        occurrences: 1,
        objectPath,
        store: 'file',
        available: true,
        imported: true,
        kind: kindOf(mediaType, name),
        ext: extensionFor(mediaType, name),
      }
      entries.push(entry)
      bySha.set(entry.sha256, entry)
      changed = true
    }
    if (changed) entries.sort((a, b) => (b.sentAt ?? 0) - (a.sentAt ?? 0) || a.name.localeCompare(b.name))
    return changed
  }

  const rebuild = async () => {
    if (buildPromise !== undefined) return buildPromise
    buildPromise = (async () => {
      try {
        const result = await buildIndex({ home, limits, previous: { sessions } })
        await apply(result)
        await applyImports()
        source = 'scan'
        error = null
        await atomicWrite(cachePath, JSON.stringify({
          version: CACHE_VERSION,
          generatedAt: result.generatedAt,
          // Coverage travels with the rows, so a warm start can still say the
          // scan was truncated instead of losing it until the next rebuild.
          stats: result.stats,
          sessions: result.sessions,
          entries,
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
        merged.set(entry.sha256, {
          ...entry,
          sessionIds: entry.sessionIds ?? [entry.sessionId],
          workspaces: addWorkspace(entry.workspaces, entry.workspace),
          occurrences: entry.occurrences ?? 1,
        })
        continue
      }
      existing.occurrences += 1
      existing.workspaces = addWorkspace(existing.workspaces, entry.workspace)
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
      if (!Array.isArray(entry.workspaces) || entry.workspaces.length === 0) {
        entry.workspaces = addWorkspace([], entry.workspace)
      }
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
    await applyImports()
    generatedAt = Number.isFinite(cache.generatedAt) ? cache.generatedAt : null
    state = 'ready'
    source = 'cache'
    const cachedStats = cache.stats !== null && typeof cache.stats === 'object' ? cache.stats : {}
    stats = {
      ...cachedStats,
      sessionsReused: Object.keys(sessionMap).length,
      cached: true,
      entries: entries.length,
    }
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

  /**
   * Filter and shape rows for one request.
   *
   * `workspace` is a host-resolved absolute path and only ever marks the rows
   * (as the path-free `inWorkspace` boolean). `onlyWorkspace` additionally
   * drops rows that were never sent to that workspace. A row sent to any one
   * of its workspaces matches, which is a strict superset of the old
   * single-workspace behaviour, so no file disappears from its own workspace.
   */
  const query = ({ q = '', kind = 'all', limit = 500, workspace, onlyWorkspace = false } = {}) => {
    const needle = String(q).trim().toLowerCase()
    const tokens = needle.split(/\s+/).filter(Boolean)
    const kinds = new Set(['all', 'pdf', 'image', 'doc', 'xlsx', 'zip', 'other'])
    const wanted = kinds.has(kind) ? kind : 'all'
    const scopeKey = workspaceKey(workspace)
    const scoped = onlyWorkspace === true && scopeKey !== undefined
    const matched = []
    for (const entry of entries) {
      const inWorkspace = scopeKey !== undefined && entryInWorkspace(entry, scopeKey)
      if (scoped && !inWorkspace) continue
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
      matched.push({ entry, inWorkspace })
    }
    const capped = matched.slice(0, boundedInt(String(limit), 500, 1, limits.maxIndexEntries))
    return {
      total: matched.length,
      entries: capped.map(({ entry, inWorkspace }) => publicEntry(entry, { inWorkspace })),
    }
  }

  return {
    home,
    limits,
    cachePath,
    init,
    rebuild,
    reloadImports: applyImports,
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
