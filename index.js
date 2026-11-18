/**
 * dsh-file-library — host half.
 *
 * Reads the DSH attachment objects and v4 session logs into a searchable
 * metadata index, serves same-origin routes on the host's existing web server,
 * and registers two agent tools. No second listener, no native module, no
 * desktop-only utility.
 */
import { join } from 'node:path'
import { createLibrary } from './lib/library.js'
import { createFiler } from './lib/filing.js'
import { createRoutes, ROUTE_PREFIX } from './lib/routes.js'
import { createWorkspaceResolver } from './lib/sessions.js'
import { createToolDefinitions } from './lib/tools.js'
import { DEFAULT_LIMITS, resolveHome } from './lib/indexer.js'

/** Cordis plugin name; must match the row id in cordis.patch.yml. */
export const name = 'dsh-file-library'

/**
 * @param {object} ctx Cordis host context
 * @param {{home?: string, cacheDir?: string, limits?: object}} [config]
 */
export function apply(ctx, config = {}) {
  const home = resolveHome(config.home)
  const limits = { ...DEFAULT_LIMITS, ...(config.limits ?? {}) }
  const cacheDir = config.cacheDir ?? join(home, 'cache', 'dsh-file-library')

  const library = createLibrary({ home, limits, cacheDir })
  const filer = createFiler({ home, limits })
  const resolveWorkspace = createWorkspaceResolver({ home, library, limits })
  const routes = createRoutes({ library, filer, resolveWorkspace, cacheDir, limits })

  // Warm from cache immediately; a cold install builds once in the background
  // so plugin activation never blocks the host boot on a large log scan.
  void library.init({ background: true }).catch(() => undefined)

  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'prefix',
      path: ROUTE_PREFIX,
      handler: (req, res) => routes.handle(req, res),
    }), 'dsh-file-library: same-origin routes')
  })

  ctx.inject(['tools'], (toolCtx) => {
    toolCtx.effect(() => {
      const definitions = createToolDefinitions({ library, filer, resolveWorkspace })
      const disposers = definitions.map(definition => toolCtx.tools.register(definition))
      return () => {
        for (const dispose of disposers) dispose()
      }
    }, 'dsh-file-library: agent tools')
  })

  return {
    home,
    cacheDir,
    library,
    filer,
    routes,
  }
}
