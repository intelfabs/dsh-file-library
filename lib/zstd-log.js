/**
 * Reading DSH v4 session logs.
 *
 * The durable log is a concatenation of independently decompressible Zstandard
 * frames, one per append. `zlib.zstdDecompressSync` decodes exactly one frame,
 * so the file is first walked structurally (magic, frame header, block headers)
 * and each complete frame is decompressed on its own. A torn final frame, which
 * is normal while an append is in flight, contributes only the frames before it.
 */
import { zstdDecompressSync } from 'node:zlib'

const ZSTD_MAGIC = 0xfd2fb528n

/**
 * Structural scan of a concatenated Zstandard stream.
 * @param {Buffer} buffer complete bytes currently present
 * @param {{maxFrames?: number}} [options]
 * @returns {{frames: Array<{start: number, end: number}>, tornStart?: number}}
 */
export function scanZstdFrames(buffer, options = {}) {
  const maxFrames = options.maxFrames ?? Number.POSITIVE_INFINITY
  const frames = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) return { frames, tornStart: start }
    if (buffer.readUInt32LE(offset) !== Number(ZSTD_MAGIC)) {
      throw new Error(`invalid Zstandard frame magic at byte ${offset}`)
    }
    offset += 4
    if (offset >= buffer.length) return { frames, tornStart: start }

    const descriptor = buffer.readUInt8(offset)
    offset += 1
    if ((descriptor & 0x18) !== 0) {
      throw new Error(`reserved Zstandard frame-header bit at byte ${offset - 1}`)
    }
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 0x20) !== 0
    const checksum = (descriptor & 0x04) !== 0
    const dictionaryFlag = descriptor & 0x03
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0
      ? (singleSegment ? 1 : 0)
      : 1 << contentSizeFlag
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start }
    offset += remainingHeaderBytes

    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start }
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 0x03
      const blockSize = blockHeader >>> 3
      if (blockType === 0x03) {
        throw new Error(`reserved Zstandard block type at byte ${offset - 3}`)
      }
      const payloadBytes = blockType === 0x01 ? 1 : blockSize
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start }
      offset += payloadBytes
      if (lastBlock) break
    }
    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start }
      offset += 4
    }
    frames.push({ start, end: offset })
    if (frames.length >= maxFrames) return { frames }
  }
  return { frames }
}

/**
 * Decode a whole session log.
 * @param {Buffer} buffer file bytes
 * @param {{maxFrames?: number, maxBytes?: number}} [options]
 * @returns {{text: string, frames: number, tornStart?: number, error?: string}}
 */
export function decodeZstdLog(buffer, options = {}) {
  if (buffer.length === 0) return { text: '', frames: 0 }
  // A plain-JSONL artifact (compression: none) still parses, which keeps the
  // reader useful for a deployment that turned compression off.
  if (buffer[0] === 0x7b || buffer[0] === 0x0a) {
    return { text: buffer.toString('utf8'), frames: 0 }
  }
  let scan
  try {
    scan = scanZstdFrames(buffer, { maxFrames: options.maxFrames })
  } catch (error) {
    return { text: '', frames: 0, error: error instanceof Error ? error.message : String(error) }
  }
  const parts = []
  let decoded = 0
  for (const frame of scan.frames) {
    try {
      parts.push(zstdDecompressSync(buffer.subarray(frame.start, frame.end)).toString('utf8'))
      decoded += 1
    } catch (error) {
      return {
        text: parts.join(''),
        frames: decoded,
        ...(scan.tornStart === undefined ? {} : { tornStart: scan.tornStart }),
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }
  return {
    text: parts.join(''),
    frames: decoded,
    ...(scan.tornStart === undefined ? {} : { tornStart: scan.tornStart }),
  }
}

/**
 * Parse JSONL text, keeping the line index for diagnostics and ignoring a
 * half-written or otherwise invalid trailing line.
 * @param {string} text decoded log
 * @returns {Array<{line: number, event: object}>}
 */
export function parseLogLines(text, options = {}) {
  const includeLine = options.includeLine
  const events = []
  const lines = text.split('\n')
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim()
    if (line === '') continue
    if (typeof includeLine === 'function' && !includeLine(line)) continue
    try {
      const event = JSON.parse(line)
      if (event !== null && typeof event === 'object' && !Array.isArray(event)) {
        events.push({ line: index + 1, event })
      }
    } catch {
      // A partial or foreign line is skipped, never fatal for the index.
    }
  }
  return events
}
