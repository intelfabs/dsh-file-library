/**
 * Deterministic SVG placeholders for non-image files. They are generated on
 * the host, cached under `$DSH_HOME/cache/dsh-file-library/thumbs`, and hold no
 * external references, scripts or fonts.
 */
import { escapeXml } from './util.js'

const PALETTE = {
  pdf: ['#b23a2e', '#f7e6e3', 'PDF'],
  doc: ['#2b579a', '#e6edf8', 'DOC'],
  xlsx: ['#217346', '#e3f2e9', 'XLS'],
  zip: ['#6b4fa0', '#eee8f7', 'ZIP'],
  image: ['#2e7d6b', '#e2f2ee', 'IMG'],
  other: ['#4d6478', '#e8eef3', 'FILE'],
}

function labelFor(entry) {
  const fromKind = PALETTE[entry.kind]?.[2]
  if (fromKind !== undefined && entry.kind !== 'other') return fromKind
  const ext = typeof entry.ext === 'string' ? entry.ext.toUpperCase() : ''
  return ext === '' ? 'FILE' : ext.slice(0, 5)
}

/**
 * Render one placeholder image for an index entry.
 * @param {{name: string, kind: string, ext: string, mediaType: string}} entry
 * @returns {string} standalone SVG markup
 */
export function iconSvg(entry) {
  const [ink, paper, fallback] = PALETTE[entry.kind] ?? PALETTE.other
  const label = escapeXml(labelFor(entry))
  const name = escapeXml(String(entry.name ?? 'attachment'))
  const caption = name.length > 34 ? `${name.slice(0, 31)}...` : name
  const media = escapeXml(String(entry.mediaType ?? 'application/octet-stream').slice(0, 46))
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 220" width="320" height="220" role="img" aria-label="${label} file">
  <rect width="320" height="220" rx="16" fill="${paper}"/>
  <path d="M104 34h78l42 42v108a10 10 0 0 1-10 10H104a10 10 0 0 1-10-10V44a10 10 0 0 1 10-10Z" fill="#ffffff" stroke="${ink}" stroke-opacity=".28"/>
  <path d="M182 34v32a10 10 0 0 0 10 10h32" fill="${paper}" stroke="${ink}" stroke-opacity=".28"/>
  <rect x="86" y="132" width="92" height="42" rx="8" fill="${ink}"/>
  <text x="132" y="160" text-anchor="middle" font-family="ui-sans-serif, system-ui, sans-serif" font-size="22" font-weight="700" fill="#ffffff">${label}</text>
  <text x="160" y="200" text-anchor="middle" font-family="ui-sans-serif, system-ui, sans-serif" font-size="12" fill="${ink}">${caption}</text>
  <title>${caption} — ${media}</title>
</svg>`
}
