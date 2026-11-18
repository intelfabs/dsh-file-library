/* global window, document, fetch, navigator, ResizeObserver */
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

    async function postJson(relative, payload) {
      const response = await fetch(apiUrl(relative), {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(payload),
      })
      const body = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(body?.error ?? `HTTP ${response.status}`)
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
          entry.filed ? h('span', { className: 'dfl-filed' }, `Filed · library/${entry.name}`) : null))
    }

    function emptyState(model) {
      const searching = model.query.trim() !== '' || model.kind !== 'all'
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
              type: 'button', className: 'dfl-icon-btn', title: 'Refresh index', 'aria-label': 'Refresh index',
              onClick: () => handlers.onRefresh?.(),
            }, '↻')),
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
          h('span', null, 'Files stay in the DSH attachment store; “File this” copies one into ',
            h('code', null, 'library/'), '.'),
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
      return `@library/${entry.name}`
    }

    /* --------------------------------------------------------------- body -- */

    function LibraryBody(props) {
      const info = props.useTabInfo()
      const sessionId = props.sessionId
      const [state, setState] = useState({
        loading: true, error: null, entries: [], query: '', kind: 'all', view: 'grid',
        selected: [], active: 0, toast: null, filedCount: 0,
      })
      const [width, setWidth] = useState(() => {
        if (typeof window !== 'undefined' && Number.isFinite(window.innerWidth)) return Math.min(1200, window.innerWidth)
        return 768
      })
      const rootRef = useRef(null)
      const searchRef = useRef(null)

      const load = useCallback(async () => {
        setState(current => ({ ...current, loading: true, error: null }))
        try {
          let data
          try {
            data = await getJson(`index?sessionId=${encodeURIComponent(sessionId)}&limit=2000`)
          } catch (error) {
            if (error?.status === 404) data = await getJson('index?limit=2000')
            else throw error
          }
          setState(current => ({
            ...current,
            loading: false,
            error: null,
            entries: Array.isArray(data.entries) ? data.entries : [],
            filedCount: Number(data.filedCount) || 0,
            selected: current.selected.filter(sha => (data.entries ?? []).some(entry => entry.sha256 === sha)),
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

      useEffect(() => { void load() }, [load])

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
        if (entries.length === 0) return
        const references = []
        for (const entry of entries) {
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
          onRefresh: () => { void load() },
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
      KIND,
      ID,
      CSS,
    }
    return api
  },
})
