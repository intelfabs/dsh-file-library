# File library

A searchable right-sidebar library of every file ever sent to DSH, with zero-copy viewing and one-click reuse.

## What it adds

- A new right-sidebar tab type, **File library** (`library`). It does not replace the built-in `files` tab.
- A thumbnail grid and a list view, type chips, search, recency order and multi-select.
- **A scope switch in the header.** **This workspace** (the default) shows only files belonging to the current session's workspace — sent from this chat, or already filed into its `library/` from anywhere. **All files** shows the whole host, with rows from other workspaces labelled **Other workspace**. The tab sends `scope=workspace|all` and remembers the choice per chat, so a wider view never carries into another chat.
- **An explicit import fallback.** `POST /import` copies one existing absolute path (below the session workspace or the user's home) into `attachment-local`'s `file-objects` store and a named `files/` link, then records it in `imports.json` so the tab lists it. It is deliberately not a log rewrite: the row shows **Imported**, has no invented session message, and still goes through the same `/object` and `/file` gates.
- **A scan that cannot go stale.** `GET /index` rebuilds the index first when the last scan is older than 30 seconds (or when `refresh=1` is passed), and `POST /reindex` forces a rebuild. The ↻ button calls it, so a file sent seconds ago is listed without restarting the host.
- **References with spaces.** `@path` tokens are whitespace-delimited unless quoted, so `libraryReference()` emits `@"library/Q3 review.pdf"` for a name containing whitespace (or ending in prose punctuation) and leaves `@library/pixel.png` unquoted. The filed name is the same in both forms.
- **Open / Preview**: streams the original bytes from `/object/<sha>` in a new tab. No copy, no workspace write. PDFs, images and plain text render inline; everything else downloads.
- **File this**: copies an indexed attachment into `<workspace>/library/<name>.<ext>`, updates `library/.manifest.json` and regenerates `library/INDEX.md`. Use it when the file must be edited or needs a real path.
- **Use in chat**: files the file if needed and inserts `@library/<name>` into the current composer.
- Three agent tools: `library_list` (search and filter), `library_read` (read text with no copy) and `library_use` (file and return the reference).

The rule is the same everywhere: **stream or read to view, file a copy to edit.**

## How files arrive

The host reads DSH's existing attachment objects and v4 session logs. DSH keeps two content-addressed stores below `$DSH_HOME/attachments/v1`: `objects/` for normalized images and `file-objects/` for every other uploaded file (PDFs, Office documents, archives), each with a read-only named link under `files/<sha[0:2]>/<sha>/<name>`. Original names, media types, sizes, times and session titles live only in those logs; the plugin joins each record to whichever store holds its bytes. A generic-file record carries a name and byte count but no media type, so the type is derived from the suffix and a missing name is recovered from the named link. The plugin never re-uploads, moves or deletes attachment bytes.

A warm start loads a metadata cache (`$DSH_HOME/cache/dsh-file-library/index.v1.json`) immediately and rebuilds changed sessions in the background. A cold start scans bounded logs once and shows an indexing state. The cache also carries the scan `coverage`, so after a restart the tab can still say that the index covers `seen` of `found` sessions.

## Reading without copying

`library_read` resolves a name or SHA against the index, checks that the object path is the digest-named object of either attachment store (`objects/` or `file-objects/`), stats it as a regular file, and then reads at most `maxBytes` (256 KiB by default, 1 MiB hard cap). Text-like files come back as UTF-8 with `truncated` and `bytesTotal`; PDFs, images, Office files and archives come back as metadata plus a hint. The result never contains an absolute path, and nothing is written to the workspace.

When a name matches several different files the tools return `{ ambiguous: true, candidates: [...] }` — `sha8`, name, bytes, send time, session title and `state`, ranked with exact names first and then the most recent — instead of guessing. Calling again with a `sha8` resolves it.

## Where to find it

Open the right sidebar, use the add control or the guide, and pick **File library**. The header opens on **This workspace**, so the first thing you see is the library of the chat you are in; switch to **All files** to browse every session on the host. Press `/` in the tab to focus search, arrows to move, `Enter` to use, `Esc` to clear.

If the session cannot be resolved — an old or detached tab — the host answers `scope: "all"` with a `scopeFallback` reason instead of failing, and the tab says so under the switch.

Each row carries a `state`: `filed-here` (this workspace's manifest already holds the digest), `in-workspace` (sent from this workspace, not filed), `global` (sent elsewhere only), or `missing` (the object bytes are gone). A missing row is marked and its Open and Use actions are disabled. `inWorkspace` is still emitted for one release and is deprecated.

## Limits

User-sent attachments only (not tool-generated images, and not a local file merely referenced by path: those never enter the attachment store). Session scans are bounded (5,000 logs, 32 MiB per log, 20,000 frames, 50,000 objects), and the tab shows a coverage banner when the scan was truncated. PDFs and documents get generated type cards rather than page thumbnails. Search is metadata-only. `library_read` returns text, not image bytes. Filed copies and their manifest are ordinary workspace files and are not deleted when the plugin is removed.

## Trust model

All routes are same-origin and registered on the host's existing web server — no second listener. Bytes are served only for a SHA present in the index, marked `available`, whose path resolves inside the attachment store, so there is no client-supplied path anywhere.

`/object` renders inline only an allowlist — `application/pdf`, `image/png`, `image/jpeg`, `image/gif`, `image/webp`, `image/avif`, `text/plain`. Anything else, explicitly including `image/svg+xml`, `text/html` and `application/xhtml+xml`, is `application/octet-stream` with an `attachment` disposition: user markup must never execute in the GUI's origin. Every response keeps `nosniff` and a sandboxed CSP. Ranges are a single `bytes=a-b` form (206, or 416 when unsatisfiable), the ETag is the digest, and the cache header is immutable.

A session id is resolved to a workspace by the host from its own session header, and that is also the only source of the scope filter — the browser can ask for `workspace` or `all`, never for a path. Destination paths must resolve inside `<workspace>/library`, and hostile names, traversal and symlinked library directories are refused. Index JSON never contains an absolute path; a row reports `state` and the deprecated boolean `inWorkspace`. Request bodies, copies, thumbnails and scans are capped. The plugin makes no outbound network request, reads no credentials, and writes only its cache plus the workspace `library/` directory.

## Compatibility

Built and tested against DeepSeek Harness 0.2.2-rc.3; declared range `>=0.2.2-rc.3 <0.3.0`. Pure JavaScript, no native modules, no desktop helpers and no build step at install time.
