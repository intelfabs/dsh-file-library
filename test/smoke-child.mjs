/**
 * Child-process smoke test: build the index and serve one same-origin request
 * with an empty PATH, no DISPLAY and no desktop helpers. Exits 0 only when the
 * whole path works on a headless host.
 */
import { createServer } from 'node:http'
import { createLibrary } from '../lib/library.js'
import { createFiler } from '../lib/filing.js'
import { createRoutes } from '../lib/routes.js'
import { createWorkspaceResolver } from '../lib/sessions.js'
import { DEFAULT_LIMITS } from '../lib/indexer.js'

const [home, workspace, sessionId] = process.argv.slice(2)
if (home === undefined) throw new Error('missing home argument')

const library = createLibrary({ home, cacheDir: `${home}/cache` })
await library.init({ background: false })
const filer = createFiler({ home, limits: DEFAULT_LIMITS })
const resolveWorkspace = createWorkspaceResolver({ home, library })
const routes = createRoutes({ library, filer, resolveWorkspace, cacheDir: `${home}/cache`, limits: DEFAULT_LIMITS })

const server = createServer((req, res) => { void routes.handle(req, res) })
await new Promise((resolve, reject) => {
  server.once('error', reject)
  server.listen(0, '127.0.0.1', resolve)
})
const port = server.address().port
const indexResponse = await fetch(`http://127.0.0.1:${port}/plugins/dsh-file-library/index?sessionId=${sessionId}`, {
  headers: { 'sec-fetch-site': 'same-origin' },
})
const index = await indexResponse.json()
const sha = index.entries?.[0]?.sha256
const fileResponse = await fetch(`http://127.0.0.1:${port}/plugins/dsh-file-library/file`, {
  method: 'POST',
  headers: { 'sec-fetch-site': 'same-origin', 'Content-Type': 'application/json' },
  body: JSON.stringify({ sha, sessionId }),
})
const filed = await fileResponse.json()
server.closeAllConnections?.()
await new Promise(resolve => server.close(resolve))
if (index.ok !== true || filed.ok !== true) {
  console.error(JSON.stringify({ index, filed }))
  process.exit(2)
}
console.log(JSON.stringify({ ok: true, count: index.count, reference: filed.reference, deduped: filed.deduped }))
