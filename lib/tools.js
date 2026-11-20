/**
 * Agent-facing tools. They share the same library and filer as the sidebar, so
 * an agent can search, read and file a file without the user wording it.
 *
 * Wording rule shared with the UI: stream or read to view, file a copy to edit.
 */
import { open, stat } from 'node:fs/promises'
import { entryInWorkspace, publicCoverage } from './library.js'
import { isAttachmentObjectPath } from './indexer.js'
import { isSha256, isTextLike, workspaceKey } from './util.js'

/** Text cap for one `library_read`; a binary is never returned as bytes. */
export const DEFAULT_READ_BYTES = 256 * 1024
export const MAX_READ_BYTES = 1024 * 1024

/** Ordering shared by every candidate list: newest first, then by name. */
function newestFirst(left, right) {
  return (right.sentAt ?? 0) - (left.sentAt ?? 0) || String(left.name).localeCompare(String(right.name))
}

function isoTime(value) {
  return Number.isFinite(value) ? new Date(value).toISOString() : null
}

function text(value) {
  return [{ type: 'text', text: value }]
}

function stateOf(entry, options = {}) {
  if (entry.available === false) return 'missing'
  if (options.filed === true) return 'filed-here'
  return options.inWorkspace === true ? 'in-workspace' : 'global'
}

/**
 * Shape one row for a tool result. No absolute path ever reaches the agent.
 * @param {object} entry index row
 * @param {{filed?: boolean, inWorkspace?: boolean}} [options]
 */
export function publicRow(entry, options = {}) {
  return {
    sha256: entry.sha256,
    name: entry.name,
    kind: entry.kind,
    mediaType: entry.mediaType,
    bytes: entry.bytes,
    sentAt: isoTime(entry.sentAt),
    sessionTitle: entry.sessionTitle ?? '',
    occurrences: entry.occurrences ?? 1,
    state: stateOf(entry, options),
  }
}

/**
 * Resolve `nameOrSha` to exactly one entry, or report why it is ambiguous.
 *
 * Two different files can share one exact name; that is ambiguity, never a
 * silent first match. A SHA prefix with several hits is ambiguity too.
 *
 * @param {ReturnType<typeof import('./library.js').createLibrary>} library
 * @param {string} nameOrSha full SHA, SHA prefix, exact name, or name substring
 * @returns {{entry?: object, matches: object[], ambiguity?: string}}
 */
export function findEntry(library, nameOrSha) {
  const needle = String(nameOrSha ?? '').trim()
  if (needle === '') throw new Error('nameOrSha is required')
  const lower = needle.toLowerCase()
  if (isSha256(lower)) {
    const exact = library.get(lower)
    return exact === undefined ? { entry: undefined, matches: [] } : { entry: exact, matches: [exact] }
  }
  if (/^[a-f0-9]{6,64}$/.test(lower)) {
    const matches = library.all().filter(entry => entry.sha256.startsWith(lower))
    if (matches.length === 1) return { entry: matches[0], matches }
    return { entry: undefined, matches, ...(matches.length > 1 ? { ambiguity: 'sha-prefix' } : {}) }
  }
  const exactName = library.all().filter(entry => entry.name.toLowerCase() === lower)
  if (exactName.length === 1) return { entry: exactName[0], matches: exactName }
  if (exactName.length > 1) return { entry: undefined, matches: exactName, ambiguity: 'exact-name' }
  const bySubstring = library.all().filter(entry => entry.name.toLowerCase().includes(lower))
  if (bySubstring.length === 1) return { entry: bySubstring[0], matches: bySubstring }
  return { entry: undefined, matches: bySubstring, ...(bySubstring.length > 1 ? { ambiguity: 'name' } : {}) }
}

/**
 * Rank the candidates for an ambiguous request: exact names first, then the
 * most recently sent. Capped at 10 so a broad substring stays readable.
 */
export function candidateRows(matches, options = {}) {
  const exact = (entry) => (String(entry.name).toLowerCase() === String(options.needle ?? '').toLowerCase() ? 0 : 1)
  return matches
    .slice()
    .sort((left, right) => exact(left) - exact(right) || newestFirst(left, right))
    .slice(0, 10)
    .map(entry => ({
      sha8: entry.sha256.slice(0, 8),
      sha256: entry.sha256,
      name: entry.name,
      bytes: entry.bytes ?? 0,
      sentAt: isoTime(entry.sentAt),
      sessionTitle: entry.sessionTitle ?? '',
      state: stateOf(entry, options),
    }))
}

