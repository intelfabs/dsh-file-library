/* global window, document, fetch, navigator, localStorage, ResizeObserver, Element */
/**
 * dsh-file-library — browser half.
 *
 * Registers a new right-sidebar tab type (`library`), renders the searchable
 * grid/list, files an object into the current workspace and inserts an
 * `@library/<name>` reference into that session's composer. It uses only the
 * React instance and the services DSH already provides.
 */
window.__ModuleLoader__.load({
  id: 'dsh-file-library',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useRef, useState } = React

    const ID = 'dsh-file-library'
    const KIND = 'library'
    const ROUTE = '/plugins/dsh-file-library'
    const KINDS = ['all', 'pdf', 'image', 'doc', 'xlsx', 'zip', 'other']
    const KIND_LABEL = {
      all: 'All', pdf: 'PDF', image: 'Images', doc: 'Docs', xlsx: 'Sheets', zip: 'Archives', other: 'Other',
    }

    // One tab browses its own workspace by default; the whole-library view is
    // an explicit second choice, remembered per browser for the next open.
    const SCOPES = ['workspace', 'all']
    /** Legacy global key; only read to delete it (see readScopePreference). */
    const SCOPE_STORAGE_KEY = 'dsh-file-library:scope'
    const SCOPE_FALLBACK_REASON = {
      'no-session': 'no session is attached to this tab',
      'invalid-session': 'the session id is not usable',
      'unknown-session': 'this session has no resolvable workspace',
      'http-404': 'the host did not return a scoped list',
    }

    function scopeStore(storage) {
      if (storage !== undefined && storage !== null) return storage
      return typeof localStorage === 'undefined' ? undefined : localStorage
    }

    /** One scope per chat, so a choice made elsewhere cannot widen this one. */
    function scopeStorageKey(sessionId) {
      const id = typeof sessionId === 'string' && sessionId !== '' ? sessionId : 'default'
      return `${SCOPE_STORAGE_KEY}:${id}`
    }

    /**
     * The remembered scope for this chat; defaults to this workspace.
     *
     * Before 0.2.3 one global key held the choice, so clicking "All files" once
     * made every later chat show other workspaces' files. That key is dropped
     * instead of inherited, which returns every chat to its own workspace.
     */
    function readScopePreference(sessionId, storage) {
      const store = scopeStore(storage)
      if (store === undefined) return 'workspace'
      try {
        const value = store.getItem(scopeStorageKey(sessionId))
        if (value === 'all' || value === 'workspace') return value
        store.removeItem(SCOPE_STORAGE_KEY)
        return 'workspace'
      } catch {
        return 'workspace'
      }
    }

    /** Persist this chat's scope choice; denied storage (private mode) is not fatal. */
    function saveScopePreference(sessionId, scope, storage) {
      const wanted = scope === 'all' ? 'all' : 'workspace'
      const store = scopeStore(storage)
      if (store === undefined) return wanted
      try {
        store.setItem(scopeStorageKey(sessionId), wanted)
      } catch {
        // The in-memory scope still applies for this page.
      }
      return wanted
    }

    function scopeFallbackText(reason) {
      return `Showing all files instead — ${SCOPE_FALLBACK_REASON[reason] ?? reason}.`
    }

    let clientCtx = null

    /* ---------------------------------------------------------------- URL -- */

    function appRoot() {
      if (typeof document === 'undefined') return '/'
      try {
        const base = new URL(document.baseURI)
        let pathname = base.pathname
        if (!pathname.endsWith('/')) pathname = pathname.slice(0, pathname.lastIndexOf('/') + 1)
        return pathname
      } catch {
        return '/'
      }
    }

    function apiUrl(relative) {
      const root = appRoot().replace(/\/+$/, '')
      return `${root}${ROUTE}/${String(relative).replace(/^\/+/, '')}`
    }

    async function getJson(relative, signal) {
      const response = await fetch(apiUrl(relative), {
        method: 'GET',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { Accept: 'application/json' },
        ...(signal === undefined ? {} : { signal }),
      })
      const body = await response.json().catch(() => ({}))
      if (!response.ok) {
        const error = new Error(body?.error ?? `HTTP ${response.status}`)
        error.status = response.status
        throw error
      }
      return body
    }

    /**
     * The one index request the tab makes. `scope` is a name, never a path:
     * the host resolves the workspace from the session id on its side.
     */
    function indexQuery(sessionId, scope) {
      const wanted = scope === 'all' ? 'all' : 'workspace'
      return `index?sessionId=${encodeURIComponent(sessionId)}&scope=${wanted}&limit=2000`
    }

    async function postJson(relative, payload) {
      const response = await fetch(apiUrl(relative), {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(payload),
      })
      const body = await response.json().catch(() => ({}))
      if (!response.ok) {
        const error = new Error(body?.error ?? `HTTP ${response.status}`)
        error.status = response.status
        throw error
      }
      return body
    }

    /* ------------------------------------------------------------- format -- */

    function formatBytes(bytes) {
      const value = Number(bytes)
      if (!Number.isFinite(value) || value < 0) return ''
      if (value < 1024) return `${value} B`
      if (value < 1024 * 1024) return `${(value / 1024).toFixed(value < 10 * 1024 ? 1 : 0)} KB`
      if (value < 1024 * 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(value < 10 * 1024 * 1024 ? 1 : 0)} MB`
      return `${(value / (1024 * 1024 * 1024)).toFixed(1)} GB`
    }

    const RELATIVE_UNITS = [
      ['year', 365 * 24 * 60 * 60 * 1000],
      ['month', 30 * 24 * 60 * 60 * 1000],
      ['week', 7 * 24 * 60 * 60 * 1000],
      ['day', 24 * 60 * 60 * 1000],
      ['hour', 60 * 60 * 1000],
      ['minute', 60 * 1000],
    ]

    /** "sent 3 months ago" for an epoch-millisecond timestamp. */
    function relativeTime(ms, now = Date.now()) {
      const value = Number(ms)
      if (!Number.isFinite(value) || value <= 0) return 'sent at an unknown time'
      const delta = Math.max(0, now - value)
      if (delta < 60 * 1000) return 'sent just now'
      for (const [unit, size] of RELATIVE_UNITS) {
        if (delta >= size) {
          const count = Math.max(1, Math.floor(delta / size))
          try {
            const text = new Intl.RelativeTimeFormat('en', { numeric: 'auto' }).format(-count, unit)
            return `sent ${text}`
          } catch {
            return `sent ${count} ${unit}${count === 1 ? '' : 's'} ago`
          }
        }
      }
      return 'sent just now'
    }

    function thumbUrl(sha) {
      return apiUrl(`thumb/${sha}`)
    }

    /** Raw bytes of one indexed object; opened in a new tab, never filed. */
    function objectUrl(sha) {
      return apiUrl(`object/${sha}`)
    }

    /** Banner text for a scan that stopped before every session. */
    function coverageText(coverage) {
      const value = coverage ?? {}
      const found = Number(value.sessionsFound)
      if (Number.isFinite(found) && found > 0) {
        const seen = Number.isFinite(Number(value.sessionsSeen)) ? Number(value.sessionsSeen) : 0
        return `The index covers ${seen} of ${found} sessions.`
      }
      return 'Some sessions were not indexed because of scan limits.'
    }

    /* -------------------------------------------------------------- model -- */

    function countsByKind(entries) {
      const counts = { all: entries.length }
      for (const kind of KINDS.slice(1)) counts[kind] = 0
      for (const entry of entries) {
        if (Object.hasOwn(counts, entry.kind)) counts[entry.kind] += 1
      }
      return counts
    }

    function filterEntries(entries, query, kind) {
      const tokens = String(query).toLowerCase().trim().split(/\s+/).filter(Boolean)
      return entries.filter(entry => {
        if (kind !== 'all' && entry.kind !== kind) return false
        if (tokens.length === 0) return true
        const haystack = [entry.name, entry.kind, entry.ext, entry.sessionTitle, entry.mediaType, ...(entry.tags ?? [])].join(' ').toLowerCase()
        return tokens.every(token => haystack.includes(token))
      })
    }

    /** Pure view model; exported for DOM-free layout tests. */
    function buildModel(input) {
      const entries = Array.isArray(input.entries) ? input.entries : []
      const visible = filterEntries(entries, input.query ?? '', input.kind ?? 'all')
      return {
        entries: visible,
        allEntries: entries,
        counts: countsByKind(entries),
        width: Number(input.width) > 0 ? Number(input.width) : 768,
        fullscreen: input.fullscreen === true,
        view: input.view === 'list' ? 'list' : 'grid',
        query: input.query ?? '',
        kind: input.kind ?? 'all',
        sessionId: input.sessionId ?? '',
        searchRef: input.searchRef,
        selected: Array.isArray(input.selected) ? input.selected : [],
        active: Number.isFinite(input.active) ? Math.min(Math.max(0, input.active), Math.max(0, visible.length - 1)) : 0,
        loading: input.loading === true,
        error: input.error ?? null,
        toast: input.toast ?? null,
        filedCount: Number(input.filedCount) || 0,
        scope: input.scope === 'all' ? 'all' : 'workspace',
        scopeFallback: typeof input.scopeFallback === 'string' && input.scopeFallback !== '' ? input.scopeFallback : null,
        coverage: input.coverage ?? null,
        importOpen: input.importOpen === true,
        importPath: typeof input.importPath === 'string' ? input.importPath : '',
        importing: input.importing === true,
        foreignCount: Number.isFinite(Number(input.foreignCount))
          ? Math.max(0, Math.trunc(Number(input.foreignCount)))
          : entries.filter(entry => entry.state === 'global').length,
        totalAll: Number.isFinite(Number(input.totalAll)) ? Math.max(0, Math.trunc(Number(input.totalAll))) : entries.length,
        now: Number(input.now) || Date.now(),
        handlers: input.handlers ?? {},
        emptyLibrary: entries.length === 0,
      }
    }

    function chip(kind, count, current, onKind) {
      return h('button', {
        type: 'button',
        key: kind,
        className: `dfl-chip${current === kind ? ' is-active' : ''}`,
        'aria-pressed': current === kind,
        'data-dfl-chip': kind,
        onClick: () => onKind(kind),
      }, KIND_LABEL[kind], h('span', { className: 'dfl-chip-count' }, String(count)))
    }

    function thumb(entry, model) {
      const fallback = h('span', { className: 'dfl-thumb-fallback', 'aria-hidden': 'true' },
        h('span', { className: 'dfl-type' }, (entry.ext || 'file').toUpperCase().slice(0, 5)))
      if (entry.kind !== 'image') return h('span', { className: 'dfl-thumb' }, fallback)
      return h('span', { className: 'dfl-thumb' },
        fallback,
        h('img', {
          className: 'dfl-thumb-img',
          src: thumbUrl(entry.sha256),
          alt: '',
          loading: 'lazy',
          decoding: 'async',
          onError: event => {
            const image = event?.currentTarget
            if (image) image.style.display = 'none'
          },
        }))
    }

    function card(entry, index, model) {
      const selected = model.selected.includes(entry.sha256)
      const handlers = model.handlers
      return h('div', {
        key: entry.sha256,
        role: 'option',
        tabIndex: model.active === index ? 0 : -1,
        'aria-selected': selected,
        className: `dfl-card${selected ? ' is-selected' : ''}${model.active === index ? ' is-active' : ''}`,
        'data-dfl-sha': entry.sha256,
        'data-dfl-name': entry.name,
        'data-dfl-kind': entry.kind,
        'data-dfl-state': entry.state ?? 'global',
        onClick: event => handlers.onActivate?.(index, event),
        onDoubleClick: () => handlers.onUse?.(entry),
        onKeyDown: event => handlers.onCardKeyDown?.(event, index, entry),
      },
        h('input', {
          type: 'checkbox',
          className: 'dfl-check',
          checked: selected,
          'aria-label': `Select ${entry.name}`,
          onClick: event => event.stopPropagation(),
          onChange: () => handlers.onToggleSelect?.(entry.sha256),
        }),
        thumb(entry, model),
        h('span', { className: 'dfl-card-body' },
          h('span', { className: 'dfl-name', title: entry.name }, entry.name),
          h('span', { className: 'dfl-meta' },
            h('span', { className: 'dfl-kind-badge', 'data-dfl-kind-badge': entry.kind }, (entry.ext || entry.kind).toUpperCase()),
            h('span', { className: 'dfl-size' }, formatBytes(entry.bytes))),
          h('span', { className: 'dfl-source', title: entry.sessionTitle },
            relativeTime(entry.sentAt, model.now),
            entry.sessionTitle ? ` · ${entry.sessionTitle}` : ''),
          entry.state === 'missing'
            ? h('span', { className: 'dfl-missing', 'data-dfl-missing': '1' }, 'Missing · bytes are gone')
            : null,
          entry.state === 'global'
            ? h('span', { className: 'dfl-foreign', 'data-dfl-foreign': '1' }, 'Other workspace')
            : null,
          entry.imported
            ? h('span', { className: 'dfl-imported', 'data-dfl-imported': '1' }, 'Imported')
            : null,
          entry.filed ? h('span', { className: 'dfl-filed' }, `Filed · library/${entry.name}`) : null,
          h('span', { className: 'dfl-actions' },
            h('button', {
              type: 'button',
              className: 'dfl-open',
              'data-dfl-open': entry.sha256,
              title: entry.state === 'missing'
                ? 'The bytes are missing from this host'
                : `Open ${entry.name} in a new tab (nothing is copied)`,
              disabled: entry.state === 'missing',
              onClick: event => {
                event.stopPropagation()
                if (entry.state !== 'missing') handlers.onOpen?.(entry)
              },
            }, entry.kind === 'image' || entry.kind === 'pdf' ? 'Preview' : 'Open'))))
    }

    function emptyState(model) {
      const searching = model.query.trim() !== '' || model.kind !== 'all'
      if (model.kind !== 'all' && model.query.trim() === '' && model.entries.length === 0) {
        const label = KIND_LABEL[model.kind] ?? 'Files'
        const offerAll = model.scope === 'workspace' && model.totalAll > 0
        return h('div', { className: 'dfl-empty', 'data-dfl-empty-state': 'kind-empty' },
          h('div', { className: 'dfl-empty-glyph', 'aria-hidden': 'true' }, '▤'),
          h('h3', null, `No ${label} files in this view`),
          h('p', null,
            'Files appear here only after you send them in a chat. A file you open from a path is not stored as an attachment, so it never becomes a library row.'),
          offerAll
            ? h('button', {
              type: 'button', className: 'dfl-btn is-primary', 'data-dfl-switch-scope': 'all',
              onClick: () => model.handlers.onScope?.('all'),
            }, 'Search all files')
            : null)
      }
      if (searching) {
        return h('div', { className: 'dfl-empty', 'data-dfl-empty-state': 'no-results' },
          h('div', { className: 'dfl-empty-glyph', 'aria-hidden': 'true' }, '⌕'),
          h('h3', null, 'No files match that search'),
          h('p', null, 'Try a shorter name, a different type chip, or a session title.'),
          h('button', {
            type: 'button', className: 'dfl-btn',
            onClick: () => model.handlers.onClearSearch?.(),
          }, 'Clear search'))
      }
      if (model.scope === 'workspace' && model.totalAll > 0) {
        return h('div', { className: 'dfl-empty', 'data-dfl-empty-state': 'workspace-empty' },
          h('div', { className: 'dfl-empty-glyph', 'aria-hidden': 'true' }, '▤'),
          h('h3', null, 'No files in this workspace yet'),
          h('p', null,
            `The library holds ${model.totalAll} file${model.totalAll === 1 ? '' : 's'} sent in other chats. Send a file here and it is added to this workspace; the rest stay one click away.`),
          h('button', {
            type: 'button', className: 'dfl-btn is-primary', 'data-dfl-switch-scope': 'all',
            onClick: () => model.handlers.onScope?.('all'),
          }, 'Show all files'))
      }
      return h('div', { className: 'dfl-empty', 'data-dfl-empty-state': 'library-empty' },
        h('div', { className: 'dfl-empty-glyph', 'aria-hidden': 'true' }, '▤'),
        h('h3', null, 'Your file library is empty'),
        h('p', null,
          'Everything you send to DSH is kept in a shared attachment store. Send a PDF, image, document or spreadsheet in any chat and it appears here with its original name, ready to search and reuse.'),
        h('p', { className: 'dfl-muted' },
          'Files are indexed from session logs on this host. Nothing is uploaded a second time, and the original bytes never leave the attachment store.'))
    }

    /** Serialize the whole panel; no DOM or hooks, so layout can be tested. */
    function buildView(model) {
      const handlers = model.handlers
      const selected = model.selected
      const activeEntry = model.entries[model.active]
      return h('div', {
        className: 'dfl-root',
        'data-dfl-root': '1',
        'data-dfl-width': String(model.width),
        'data-dfl-fullscreen': model.fullscreen ? 'true' : 'false',
        'data-dfl-empty': model.entries.length === 0 ? 'true' : 'false',
        'data-dfl-count': String(model.entries.length),
        'data-dfl-view': model.view,
        onKeyDown: handlers.onRootKeyDown,
      },
        h('header', { className: 'dfl-head' },
          h('div', { className: 'dfl-title-row' },
            h('span', { className: 'dfl-title' }, 'File library'),
            h('span', { className: 'dfl-count' }, `${model.allEntries.length} file${model.allEntries.length === 1 ? '' : 's'}`),
            h('span', { className: 'dfl-spacer' }),
            h('button', {
              type: 'button', className: 'dfl-icon-btn', title: 'Grid view', 'aria-label': 'Grid view',
              'aria-pressed': model.view === 'grid', onClick: () => handlers.onView?.('grid'),
            }, '▦'),
            h('button', {
              type: 'button', className: 'dfl-icon-btn', title: 'List view', 'aria-label': 'List view',
              'aria-pressed': model.view === 'list', onClick: () => handlers.onView?.('list'),
            }, '☰'),
            h('button', {
              type: 'button', className: 'dfl-icon-btn', title: 'Import a file from this computer', 'aria-label': 'Import a file',
              'data-dfl-import-toggle': '1', onClick: () => handlers.onToggleImport?.(),
            }, '⤓'),
            h('button', {
              type: 'button', className: 'dfl-icon-btn', title: 'Refresh index', 'aria-label': 'Refresh index',
              onClick: () => handlers.onRefresh?.(),
            }, '↻')),
          h('div', { className: 'dfl-scope-row', role: 'group', 'aria-label': 'File scope' },
            SCOPES.map(scope => h('button', {
              type: 'button',
              key: scope,
              className: `dfl-scope-btn${model.scope === scope ? ' is-active' : ''}`,
              'aria-pressed': model.scope === scope,
              'data-dfl-scope': scope,
              onClick: () => handlers.onScope?.(scope),
            }, scope === 'workspace' ? 'This workspace' : 'All files')),
            h('span', { className: 'dfl-scope-count', 'data-dfl-total-all': String(model.totalAll) },
              model.scope === 'workspace'
                ? `${model.allEntries.length} of ${model.totalAll} file${model.totalAll === 1 ? '' : 's'}`
                : `${model.allEntries.length} file${model.allEntries.length === 1 ? '' : 's'}${model.foreignCount > 0 ? ` · ${model.foreignCount} from other workspaces` : ''}`)),
          model.scopeFallback === null
            ? null
            : h('p', { className: 'dfl-scope-fallback', 'data-dfl-scope-fallback': model.scopeFallback, role: 'status' },
              scopeFallbackText(model.scopeFallback)),
          model.importOpen
            ? h('form', {
              className: 'dfl-import', 'data-dfl-import-form': '1',
              onSubmit: event => { event.preventDefault(); model.handlers.onImportSubmit?.() },
            },
              h('input', {
                type: 'text',
                className: 'dfl-import-input',
                'data-dfl-import-path': '1',
                placeholder: 'C:\\path\\to\\file.pdf',
                value: model.importPath,
                onChange: event => model.handlers.onImportPath?.(event.target.value),
                'aria-label': 'Absolute path to a file on this computer',
              }),
              h('button', {
                type: 'submit', className: 'dfl-btn is-primary',
                disabled: model.importing || model.importPath.trim() === '',
              }, model.importing ? 'Importing…' : 'Import'),
              h('button', {
                type: 'button', className: 'dfl-btn is-quiet',
                onClick: () => model.handlers.onImportCancel?.(),
              }, 'Cancel'))
            : null,
          model.coverage?.truncated === true
            ? h('p', { className: 'dfl-coverage', 'data-dfl-coverage': 'truncated', role: 'status' },
              coverageText(model.coverage))
            : null,
          h('div', { className: 'dfl-search-row' },
            h('input', {
              type: 'search',
              className: 'dfl-search',
              'data-dfl-search': '1',
              placeholder: 'Search name, type or session',
              'aria-label': 'Search the file library',
              value: model.query,
              ref: model.searchRef,
              onChange: event => handlers.onSearch?.(event.target.value),
              onKeyDown: event => handlers.onSearchKeyDown?.(event),
            }),
            h('kbd', { className: 'dfl-kbd', 'aria-hidden': 'true' }, '/')),
          h('div', { className: 'dfl-chips', role: 'toolbar', 'aria-label': 'File types' },
            KINDS.map(kind => chip(kind, model.counts[kind] ?? 0, model.kind, handlers.onKind ?? (() => {}))))),
        selected.length > 0
          ? h('div', { className: 'dfl-toolbar', 'data-dfl-selected': String(selected.length) },
            h('span', { className: 'dfl-toolbar-count' }, `${selected.length} selected`),
            h('button', { type: 'button', className: 'dfl-btn', onClick: () => handlers.onFileSelected?.() }, 'File this'),
            h('button', { type: 'button', className: 'dfl-btn is-primary', onClick: () => handlers.onUseSelected?.() }, 'Use in chat'),
            h('button', { type: 'button', className: 'dfl-btn is-quiet', onClick: () => handlers.onClearSelection?.() }, 'Clear'))
          : null,
        h('div', {
          className: `dfl-scroll${model.view === 'list' ? ' is-list' : ''}`,
          role: 'listbox',
          'aria-label': 'Files',
          'aria-multiselectable': 'true',
        },
          model.loading
            ? h('div', { className: 'dfl-loading' }, h('span', { className: 'dfl-spinner', 'aria-hidden': 'true' }), 'Indexing files…')
            : model.error
              ? h('div', { className: 'dfl-error', role: 'alert' }, h('p', null, model.error), h('button', { type: 'button', className: 'dfl-btn', onClick: () => handlers.onRefresh?.() }, 'Retry'))
              : model.entries.length === 0
                ? emptyState(model)
                : h('div', { className: model.view === 'list' ? 'dfl-list' : 'dfl-grid' },
                  model.entries.map((entry, index) => card(entry, index, model)))),
        model.toast
          ? h('div', { className: 'dfl-toast', role: 'status' }, model.toast)
          : null,
        h('footer', { className: 'dfl-foot' },
          h('span', null, '“Open” streams the original from the attachment store; “File this” copies one into ',
            h('code', null, 'library/'), ' to edit.'),
          activeEntry ? h('span', { className: 'dfl-foot-hint' }, 'Enter uses · / searches · Esc clears') : null))
    }

    /* ------------------------------------------------------------ actions -- */

    function notify(state, message) {
      return { ...state, toast: message }
    }

    function insertReference(sessionId, text) {
      if (clientCtx === null) return { ok: false, error: 'client context is unavailable' }
      try {
        const scope = clientCtx.sessions.scope(sessionId)
        if (scope === undefined || scope === null) return { ok: false, error: 'the session is not retained by this page' }
        const input = clientCtx.conversation.input.for(scope)
        const snapshot = input.state.getSnapshot()
        const request = {
          text: `${text} `,
          span: { start: snapshot.draft.length, end: snapshot.draft.length, draftRev: snapshot.draftRev },
        }
        const applied = scope.bail('slash/input-insert-text', request) === true
        if (applied) input.focus?.()
        return applied ? { ok: true } : { ok: false, error: 'the composer rejected the insertion' }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    }

    function buildReference(entry) {
      const name = typeof entry?.name === 'string' && entry.name.trim() !== '' ? entry.name.trim() : 'file'
      const path = `library/${name.replaceAll('"', '_')}`
      const needsQuotes = /[\s"]/u.test(name) || /[.,;:!?，。；：！？]$/u.test(name)
      return needsQuotes ? `@"${path}"` : `@${path}`
    }

    /* --------------------------------------------------------------- body -- */

    function LibraryBody(props) {
      const info = props.useTabInfo()
      const sessionId = props.sessionId
      const [state, setState] = useState({
        loading: true, error: null, entries: [], query: '', kind: 'all', view: 'grid',
        selected: [], active: 0, toast: null, filedCount: 0,
        scope: readScopePreference(sessionId), scopeFallback: null, totalAll: 0, coverage: null, foreignCount: 0,
        importOpen: false, importPath: '', importing: false,
      })
      const [width, setWidth] = useState(() => {
        if (typeof window !== 'undefined' && Number.isFinite(window.innerWidth)) return Math.min(1200, window.innerWidth)
        return 768
      })
      const rootRef = useRef(null)
      const searchRef = useRef(null)

      const load = useCallback(async scopeArg => {
        const asked = scopeArg === 'all' ? 'all' : 'workspace'
        setState(current => ({ ...current, loading: true, error: null }))
        try {
          let data
          let httpFallback = null
          try {
            data = await getJson(indexQuery(sessionId, asked))
          } catch (error) {
            if (error?.status !== 404) throw error
            // Older host halves have no scope parameter; keep browsing, but
            // say plainly that the list is not scoped.
            data = await getJson('index?scope=all&limit=2000')
            httpFallback = 'http-404'
          }
          const entries = Array.isArray(data.entries) ? data.entries : []
          const totalAll = Number.isFinite(Number(data.totalAll))
            ? Math.max(0, Math.trunc(Number(data.totalAll)))
            : entries.length
          const effective = data.scope === 'workspace' ? 'workspace' : 'all'
          const fallback = typeof data.scopeFallback === 'string' && data.scopeFallback !== ''
            ? data.scopeFallback
            : (effective === asked ? null : httpFallback)
          setState(current => ({
            ...current,
            loading: false,
            error: null,
            entries,
            filedCount: Number(data.filedCount) || 0,
            scope: effective,
            scopeFallback: fallback,
            coverage: data.coverage ?? null,
            totalAll,
            selected: current.selected.filter(sha => entries.some(entry => entry.sha256 === sha)),
            active: 0,
          }))
        } catch (error) {
          setState(current => ({
            ...current,
            loading: false,
            error: error instanceof Error ? error.message : String(error),
          }))
        }
      }, [sessionId])

      // Refresh re-scans the host logs first; a plain list read can serve a scan
      // that predates the file the user just sent.
      const refresh = useCallback(async () => {
        try {
          await postJson('reindex', {})
        } catch (error) {
          // An older host half has no /reindex; the list read still works.
          if (error?.status !== 404) {
            setState(current => notify(current, `Could not refresh the index: ${error instanceof Error ? error.message : String(error)}`))
          }
        }
        await load(state.scope)
      }, [load, state.scope])

      useEffect(() => { void load(state.scope) }, [load, state.scope])

      useEffect(() => {
        const element = rootRef.current
        if (element === null || typeof ResizeObserver === 'undefined') return undefined
        const observer = new ResizeObserver(entries => {
          const next = entries[0]?.contentRect?.width
          if (Number.isFinite(next) && next > 0) setWidth(Math.round(next))
        })
        observer.observe(element)
        return () => observer.disconnect()
      }, [])

      useEffect(() => {
        if (info.tab.visible !== true) return undefined
        const onKeyDown = event => {
          if (event.key !== '/') return
          const target = event.target
          const editable = target instanceof Element
            && (target.closest('input, textarea, select, [contenteditable="true"]') !== null)
          if (editable) return
          event.preventDefault()
          searchRef.current?.focus()
        }
        document.addEventListener('keydown', onKeyDown)
        return () => document.removeEventListener('keydown', onKeyDown)
      }, [info.tab.visible])

      const update = useCallback(patch => setState(current => ({ ...current, ...patch })), [])

      // Import copies one existing file into the attachment store host-side; it
      // does not depend on the composer's file picker.
      const importFromPath = useCallback(async () => {
        const path = state.importPath.trim()
        if (path === '') return
        setState(current => ({ ...current, importing: true, error: null }))
        try {
          const result = await postJson('import', { sessionId, path })
          setState(current => ({
            ...current,
            importing: false,
            importOpen: false,
            importPath: '',
            toast: `Imported ${result.name}`,
          }))
          await load(state.scope)
        } catch (error) {
          setState(current => ({
            ...current,
            importing: false,
            error: error instanceof Error ? error.message : String(error),
          }))
        }
      }, [sessionId, state.importPath, state.scope, load])

      const fileEntry = useCallback(async entry => {
        try {
          const filed = await postJson('file', { sha: entry.sha256, sessionId, tags: entry.tags ?? [] })
          setState(current => ({
            ...current,
            entries: current.entries.map(row => row.sha256 === filed.sha
              ? { ...row, filed: true, tags: filed.tags ?? row.tags, filedPath: filed.relativePath }
              : row),
            toast: filed.deduped ? `Already filed as ${filed.relativePath}` : `Filed to ${filed.relativePath}`,
          }))
          return filed
        } catch (error) {
          setState(current => notify(current, `Could not file: ${error instanceof Error ? error.message : String(error)}`))
          return null
        }
      }, [sessionId])

      const useEntries = useCallback(async entries => {
        const usable = entries.filter(entry => entry.state !== 'missing')
        if (usable.length === 0) {
          if (entries.length > 0) setState(current => notify(current, 'Those files are missing from this host, so nothing can be filed.'))
          return
        }
        const references = []
        for (const entry of usable) {
          const filed = await fileEntry(entry)
          if (filed !== null) references.push(filed.reference)
        }
        if (references.length === 0) return
        const result = insertReference(sessionId, references.join(' '))
        if (result.ok) {
          setState(current => ({ ...current, selected: [], toast: `Added ${references.join(' ')} to the composer` }))
        } else {
          try {
            await navigator.clipboard?.writeText(references.join(' '))
            setState(current => ({ ...current, selected: [], toast: `Could not reach the composer; copied ${references.join(' ')}` }))
          } catch {
            setState(current => notify(current, `Could not insert the reference: ${result.error}`))
          }
        }
      }, [fileEntry, sessionId])

      const toggleSelect = useCallback(sha => setState(current => ({
        ...current,
        selected: current.selected.includes(sha)
          ? current.selected.filter(value => value !== sha)
          : [...current.selected, sha],
      })), [])

      const move = useCallback(delta => setState(current => {
        const visible = filterEntries(current.entries, current.query, current.kind)
        if (visible.length === 0) return current
        const next = Math.max(0, Math.min(visible.length - 1, current.active + delta))
        return { ...current, active: next }
      }), [])

      const model = buildModel({
        entries: state.entries,
        query: state.query,
        kind: state.kind,
        view: state.view,
        selected: state.selected,
        active: state.active,
        loading: state.loading,
        error: state.error,
        toast: state.toast,
        filedCount: state.filedCount,
        width,
        fullscreen: info.sidebar.fullscreen === true,
        sessionId,
        searchRef,
        handlers: {
          onSearch: value => update({ query: value, active: 0 }),
          onKind: kind => update({ kind, active: 0 }),
          onView: view => update({ view }),
          onRefresh: () => { void refresh() },
          onToggleImport: () => update({ importOpen: !state.importOpen, importPath: '', error: null }),
          onImportPath: value => update({ importPath: value }),
          onImportCancel: () => update({ importOpen: false, importPath: '', importing: false }),
          onImportSubmit: () => { void importFromPath() },
          onScope: scope => {
            saveScopePreference(sessionId, scope)
            update({ scope: scope === 'all' ? 'all' : 'workspace', selected: [], active: 0 })
          },
          onClearSearch: () => update({ query: '', kind: 'all', active: 0 }),
          onToggleSelect: toggleSelect,
          onClearSelection: () => update({ selected: [] }),
          onActivate: index => {
            setState(current => {
              const visible = filterEntries(current.entries, current.query, current.kind)
              const entry = visible[index]
              if (entry === undefined) return current
              return {
                ...current,
                active: index,
                selected: current.selected.includes(entry.sha256) ? current.selected : [...current.selected, entry.sha256],
              }
            })
          },
          onCardKeyDown: (event, index, entry) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              void useEntries([entry])
            } else if (event.key === ' ') {
              event.preventDefault()
              toggleSelect(entry.sha256)
            }
          },
          onSearchKeyDown: event => {
            if (event.key === 'Escape') {
              event.preventDefault()
              update({ query: '', kind: 'all', active: 0 })
              event.currentTarget.blur()
            }
          },
          onRootKeyDown: event => {
            const columns = state.view === 'list' ? 1 : Math.max(1, Math.floor((width - 24) / 146))
            if (event.key === 'ArrowRight') { event.preventDefault(); move(1) }
            else if (event.key === 'ArrowLeft') { event.preventDefault(); move(-1) }
            else if (event.key === 'ArrowDown') { event.preventDefault(); move(columns) }
            else if (event.key === 'ArrowUp') { event.preventDefault(); move(-columns) }
            else if (event.key === 'Escape') {
              event.preventDefault()
              update({ query: '', kind: 'all', selected: [], active: 0 })
            } else if (event.key === 'Enter' && event.target === event.currentTarget) {
              const visible = filterEntries(state.entries, state.query, state.kind)
              const entry = visible[state.active]
              if (entry !== undefined) { event.preventDefault(); void useEntries([entry]) }
            }
          },
          onFileSelected: () => {
            const rows = state.entries.filter(entry => state.selected.includes(entry.sha256))
            void (async () => {
              for (const entry of rows) await fileEntry(entry)
            })()
          },
          onUseSelected: () => {
            const rows = state.entries.filter(entry => state.selected.includes(entry.sha256))
            void useEntries(rows)
          },
          onUse: entry => { void useEntries([entry]) },
          onOpen: entry => {
            if (entry.state === 'missing') {
              setState(current => notify(current, 'That file is missing from this host.'))
              return
            }
            const url = objectUrl(entry.sha256)
            try {
              const opened = window.open(url, '_blank', 'noopener,noreferrer')
              if (opened === null) setState(current => notify(current, 'Your browser blocked the new tab; allow pop-ups for this page.'))
            } catch (error) {
              setState(current => notify(current, `Could not open it: ${error instanceof Error ? error.message : String(error)}`))
            }
          },
        },
      })

      return h('div', { ref: rootRef, className: 'dfl-host' }, buildView(model))
    }

    /* -------------------------------------------------------------- style -- */

    const CSS = `
.dfl-host{position:relative;display:flex;flex-direction:column;height:100%;min-height:0;min-width:0}
.dfl-root{display:flex;flex-direction:column;height:100%;min-height:0;min-width:0;container-type:inline-size;color:var(--dsw-alias-label-primary,inherit);font-size:13px;line-height:1.45}
.dfl-head{flex:none;padding:10px 12px 6px;display:flex;flex-direction:column;gap:8px}
.dfl-title-row{display:flex;align-items:center;gap:8px;min-width:0}
.dfl-title{font-weight:600;font-size:14px;white-space:nowrap}
.dfl-count{color:var(--dsw-alias-label-tertiary,inherit);font-size:12px;white-space:nowrap}
.dfl-spacer{flex:1 1 auto}
.dfl-scope-row{display:flex;align-items:center;gap:4px;min-width:0;flex-wrap:wrap}
.dfl-scope-btn{appearance:none;border:1px solid transparent;background:transparent;color:var(--dsw-alias-label-secondary,inherit);border-radius:6px;padding:2px 8px;font:inherit;font-size:11.5px;line-height:1.5;cursor:pointer;white-space:nowrap}
.dfl-scope-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.1))}
.dfl-scope-btn.is-active{background:var(--dsw-alias-interactive-bg-hover,rgba(99,132,255,.14));border-color:var(--dsw-alias-border-accent,rgba(99,132,255,.55));color:var(--dsw-alias-label-primary,inherit)}
.dfl-scope-count{margin-left:auto;color:var(--dsw-alias-label-tertiary,inherit);font-size:11px;font-variant-numeric:tabular-nums;white-space:nowrap}
.dfl-scope-fallback{margin:0;color:var(--dsw-alias-label-tertiary,inherit);font-size:11px;line-height:1.5}
.dfl-icon-btn{appearance:none;border:1px solid transparent;background:transparent;color:inherit;border-radius:6px;width:26px;height:26px;display:inline-flex;align-items:center;justify-content:center;cursor:pointer;font-size:14px;line-height:1;flex:none}
.dfl-icon-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}
.dfl-icon-btn[aria-pressed="true"]{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.16));border-color:var(--dsw-alias-border-l2-darkmode-thin,rgba(127,127,127,.22))}
.dfl-search-row{position:relative;display:flex;align-items:center}
.dfl-search{width:100%;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2-darkmode-thin,rgba(127,127,127,.28));background:var(--dsw-specific-input-major,var(--dsw-alias-surface-2,rgba(127,127,127,.06)));color:inherit;border-radius:8px;padding:7px 30px 7px 10px;font:inherit;outline:none;min-width:0}
.dfl-search:focus{border-color:var(--dsw-alias-border-accent,rgba(99,132,255,.75));box-shadow:0 0 0 2px color-mix(in srgb,var(--dsw-alias-border-accent,#6384ff) 22%,transparent)}
.dfl-kbd{position:absolute;right:8px;color:var(--dsw-alias-label-tertiary,inherit);border:1px solid var(--dsw-alias-border-l2-darkmode-thin,rgba(127,127,127,.28));border-radius:4px;padding:0 5px;font-size:11px;line-height:16px;pointer-events:none}
.dfl-chips{display:flex;flex-wrap:wrap;gap:5px}
.dfl-chip{appearance:none;border:1px solid var(--dsw-alias-border-l2-darkmode-thin,rgba(127,127,127,.26));background:transparent;color:inherit;border-radius:999px;padding:3px 8px;font-size:11.5px;cursor:pointer;display:inline-flex;align-items:center;gap:5px}
.dfl-chip:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.1))}
.dfl-chip.is-active{background:var(--dsw-alias-interactive-bg-hover,rgba(99,132,255,.16));border-color:var(--dsw-alias-border-accent,rgba(99,132,255,.6))}
.dfl-chip-count{color:var(--dsw-alias-label-tertiary,inherit);font-variant-numeric:tabular-nums}
.dfl-toolbar{flex:none;display:flex;align-items:center;flex-wrap:wrap;gap:6px;padding:6px 12px;border-top:1px solid var(--dsw-alias-border-l2-darkmode-thin,rgba(127,127,127,.18));border-bottom:1px solid var(--dsw-alias-border-l2-darkmode-thin,rgba(127,127,127,.18));background:var(--dsw-alias-surface-2,rgba(127,127,127,.05))}
.dfl-toolbar-count{color:var(--dsw-alias-label-secondary,inherit);font-size:12px;margin-right:2px}
.dfl-btn{appearance:none;border:1px solid var(--dsw-alias-border-l2-darkmode-thin,rgba(127,127,127,.32));background:var(--dsw-specific-input-major,transparent);color:inherit;border-radius:7px;padding:4px 10px;font:inherit;font-size:12px;cursor:pointer}
.dfl-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}
.dfl-btn.is-primary{background:var(--dsw-alias-interactive-bg-accent,#3d6fe0);border-color:transparent;color:#fff}
.dfl-btn.is-quiet{border-color:transparent;background:transparent}
.dfl-scroll{flex:1 1 auto;min-height:0;overflow:auto;overscroll-behavior:contain}
.dfl-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(132px,1fr));gap:10px;padding:12px}
.dfl-list{display:flex;flex-direction:column;padding:4px 0}
.dfl-card{position:relative;display:flex;flex-direction:column;gap:6px;min-width:0;padding:8px;border-radius:10px;border:1px solid transparent;cursor:pointer;outline:none;background:var(--dsw-specific-input-major,var(--dsw-alias-surface-2,rgba(127,127,127,.05)))}
.dfl-card:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.1))}
.dfl-card.is-selected{border-color:var(--dsw-alias-border-accent,rgba(99,132,255,.75));background:var(--dsw-alias-interactive-bg-hover,rgba(99,132,255,.1))}
.dfl-card:focus-visible{box-shadow:0 0 0 2px var(--dsw-alias-border-accent,rgba(99,132,255,.75))}
.dfl-list .dfl-card{flex-direction:row;align-items:center;gap:10px;border-radius:8px;padding:7px 10px}
.dfl-check{position:absolute;top:6px;left:6px;z-index:2;accent-color:var(--dsw-alias-border-accent,#6384ff);opacity:0;transition:opacity .1s}
.dfl-card:hover .dfl-check,.dfl-card.is-selected .dfl-check,.dfl-card:focus-within .dfl-check{opacity:1}
.dfl-thumb{position:relative;display:flex;align-items:center;justify-content:center;aspect-ratio:4/3;border-radius:7px;overflow:hidden;background:var(--dsw-alias-surface-3,rgba(127,127,127,.09));flex:none}
.dfl-list .dfl-thumb{width:46px;height:38px;aspect-ratio:auto;border-radius:6px}
.dfl-thumb-img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}
.dfl-thumb-fallback{display:flex;align-items:center;justify-content:center;width:100%;height:100%;color:var(--dsw-alias-label-tertiary,inherit)}
.dfl-type{font-size:11px;font-weight:700;letter-spacing:.04em}
.dfl-card-body{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1 1 auto}
.dfl-name{font-size:12.5px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dfl-list .dfl-name{font-size:13px}
.dfl-meta{display:flex;align-items:center;gap:5px;min-width:0;color:var(--dsw-alias-label-tertiary,inherit);font-size:11px}
.dfl-kind-badge{text-transform:uppercase;letter-spacing:.03em;font-size:10px;border:1px solid var(--dsw-alias-border-l2-darkmode-thin,rgba(127,127,127,.26));border-radius:4px;padding:0 3px;flex:none}
.dfl-size{white-space:nowrap}
.dfl-source{color:var(--dsw-alias-label-tertiary,inherit);font-size:10.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dfl-filed{color:var(--dsw-alias-state-success-primary,#2e8b57);font-size:10.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dfl-missing{color:var(--dsw-alias-state-error-primary,#c0392b);font-size:10.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dfl-foreign{color:var(--dsw-alias-label-tertiary,inherit);font-size:10.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dfl-imported{color:var(--dsw-alias-label-secondary,inherit);font-size:10.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dfl-import{display:flex;align-items:center;gap:6px;min-width:0}
.dfl-import-input{flex:1 1 auto;min-width:0;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2-darkmode-thin,rgba(127,127,127,.28));background:var(--dsw-specific-input-major,var(--dsw-alias-surface-2,rgba(127,127,127,.06)));color:inherit;border-radius:7px;padding:5px 8px;font:inherit;font-size:12px;outline:none}
.dfl-import-input:focus{border-color:var(--dsw-alias-border-accent,rgba(99,132,255,.75))}
.dfl-actions{display:flex;gap:6px;margin-top:1px}
.dfl-open{appearance:none;border:1px solid var(--dsw-alias-border-l2-darkmode-thin,rgba(127,127,127,.26));background:transparent;color:var(--dsw-alias-label-secondary,inherit);border-radius:5px;padding:0 5px;font:inherit;font-size:10.5px;line-height:16px;cursor:pointer;align-self:flex-start}
.dfl-open:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12));color:var(--dsw-alias-label-primary,inherit)}
.dfl-open[disabled]{opacity:.45;cursor:default}
.dfl-coverage{margin:0;color:var(--dsw-alias-label-tertiary,inherit);font-size:11px;line-height:1.5}
.dfl-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;gap:8px;min-height:100%;max-width:430px;margin:0 auto;padding:28px 20px;box-sizing:border-box}
.dfl-empty-glyph{width:44px;height:44px;border-radius:10px;display:flex;align-items:center;justify-content:center;background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12));font-size:20px}
.dfl-empty h3{margin:2px 0 0;font-size:14px;font-weight:600}
.dfl-empty p{margin:0;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary,inherit)}
.dfl-muted{color:var(--dsw-alias-label-tertiary,inherit)!important;font-size:11px!important}
.dfl-loading,.dfl-error{display:flex;align-items:center;justify-content:center;gap:8px;min-height:120px;padding:24px;color:var(--dsw-alias-label-secondary,inherit);font-size:12px}
.dfl-spinner{width:12px;height:12px;border-radius:50%;border:2px solid var(--dsw-alias-border-l2-darkmode-thin,rgba(127,127,127,.3));border-top-color:var(--dsw-alias-border-accent,#6384ff);animation:dfl-spin .8s linear infinite}
@keyframes dfl-spin{to{transform:rotate(360deg)}}
.dfl-toast{position:absolute;left:12px;right:12px;bottom:44px;z-index:5;background:var(--dsw-alias-surface-overlay,#20242b);color:#fff;border-radius:8px;padding:7px 10px;font-size:12px;box-shadow:0 6px 20px rgba(0,0,0,.22);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dfl-foot{flex:none;display:flex;justify-content:space-between;gap:8px;padding:5px 12px 7px;color:var(--dsw-alias-label-tertiary,inherit);font-size:10.5px;border-top:1px solid var(--dsw-alias-border-l2-darkmode-thin,rgba(127,127,127,.16))}
.dfl-foot code{font-family:var(--ds-font-family-code,monospace);font-size:10px}
.dfl-foot-hint{white-space:nowrap}
@container (max-width:520px){
  .dfl-grid{grid-template-columns:repeat(auto-fill,minmax(112px,1fr));gap:8px;padding:8px}
  .dfl-head{padding:8px 8px 4px}
  .dfl-source{display:none}
  .dfl-scope-count{display:none}
  .dfl-foot{display:none}
}
@media (max-width:768px){
  .dfl-head{padding:8px}
  .dfl-grid{grid-template-columns:repeat(auto-fill,minmax(108px,1fr));gap:8px;padding:8px}
  .dfl-title{font-size:13px}
}
@media (prefers-reduced-motion:reduce){
  .dfl-spinner{animation:none}
  .dfl-check{transition:none}
}
`

    function injectCss() {
      if (typeof document === 'undefined') return () => undefined
      const existing = document.querySelector('style[data-dsh-plugin="dsh-file-library"]')
      if (existing !== null) return () => undefined
      const tag = document.createElement('style')
      tag.dataset.dshPlugin = 'dsh-file-library'
      tag.textContent = CSS
      document.head.appendChild(tag)
      return () => tag.remove()
    }

    /* -------------------------------------------------------------- apply -- */

    const definition = {
      id: ID,
      kind: KIND,
      priority: 'extension',
      title: () => 'File library',
      guide: [{
        id: 'library',
        order: 20,
        title: () => 'File library',
        description: () => 'Every file you have sent to DSH, searchable and one click from reuse.',
      }],
    }

    function apply(ctx) {
      clientCtx = ctx
      ctx.effect(() => injectCss())
      ctx.effect(() => ctx.sidebarRightTabs.register(definition), 'dsh-file-library: tab type')
      ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register(
        { name: 'sidebar.right.pane.tab', key: ID },
        LibraryBody,
      )), 'dsh-file-library: tab body')
    }

    const api = {
      apply,
      inject: ['slots', 'sidebarRightTabs', 'sidebarRight', 'sessions', 'conversation'],
    }
    // DOM-free handles used by the offline tests; no runtime path reads them.
    api.__internals = {
      apiUrl,
      appRoot,
      buildModel,
      buildView,
      buildReference,
      filterEntries,
      formatBytes,
      relativeTime,
      insertReference,
      indexQuery,
      coverageText,
      objectUrl,
      readScopePreference,
      saveScopePreference,
      scopeStorageKey,
      scopeFallbackText,
      SCOPES,
      SCOPE_STORAGE_KEY,
      KIND,
      ID,
      CSS,
    }
    return api
  },
})
