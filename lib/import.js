/**
 * Import an existing file from this computer into the attachment store.
 *
 * The composer's own upload is the normal path; this is the explicit fallback
 * for a surface where the file picker is unavailable. The file is copied
 * byte-for-byte into DSH's content-addressed file store and recorded in a small
 * plugin-owned manifest, so the library can list and file it without inventing
 * a session message.
 */
import { link, mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { fileObjectPathFor, fileReferenceDirFor } from './indexer.js'
import { atomicWrite, isInside, mediaTypeForName, readJson, sanitizeSegment, sha256Bytes } from './util.js'

const SHA256 = /^[a-f0-9]{64}$/
const IMPORTS_FILE = 'imports.json'

/** A refusal the route can turn into an HTTP status without guessing. */
export class ImportError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

async function writeObject(path, data) {
  await mkdir(dirname(path), { recursive: true })
  try {
    await writeFile(path, data, { flag: 'wx' })
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error
  }
}

async function writeReference(objectPath, referencePath, data) {
  await mkdir(dirname(referencePath), { recursive: true })
  try {
    await link(objectPath, referencePath)
  } catch (error) {
    if (error?.code === 'EEXIST') return
    // A filesystem without hard links (or a different volume) still gets the
    // named reference, which is what makes the original name recoverable.
    try {
      await writeFile(referencePath, data, { flag: 'wx' })
    } catch (fallback) {
      if (fallback?.code !== 'EEXIST') throw fallback
    }
  }
}

/** Read the plugin-owned imported-file manifest; malformed content is empty. */
export async function readImports(cacheDir) {
  const manifest = await readJson(join(cacheDir, IMPORTS_FILE))
  return Array.isArray(manifest?.files)
    ? manifest.files.filter(file => file !== null && typeof file === 'object' && SHA256.test(String(file.sha)))
    : []
}

/**
 * Copy one existing file into the attachment store and record it for the index.
 * @param {{home: string, cacheDir: string, limits: object}} options
 */
export function createImporter({ home, cacheDir, limits }) {
  const manifestPath = join(cacheDir, IMPORTS_FILE)

  /**
   * @param {{path: string, workspace: string, sessionId: string}} input
   * @returns {Promise<{sha: string, name: string, bytes: number, mediaType: string, importedAt: number}>}
   */
  const importFile = async ({ path, workspace, sessionId }) => {
    if (typeof path !== 'string' || path.trim() === '') {
      throw new ImportError(400, 'path is required')
    }
    const asked = path.trim()
    if (!isAbsolute(asked)) throw new ImportError(400, 'path must be absolute')
    let real
    try {
      real = await realpath(asked)
    } catch {
      throw new ImportError(404, 'file not found')
    }
    let info
    try {
      info = await stat(real)
    } catch {
      throw new ImportError(404, 'file not found')
    }
    if (!info.isFile()) throw new ImportError(400, 'path is not a regular file')
    if (info.size > limits.maxCopyBytes) {
      throw new ImportError(413, `file is larger than ${limits.maxCopyBytes} bytes`)
    }
    // A client can name any path, so the host only reads below the session
    // workspace or the user's home directory.
    const roots = [workspace, process.env.USERPROFILE, process.env.HOME].filter(root => typeof root === 'string' && root !== '')
    if (roots.length === 0 || !roots.some(root => isInside(root, real))) {
      throw new ImportError(403, 'path is outside the allowed folders')
    }
    const name = sanitizeSegment(basename(real), 'file')
    const data = await readFile(real)
    const sha = sha256Bytes(data)
    const objectPath = fileObjectPathFor(home, sha)
    await writeObject(objectPath, data)
    await writeReference(objectPath, join(fileReferenceDirFor(home, sha), name), data)

    const manifest = await readJson(manifestPath)
    const files = Array.isArray(manifest?.files) ? manifest.files : []
    const importedAt = Date.now()
    if (!files.some(file => file?.sha === sha)) {
      files.push({
        sha,
        name,
        bytes: data.length,
        mediaType: mediaTypeForName(name) ?? 'application/octet-stream',
        importedAt,
        sessionId,
        workspace,
      })
    }
    await atomicWrite(manifestPath, JSON.stringify({ version: 1, updatedAt: importedAt, files }))
    return {
      sha,
      name,
      bytes: data.length,
      mediaType: mediaTypeForName(name) ?? 'application/octet-stream',
      importedAt,
    }
  }

  return { importFile, readImports: () => readImports(cacheDir), manifestPath }
}
