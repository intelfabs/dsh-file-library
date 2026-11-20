/**
 * Small, dependency-free helpers shared by the host half: names, media types,
 * atomic writes and bounded hashing. Everything here works on the plain Node
 * built-ins so a container needs no toolchain.
 */
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, open, readFile, rename, rm, stat, unlink } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path'

/** True when `value` is a bare lowercase SHA-256 hex digest. */
export function isSha256(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
}

/** Strip an optional `sha256:` scheme from an attachment id. */
export function normalizeSha(value) {
  if (typeof value !== 'string') return undefined
  const bare = value.startsWith('sha256:') ? value.slice(7) : value
  return isSha256(bare) ? bare : undefined
}

/** Lowercase hex SHA-256 of a buffer or string. */
export function sha256Bytes(data) {
  return createHash('sha256').update(data).digest('hex')
}

/** Absolute-or-relative existence check that never throws. */
export async function isFile(path) {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

/** Read and parse JSON, returning `undefined` for a missing or malformed file. */
export async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch {
    return undefined
  }
}

/**
 * Atomically create or replace a UTF-8 file. A sibling temporary file is
 * written first, so a reader never observes a half-written manifest or index.
 * @param {string} path absolute destination
 * @param {string|Uint8Array} data content
 */
export async function atomicWrite(path, data) {
  await mkdir(dirname(path), { recursive: true })
  const temp = join(dirname(path), `.${basename(path)}.tmp-${process.pid}-${randomUUID()}`)
  let handle
  try {
    handle = await open(temp, 'w')
    await handle.writeFile(data)
    await handle.sync()
  } finally {
    if (handle !== undefined) await handle.close()
  }
  try {
    await rename(temp, path)
  } catch (error) {
    // Windows can refuse a replace while another process has the destination
    // open; removing the old file first keeps the operation atomic enough for
    // a single-writer cache and manifest.
    if (error?.code === 'EPERM' || error?.code === 'EEXIST') {
      await rm(path, { force: true })
      await rename(temp, path)
    } else {
      await rm(temp, { force: true })
      throw error
    }
  }
}

/** Remove a file and ignore a missing one. */
export async function removeIfExists(path) {
  try {
    await unlink(path)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
}

/**
 * Hash a file with a bounded read. The digest is only meaningful when
 * `truncated` is false.
 * @param {string} path absolute file path
 * @param {{maxBytes?: number}} [options]
 * @returns {Promise<{sha: string, bytes: number, truncated: boolean}>}
 */
export async function hashFile(path, options = {}) {
  const maxBytes = options.maxBytes ?? Number.POSITIVE_INFINITY
  const hash = createHash('sha256')
  let bytes = 0
  let truncated = false
  const stream = createReadStream(path, { highWaterMark: 1024 * 1024 })
  for await (const chunk of stream) {
    const remaining = maxBytes - bytes
    if (remaining <= 0) {
      truncated = true
      stream.destroy()
      break
    }
    const slice = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk
    hash.update(slice)
    bytes += slice.length
    if (slice.length !== chunk.length) {
      truncated = true
      stream.destroy()
      break
    }
  }
  return { sha: hash.digest('hex'), bytes, truncated }
}

const KIND_BY_EXT = new Map([
  ['pdf', 'pdf'],
  ['png', 'image'], ['jpg', 'image'], ['jpeg', 'image'], ['gif', 'image'], ['webp', 'image'], ['bmp', 'image'],
  ['svg', 'image'], ['avif', 'image'], ['heic', 'image'], ['tif', 'image'], ['tiff', 'image'], ['ico', 'image'],
  ['doc', 'doc'], ['docx', 'doc'], ['rtf', 'doc'], ['odt', 'doc'], ['md', 'doc'], ['markdown', 'doc'],
  ['txt', 'doc'], ['html', 'doc'], ['htm', 'doc'], ['pages', 'doc'],
  ['xls', 'xlsx'], ['xlsx', 'xlsx'], ['csv', 'xlsx'], ['tsv', 'xlsx'], ['ods', 'xlsx'], ['numbers', 'xlsx'],
  ['zip', 'zip'], ['gz', 'zip'], ['tgz', 'zip'], ['tar', 'zip'], ['7z', 'zip'], ['rar', 'zip'], ['bz2', 'zip'],
])

/** Classify a file into one of the v1 chips: pdf/image/doc/xlsx/zip/other. */
export function kindOf(mediaType, name) {
  const type = typeof mediaType === 'string' ? mediaType.toLowerCase() : ''
  if (type === 'application/pdf') return 'pdf'
  if (type.startsWith('image/')) return 'image'
  if (type.includes('wordprocessingml') || type === 'application/msword' || type === 'application/rtf') return 'doc'
  if (type.includes('spreadsheetml') || type === 'application/vnd.ms-excel' || type === 'text/csv') return 'xlsx'
  if (type.includes('zip') || type.includes('compressed') || type.includes('x-7z') || type.includes('x-rar')) return 'zip'
  const ext = extname(typeof name === 'string' ? name : '').slice(1).toLowerCase()
  return KIND_BY_EXT.get(ext) ?? 'other'
}

const EXT_BY_MIME = new Map([
  ['application/pdf', 'pdf'],
  ['image/png', 'png'], ['image/jpeg', 'jpg'], ['image/gif', 'gif'], ['image/webp', 'webp'],
  ['image/svg+xml', 'svg'], ['image/avif', 'avif'], ['image/bmp', 'bmp'], ['image/tiff', 'tiff'],
  ['application/msword', 'doc'],
  ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'docx'],
  ['application/rtf', 'rtf'], ['text/markdown', 'md'], ['text/plain', 'txt'], ['text/html', 'html'],
  ['application/vnd.ms-excel', 'xls'],
  ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'xlsx'],
  ['text/csv', 'csv'], ['text/tab-separated-values', 'tsv'],
  ['application/zip', 'zip'], ['application/gzip', 'gz'], ['application/x-tar', 'tar'],
  ['application/x-7z-compressed', '7z'], ['application/x-rar-compressed', 'rar'],
  ['application/json', 'json'],
])