function ambiguousResult(resolved, options = {}) {
  return {
    ambiguous: true,
    candidates: candidateRows(resolved.matches, { ...options, needle: options.needle }),
    hint: 'Several files match. Call again with the sha8 of the one you mean.',
  }
}

/** Session workspace, the set of filed digests, and the raw session record. */
async function contextFor(exec, filer) {
  const session = exec?.agent?.session
  const cwd = session?.header?.cwd
  const workspace = typeof cwd === 'string' && cwd.trim() !== '' ? cwd : undefined
  let filed = new Set()
  if (workspace !== undefined) {
    try {
      const manifest = await filer.readManifest(workspace)
      filed = new Set(manifest.files.map(file => file.sha))
    } catch {
      // A corrupt manifest must not hide the rest of the library.
    }
  }
  return { session, workspace, filed }
}

/** Read at most `maxBytes` from the head of one object. */
async function readHead(objectPath, maxBytes) {
  const handle = await open(objectPath, 'r')
  try {
    const buffer = Buffer.alloc(maxBytes)
    const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0)
    return buffer.subarray(0, bytesRead)
  } finally {
    await handle.close()
  }
}

/**
 * Build the tool definitions for registration through `ctx.tools.register`.
 * Plain objects are used so the host half imports no DSH package.
 */
