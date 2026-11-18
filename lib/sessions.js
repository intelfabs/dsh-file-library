/**
 * Resolve a session id to its workspace root using host-owned data: the current
 * index first, then the session header on disk. A client never supplies a path.
 */
import { findSessionHeader, DEFAULT_LIMITS } from './indexer.js'

export function createWorkspaceResolver(options) {
  const { home, library } = options
  const limits = { ...DEFAULT_LIMITS, ...(options.limits ?? {}) }
  const cache = new Map()
  const MAX_CACHE = 64

  return async function resolveWorkspace(sessionId) {
    if (typeof sessionId !== 'string') return undefined
    const cached = cache.get(sessionId)
    if (cached !== undefined && cached.expires > Date.now()) return cached.value

    const indexed = library.sessionInfo(sessionId)
    if (indexed?.workspace !== undefined) {
      const value = { workspace: indexed.workspace, title: indexed.title ?? '', sessionId }
      cache.set(sessionId, { value, expires: Date.now() + 30_000 })
      return value
    }
    const header = await findSessionHeader(home, sessionId, limits)
    if (header?.cwd === undefined) return undefined
    const value = { workspace: header.cwd, title: '', sessionId }
    if (cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value)
    cache.set(sessionId, { value, expires: Date.now() + 30_000 })
    return value
  }
}