const MIME_BY_EXT = new Map([
  ['pdf', 'application/pdf'],
  ['png', 'image/png'], ['jpg', 'image/jpeg'], ['jpeg', 'image/jpeg'], ['gif', 'image/gif'],
  ['webp', 'image/webp'], ['avif', 'image/avif'], ['bmp', 'image/bmp'], ['tif', 'image/tiff'],
  ['tiff', 'image/tiff'], ['ico', 'image/x-icon'],
  ['doc', 'application/msword'],
  ['docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  ['rtf', 'application/rtf'], ['odt', 'application/vnd.oasis.opendocument.text'],
  ['md', 'text/markdown'], ['markdown', 'text/markdown'], ['txt', 'text/plain'],
  ['html', 'text/html'], ['htm', 'text/html'], ['xml', 'application/xml'],
  ['xls', 'application/vnd.ms-excel'],
  ['xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  ['csv', 'text/csv'], ['tsv', 'text/tab-separated-values'],
  ['ods', 'application/vnd.oasis.opendocument.spreadsheet'],
  ['zip', 'application/zip'], ['gz', 'application/gzip'], ['tar', 'application/x-tar'],
  ['7z', 'application/x-7z-compressed'], ['rar', 'application/x-rar-compressed'],
  ['json', 'application/json'], ['jsonl', 'application/x-ndjson'],
])

/**
 * Best media type for a file name, or `undefined` when the suffix is unknown.
 * DSH's generic-file attachment store records only a name and a byte count, so
 * the type must come from the suffix or "Open" would always download.
 */
export function mediaTypeForName(name) {
  const ext = extname(typeof name === 'string' ? name : '').slice(1).toLowerCase()
  if (ext === '') return undefined
  return MIME_BY_EXT.get(ext)
}

/**
 * Pick a concrete extension for a stored attachment. The original name wins;
 * the media type is the fallback for a name without a suffix.
 */
export function extensionFor(mediaType, name) {
  const fromName = extname(typeof name === 'string' ? name : '').slice(1).toLowerCase()
  const known = /^[a-z0-9]{1,10}$/.test(fromName) ? fromName : ''
  if (known !== '' && !/^[0-9]+$/.test(known)) return known
  const fromType = EXT_BY_MIME.get(typeof mediaType === 'string' ? mediaType.toLowerCase() : '')
  if (fromType !== undefined) return fromType
  const kind = kindOf(mediaType, name)
  return kind === 'other' ? 'bin' : kind === 'image' ? 'png' : kind
}

/**
 * Prompt reference for a file filed at `library/<name>`.
 *
 * DSH's plain-text `@path` scan stops an unquoted token at whitespace, so a
 * name with a space (or trailing prose punctuation) is quoted as one token:
 * `@"library/Q3 review.pdf"`. Simple names stay unquoted.
 */
export function libraryReference(name) {
  const text = typeof name === 'string' && name.trim() !== '' ? name.trim() : 'file'
  const path = `library/${text.replaceAll('"', '_')}`
  const needsQuotes = /[\s"]/u.test(text) || /[.,;:!?，。；：！？]$/u.test(text)
  return needsQuotes ? `@"${path}"` : `@${path}`
}

/** A display name with any directory component removed. */
export function baseDisplayName(name, fallback = 'attachment') {
  if (typeof name !== 'string' || name.trim() === '') return fallback
  const text = name.replaceAll('\\', '/')
  const last = text.slice(text.lastIndexOf('/') + 1)
  return last.trim() === '' ? fallback : last.trim()
}

const WINDOWS_RESERVED = new Set([
  'con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9',
])

/**
 * Is a name safe to use as ONE path segment on every supported platform?
 * Rejects separators, control characters, traversal segments, absolute paths
 * and Windows device names instead of silently rewriting a hostile value.
 */
export function isSafeSegment(name) {
  if (typeof name !== 'string' || name.length === 0 || name.length > 180) return false
  if (name === '.' || name === '..') return false
  if (/[\u0000-\u001f\u007f]/.test(name)) return false
  if (/[\\/:*?"<>|]/.test(name)) return false
  if (name.endsWith('.') || name.endsWith(' ')) return false
  const stem = name.split('.')[0].toLowerCase()
  return !WINDOWS_RESERVED.has(stem)
}

/**
 * Turn a display name into a safe single segment, preserving the extension.
 * The caller must still reject a hostile original when a rejection is wanted.
 */
export function sanitizeSegment(name, fallback = 'file') {
  let text = baseDisplayName(name, fallback)
  // eslint-disable-next-line no-control-regex
  text = text.replace(/[\u0000-\u001f\u007f]/g, '')
  text = text.replace(/[\\/:*?"<>|]/g, '_')
  text = text.replace(/\s+/g, ' ').trim()
  text = text.replace(/[. ]+$/g, '')
  if (text === '' || text === '.' || text === '..') text = fallback
  if (text.length > 140) {
    const ext = extname(text)
    const stem = text.slice(0, Math.max(1, 140 - ext.length))
    text = stem + ext
  }
  const stem = text.split('.')[0].toLowerCase()
  if (WINDOWS_RESERVED.has(stem)) text = `_${text}`
  return text
}

/** Ensure `name` ends in `.ext`, replacing a numeric-only or absent suffix. */
export function withExtension(name, ext) {
  const current = extname(name).slice(1).toLowerCase()
  if (current !== '' && !/^[0-9]+$/.test(current)) return name
  return `${name}.${ext}`
}

/** Append a numeric suffix before the extension: `a.pdf` -> `a (2).pdf`. */
export function withCollisionSuffix(name, index) {
  if (index <= 1) return name
  const ext = extname(name)
  const stem = ext === '' ? name : name.slice(0, -ext.length)
  return `${stem} (${index})${ext}`
}

/** Escape text for XML/SVG content. */
export function escapeXml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

/** Escape a Markdown table cell. */
export function escapeMarkdownCell(value) {
  return String(value).replaceAll('|', '\\|').replaceAll('\n', ' ')
}

/** Parse an integer query value inside bounds. */
export function boundedInt(value, fallback, min, max) {
  const parsed = typeof value === 'string' && value.trim() !== '' ? Number(value) : Number.NaN
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(parsed)))
}

/** ISO timestamp for a millisecond epoch, or now. */
export function isoTime(ms) {
  const value = Number.isFinite(ms) ? new Date(ms) : new Date()
  return Number.isNaN(value.getTime()) ? new Date().toISOString() : value.toISOString()
}

/**
 * Canonical comparison key for a workspace path: absolute, forward slashes,
 * no trailing separator, folded to lower case on Windows. Only ever used for
 * comparison — the raw cwd string is what stays in the index and on disk.
 */
export function workspaceKey(value, platform = process.platform) {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (trimmed === '') return undefined
  let absolute
  try {
    absolute = resolve(trimmed)
  } catch {
    return undefined
  }
  const normalized = absolute.replaceAll('\\', '/')
  const stripped = normalized.replace(/\/+$/, '')
  const key = stripped === '' ? normalized : stripped
  return platform === 'win32' ? key.toLowerCase() : key
}

/**
 * Append one workspace to a deduplicated list. Two spellings of the same
 * directory (case or a trailing separator apart) collapse to one entry, and
 * the first raw spelling is kept for display.
 */
export function addWorkspace(list, value, platform = process.platform) {
  const current = Array.isArray(list) ? list : []
  const key = workspaceKey(value, platform)
  if (key === undefined) return current
  if (current.some(item => workspaceKey(item, platform) === key)) return current
  return [...current, value]
}

/** Media types the /object route may render inline; everything else downloads. */
const INLINE_MEDIA_TYPES = new Set([
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/avif',
  'text/plain',
])

/**
 * May these bytes render in the DSH GUI's own origin? An allowlist only:
 * image/svg+xml, text/html and application/xhtml+xml are deliberately absent,
 * because rendering user markup same-origin would be stored XSS.
 */
export function isInlineMediaType(mediaType) {
  return typeof mediaType === 'string' && INLINE_MEDIA_TYPES.has(mediaType.toLowerCase())
}

/** Extensions that are always human-readable text, whatever the media type says. */
const TEXT_EXTENSIONS = new Set([
  'txt', 'log', 'md', 'markdown', 'csv', 'tsv', 'json', 'jsonl', 'ndjson', 'yaml', 'yml',
  'toml', 'ini', 'cfg', 'conf', 'properties', 'xml', 'svg', 'html', 'htm', 'css', 'scss',
  'less', 'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'py', 'rb', 'php', 'go', 'rs', 'java',
  'kt', 'kts', 'swift', 'c', 'h', 'cc', 'cpp', 'hpp', 'cs', 'sh', 'bash', 'zsh', 'fish',
  'ps1', 'bat', 'cmd', 'sql', 'tex', 'r', 'lua', 'dart', 'vue', 'svelte', 'graphql', 'gql',
  'diff', 'patch', 'srt', 'vtt', 'env', 'gitignore', 'dockerfile', 'makefile',
])

/** Is this entry worth returning as UTF-8 text rather than as opaque bytes? */
export function isTextLike(mediaType, name) {
  const type = typeof mediaType === 'string' ? mediaType.toLowerCase() : ''
  if (type.startsWith('text/')) return true
  if (type === 'application/json' || type === 'application/xml' || type === 'application/xhtml+xml'
    || type === 'application/javascript' || type === 'application/ecmascript'
    || type === 'application/yaml' || type === 'application/x-yaml' || type === 'application/toml'
    || type === 'application/x-sh' || type === 'application/sql' || type === 'application/rtf'
    || type === 'image/svg+xml' || type === 'application/x-ndjson') return true
  const ext = extname(typeof name === 'string' ? name : '').slice(1).toLowerCase()
  return ext !== '' && TEXT_EXTENSIONS.has(ext)
}

/**
 * Build a Content-Disposition value with an ASCII fallback plus RFC 5987 UTF-8
 * form, so a non-ASCII original name survives without breaking old clients.
 */
export function contentDisposition(name, inline) {
  const raw = typeof name === 'string' && name.trim() !== '' ? name : 'attachment'
  const ascii = raw.replace(/[^\x20-\x7e]/g, '_').replaceAll('"', "'").replaceAll('\\', '_')
  const encoded = encodeURIComponent(raw).replaceAll("'", '%27')
  return `${inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encoded}`
}

/** True when `child` resolves inside `parent` (case-insensitive on Windows). */
export function isInside(parent, child) {
  const rel = relative(resolve(parent), resolve(child))
  if (rel === '') return true
  return !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)
}