export function createToolDefinitions(deps) {
  const { library, filer, resolveWorkspace } = deps

  const list = {
    name: 'library_list',
    description:
      'Search the file library: files the user has sent to DSH. By default only files that belong to this session\'s workspace are listed; pass scope "all" to search every session on this host. Returns each file\'s SHA-256, original name, media type, size, sending time, source session and its state. Use it to find a file to read with library_read (no copy) or to file into the workspace with library_use.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Case-insensitive words matched against name, type, extension and source session title.' },
        kind: { type: 'string', enum: ['all', 'pdf', 'image', 'doc', 'xlsx', 'zip', 'other'], description: 'Restrict to one file type.' },
        scope: {
          type: 'string',
          enum: ['workspace', 'all'],
          description: 'Which files to search: "workspace" (default when this session has a workspace) or "all" for every session on the host.',
        },
        limit: { type: 'integer', minimum: 1, maximum: 100, description: 'Maximum rows to return (default 20).' },
      },
      additionalProperties: false,
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => text(JSON.stringify(value, null, 2)),
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const status = await library.ensureReady()
      if (status.state !== 'ready') throw new Error(`file library index is not ready (${status.state})`)
      const limit = Math.min(100, Math.max(1, Number.isFinite(args?.limit) ? Math.trunc(args.limit) : 20))
      // The workspace comes from the agent session header the host already
      // owns; the tool argument only ever chooses between two named scopes.
      const { workspace, filed } = await contextFor(exec, filer)
      const requested = args?.scope
      const scope = requested === 'all' || requested === 'workspace'
        ? requested
        : (workspace === undefined ? 'all' : 'workspace')
      const result = library.query({
        q: args?.query ?? '',
        kind: args?.kind ?? 'all',
        limit,
        workspace,
        onlyWorkspace: scope === 'workspace',
      })
      return {
        scope,
        count: result.entries.length,
        total: result.total,
        coverage: publicCoverage(status.stats),
        entries: result.entries.map(row => ({
          sha256: row.sha256,
          name: row.name,
          kind: row.kind,
          mediaType: row.mediaType,
          bytes: row.bytes,
          sentAt: isoTime(row.sentAt),
          sessionTitle: row.sessionTitle,
          occurrences: row.occurrences,
          state: filed.has(row.sha256) ? 'filed-here' : row.state,
        })),
        hint: 'Read one without copying it with library_read, or file a copy with library_use. Look for state "missing" before relying on a row: its bytes are gone from this host.',
      }
    },
  }

  const read = {
    name: 'library_read',
    description:
      'Read one library file without copying it into the workspace. Text-like files (plain text, Markdown, JSON, CSV, source code, XML) come back as UTF-8 text, capped and marked truncated. PDFs, Office documents, archives and images return metadata plus a hint instead of bytes. Nothing is written to disk. To edit a file, call library_use first and work on the copy.',
    parameters: {
      type: 'object',
      properties: {
        nameOrSha: { type: 'string', description: 'A SHA-256, a SHA prefix (8 characters is enough), the exact original file name, or a unique part of it.' },
        maxBytes: {
          type: 'integer',
          minimum: 1,
          maximum: MAX_READ_BYTES,
          description: `Maximum text bytes to return (default ${DEFAULT_READ_BYTES}, hard cap ${MAX_READ_BYTES}).`,
        },
      },
      required: ['nameOrSha'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => text(JSON.stringify(value, null, 2)),
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      await library.ensureReady()
      const { workspace, filed } = await contextFor(exec, filer)
      const resolved = findEntry(library, args?.nameOrSha)
      if (resolved.entry === undefined) {
        if (resolved.matches.length > 1) return ambiguousResult(resolved, { filed, needle: args?.nameOrSha })
        throw new Error('no library file matches that name or SHA')
      }
      const entry = resolved.entry
      const key = workspaceKey(workspace)
      const inWorkspace = key !== undefined && entryInWorkspace(entry, key)
      const row = publicRow(entry, { filed: filed.has(entry.sha256), inWorkspace })
      const objectPath = entry.objectPath
      if (!isAttachmentObjectPath(library.home, objectPath, entry.sha256)) {
        throw new Error('attachment object path is outside the attachment store')
      }
      const info = await stat(objectPath).catch(() => undefined)
      if (info === undefined || !info.isFile()) {
        return {
          state: 'missing',
          sha256: entry.sha256,
          name: entry.name,
          message: 'The attachment bytes are missing from this host, so nothing can be read or filed.',
        }
      }
      const requested = Number.isFinite(args?.maxBytes) ? Math.trunc(args.maxBytes) : DEFAULT_READ_BYTES
      const cap = Math.min(MAX_READ_BYTES, Math.max(1, requested))
      const bytesTotal = info.size
      const base = {
        state: row.state,
        sha256: entry.sha256,
        name: entry.name,
        kind: entry.kind,
        mediaType: entry.mediaType ?? 'application/octet-stream',
        bytesTotal,
      }
      if (!isTextLike(entry.mediaType, entry.name)) {
        return {
          ...base,
          truncated: false,
          text: null,
          hint: entry.kind === 'image'
            ? 'Image bytes are not returned by this tool. Call library_use to file a copy into the workspace, then read_image it, or view it in the sidebar with Open.'
            : 'Call library_use to file a copy into the workspace, then read it with the normal file tools.',
        }
      }
      const data = await readHead(objectPath, Math.min(cap, bytesTotal))
      const truncated = bytesTotal > data.length
      return {
        ...base,
        bytes: data.length,
        truncated,
        text: data.toString('utf8'),
        ...(truncated
          ? { hint: `The file is larger than the read cap; only the first ${data.length} of ${bytesTotal} bytes are included. Raise maxBytes (hard cap ${MAX_READ_BYTES}) or call library_use to read the copy with the file tools.` }
          : {}),
      }
    },
  }

  const use = {
    name: 'library_use',
    description:
      'File one library file into the current session workspace at library/<name> and return the @library/<name> reference to use in a prompt. Filing the same file again is a no-op. Use this when the file must be edited or needs a real on-disk path; to only view a text file, library_read copies nothing. Use the SHA-256, a SHA prefix, or a distinctive part of the original name.',
    parameters: {
      type: 'object',
      properties: {
        nameOrSha: { type: 'string', description: 'A SHA-256, a SHA prefix, the exact original file name, or a unique part of it.' },
      },
      required: ['nameOrSha'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => text(JSON.stringify(value, null, 2)),
    },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      await library.ensureReady()
      const { workspace, filed } = await contextFor(exec, filer)
      const resolved = findEntry(library, args?.nameOrSha)
      if (resolved.entry === undefined) {
        if (resolved.matches.length > 1) return ambiguousResult(resolved, { filed, needle: args?.nameOrSha })
        throw new Error('no library file matches that name or SHA')
      }
      const entry = resolved.entry
      const session = exec?.agent?.session
      if (typeof workspace !== 'string' || workspace === '') {
        throw new Error('no session workspace is available to file into')
      }
      const filedResult = await filer.fileThis({
        entry,
        workspace,
        source: { sessionId: String(session?.id ?? ''), title: entry.sessionTitle ?? '' },
        signal: exec?.signal,
      })
      return {
        sha256: filedResult.sha,
        name: filedResult.name,
        relativePath: filedResult.relativePath,
        reference: filedResult.reference,
        bytes: filedResult.bytes,
        deduped: filedResult.deduped,
        hint: `The file now exists in this workspace at ${filedResult.relativePath}. Reference it as ${filedResult.reference}.`,
      }
    },
  }

  // Keep the resolver reachable for a future tool that needs it without an
  // agent session (for example a cross-session file command).
  void resolveWorkspace
  return [list, read, use]
}
