/**
 * Agent-facing tools. They share the same library and filer as the sidebar, so
 * an agent can search, file and reference a file without the user wording it.
 */
import { isSha256 } from './util.js'

function text(value) {
  return [{ type: 'text', text: value }]
}

function publicRow(entry) {
  return {
    sha256: entry.sha256,
    name: entry.name,
    kind: entry.kind,
    mediaType: entry.mediaType,
    bytes: entry.bytes,
    sentAt: entry.sentAt === undefined || entry.sentAt === null ? null : new Date(entry.sentAt).toISOString(),
    sessionTitle: entry.sessionTitle ?? '',
    occurrences: entry.occurrences ?? 1,
  }
}

function findEntry(library, nameOrSha) {
  const needle = String(nameOrSha ?? '').trim()
  if (needle === '') throw new Error('nameOrSha is required')
  const lower = needle.toLowerCase()
  if (isSha256(lower)) {
    const exact = library.get(lower)
    if (exact !== undefined) return { entry: exact, matches: [exact] }
  }
  if (/^[a-f0-9]{6,64}$/.test(lower)) {
    const matches = library.all().filter(entry => entry.sha256.startsWith(lower))
    if (matches.length === 1) return { entry: matches[0], matches }
    if (matches.length > 1) return { entry: undefined, matches }
  }
  const byName = library.all().filter(entry => entry.name.toLowerCase() === lower)
  if (byName.length >= 1) return { entry: byName[0], matches: byName }
  const bySubstring = library.all().filter(entry => entry.name.toLowerCase().includes(lower))
  if (bySubstring.length === 1) return { entry: bySubstring[0], matches: bySubstring }
  return { entry: undefined, matches: bySubstring }
}

/**
 * Build the two tool definitions for registration through `ctx.tools.register`.
 * Plain objects are used so the host half imports no DSH package.
 */
export function createToolDefinitions(deps) {
  const { library, filer, resolveWorkspace } = deps

  const list = {
    name: 'library_list',
    description:
      'Search the file library: files the user has sent to DSH in any session. Returns each file\'s SHA-256, original name, media type, size, sending time and source session. Use it to find a file to reference with @library/<name> or to file into the workspace with library_use.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Case-insensitive words matched against name, type, extension and source session title.' },
        kind: { type: 'string', enum: ['all', 'pdf', 'image', 'doc', 'xlsx', 'zip', 'other'], description: 'Restrict to one file type.' },
        limit: { type: 'integer', minimum: 1, maximum: 100, description: 'Maximum rows to return (default 20).' },
      },
      additionalProperties: false,
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => text(JSON.stringify(value, null, 2)),
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      const status = await library.ensureReady()
      if (status.state !== 'ready') throw new Error(`file library index is not ready (${status.state})`)
      const limit = Math.min(100, Math.max(1, Number.isFinite(args?.limit) ? Math.trunc(args.limit) : 20))
      const result = library.query({ q: args?.query ?? '', kind: args?.kind ?? 'all', limit })
      return {
        count: result.entries.length,
        total: result.total,
        entries: result.entries.map(publicRow),
        hint: 'Call library_use with a name or SHA to file it into this session\'s workspace and get an @library/<name> reference.',
      }
    },
  }

  const use = {
    name: 'library_use',
    description:
      'File one library file into the current session workspace at library/<name> and return the @library/<name> reference to use in a prompt. Filing the same file again is a no-op. Use the SHA-256 or a distinctive part of the original name.',
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
      const { entry, matches } = findEntry(library, args?.nameOrSha)
      if (entry === undefined) {
        if (matches.length > 1) {
          const names = matches.slice(0, 5).map(candidate => `${candidate.name} (${candidate.sha256.slice(0, 10)})`)
          throw new Error(`name is ambiguous; matches: ${names.join(', ')}`)
        }
        throw new Error('no library file matches that name or SHA')
      }
      const session = exec?.agent?.session
      const workspace = session?.header?.cwd
      if (typeof workspace !== 'string' || workspace === '') {
        throw new Error('no session workspace is available to file into')
      }
      const filed = await filer.fileThis({
        entry,
        workspace,
        source: { sessionId: String(session?.id ?? ''), title: entry.sessionTitle ?? '' },
        signal: exec?.signal,
      })
      return {
        sha256: filed.sha,
        name: filed.name,
        relativePath: filed.relativePath,
        reference: filed.reference,
        bytes: filed.bytes,
        deduped: filed.deduped,
        hint: `The file now exists in this workspace at ${filed.relativePath}. Reference it as ${filed.reference}.`,
      }
    },
  }

  // Keep the resolver reachable for a future tool that needs it without an
  // agent session (for example a cross-session file command).
  void resolveWorkspace
  return [list, use]
}
