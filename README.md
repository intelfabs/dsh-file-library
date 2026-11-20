Independent implementation. Not affiliated with, and not derived from, Gazesphotograph/dsh-file-library.

# dsh-file-library

A visible, searchable library of every file you have ever sent to DeepSeek Harness — with one-click reuse in any session.

DSH keeps attachment bytes in a content-addressed store, but the original filename survives only inside old session logs. This plugin is the missing bridge: it reads those logs on the host, joins them to the attachment objects, and adds a **File library** tab to the right sidebar. You can see the PDF you sent three months ago, search it by name, file it into the current workspace, and drop `@library/<name>` into the composer.

Version **0.2.5** · MIT · built and tested against **DeepSeek Harness 0.2.2-rc.3**.

## What it does

- **Indexes, not re-uploads.** Reads both of DSH's content-addressed stores — `$DSH_HOME/attachments/v1/objects/<sha[0:2]>/<sha>` for normalized images and `$DSH_HOME/attachments/v1/file-objects/<sha[0:2]>/<sha>` for every other uploaded file (PDFs, Office documents, archives) — and the multi-frame Zstandard session logs under `$DSH_HOME/sessions/`. Generic files log a name and a byte count but no media type, so the type is derived from the name and a missing name is recovered from the store's named reference link. The original media type, size, sending time and source session title come from the logs; the bytes never move.
- **A real tab.** A new right-sidebar kind `library` with a thumbnail grid/list toggle, type chips (PDF / images / docs / sheets / archives), search over name, type, session and tag, recency sort, and multi-select. It does not reuse or replace the built-in `files` kind.
- **Scoped to the chat you are in.** By default the tab lists only files that belong to the current session's workspace: the ones sent from this chat, plus anything already filed into its `library/`. A **This workspace / All files** switch opens the host-wide view; that choice is remembered for **that chat only**, so a wider view never carries into another chat. In the all-files view a row from another workspace is labelled **Other workspace**. The host resolves the workspace from its own session header; the browser never names a path.
- **Open/Preview without copying.** Every row streams its original bytes from `/object/<sha>` in a new tab — PDFs, images and plain text inline, everything else as a download. No file is created in the workspace, and the object store is read directly.
- **File this (only when you need to edit).** Copies one object to `<session workspace>/library/<name>.<ext>`, updates `library/.manifest.json`, and regenerates a plain-text `library/INDEX.md`. Filing is keyed by SHA-256, so doing it twice is a no-op.
- **Import from this computer.** When the composer's file picker is unavailable, the **⤓** button in the tab takes an absolute path, copies the file byte-for-byte into DSH's attachment store, and lists it like any other file. This is an explicit import; an `@path` reference in a message is still not an upload.
- **Use in chat.** Inserts the `@library/<name>` reference into the current session's composer using DSH's existing `@path` insertion service. The agent reads the file by path. A name with a space is inserted as one quoted token — `@"library/Scaling the Supply Peak.pdf"` — because DSH's unquoted `@path` scan stops at the first space.
- **Agent tools.** `library_list`, `library_read` and `library_use`: an agent can find a file, read a text file with no copy, and file a copy only when it must edit.
- **Portable by construction.** Every route lives on the host's existing web server. No second listener, no port, no desktop helper, no native module, no UI framework dependency.

## Layout

```text
┌ File library ───────────────────────── 128 files ┐
│ [ Search name, type or session           / ]     │
│ (All 128) (PDF 41) (Images 63) (Docs 12) (More)  │
│ ┌──────────┐ ┌──────────┐ ┌──────────┐           │
│ │  thumb   │ │  thumb   │ │   PDF    │           │
│ │ Q3.pdf   │ │ chart.png│ │ brief.pdf│           │
│ │ sent 3mo │ │ sent 1y  │ │ sent 2w  │           │
│ │ Q3 review│ │ Charts   │ │ Planning │           │
│ └──────────┘ └──────────┘ └──────────┘           │
│ 2 selected   [File this] [Use in chat] [Clear]   │
└ Enter uses · / searches · Esc clears ────────────┘
```

In list view the same rows become one line each: type badge, name, size, `sent 3 months ago · <session title>`, and a filed marker. At narrow widths the grid collapses to two or three columns; in the fullscreen right-sidebar presentation the panel fills the available height and scrolls internally.

## Install

### Desktop (Settings → Plugins)

1. Open **Settings → Plugins**.
2. Choose **Add plugin** and select this package directory (or a packed `.tgz`).
3. Refresh the page. Open the right sidebar's add control or guide and pick **File library**.

### CLI

```sh
dsh plugin --profile <name> add <path-or-tgz>
```

Examples:

```sh
dsh plugin --profile desktop add ./dsh-file-library-0.2.5.tgz
dsh plugin --profile web add /opt/plugins/dsh-file-library
```

After installation, reload the page. If the plugin manager reports `restart-required` for your surface, restart DSH once; client bundles are reloaded on refresh.

### First run

The first page load can take a few seconds while the host scans session logs; the tab shows an indexing state. The index is then cached under `$DSH_HOME/cache/dsh-file-library/`, and later starts load that cache immediately and rebuild in the background. A listing re-scans when the last scan is older than 30 seconds, and the ↻ button forces a re-scan, so a file sent after DSH started appears without restarting the host.

## Using it

| Action | How |
| --- | --- |
| Search | Type in the search field, or press `/` while the tab is visible. |
| Choose the scope | **This workspace** (default) lists the files of the current session's workspace; **All files** lists every file sent to DSH on this host. The choice is remembered per chat, and rows outside the current workspace are labelled **Other workspace**. |
| Filter by type | Click a chip. Counts are over the files in the current scope, not the current search. |
| Select | Click a row, or use the checkbox. `Space` toggles the focused row. |
| Move | Arrow keys move the focused row; `Down`/`Up` move by a row of the current grid. |
| View | **Open** (or **Preview** for PDFs and images) opens `/object/<sha>` in a new tab. Nothing is copied. |
| Use | `Enter`, double-click, or **Use in chat**. Files first if needed, then inserts `@library/<name>`. |
| File only | **File this** on the selection, or the same button on a row's selection. |
| Clear | `Esc` clears the search and selection. |
| Refresh | The ↻ button re-scans the host session logs, then reloads the list. Use it after sending a file. |
| Import | Click **⤓** in the header, type the file's absolute path, and press **Import**. The file is copied into the attachment store and listed. Use this when the composer's file picker is unavailable. |

The footer of every row reads like `sent 3 months ago · Quarterly reports`, so recognition does not depend on remembering a filename.

## Agent tools

| Tool | Input | Result |
| --- | --- | --- |
| `library_list` | `query?`, `kind?`, `scope?` (`workspace` when the agent session has a workspace, otherwise `all`), `limit?` | Matching rows with SHA-256, original name, type, bytes, send time, source session title and `state` (`filed-here` / `in-workspace` / `global` / `missing`), plus the scan `coverage`. |
| `library_read` | `nameOrSha` (full SHA, SHA prefix, exact name, or a unique part of a name), `maxBytes?` | UTF-8 text for text-like files (256 KiB default, 1 MiB hard cap) with `truncated` and `bytesTotal`; metadata plus a hint for PDFs, images, Office files and archives. Writes nothing, returns no absolute path. |
| `library_use` | `nameOrSha` | Files the file into the current session workspace and returns `@library/<name>` plus the relative path. |

All three degrade to a clear result rather than inventing a file: an ambiguous name returns `{ ambiguous: true, candidates: [...] }` (`sha8`, name, bytes, send time, session, state) instead of silently picking one, an unknown name says so, a missing object reports `state: "missing"`, and `library_use` without a session workspace refuses.

The wording rule is the same in the UI and the tools: **stream or read to view, file a copy to edit.**

## How it works

1. **Session logs.** `session.v4.jsonl.zstd` is a concatenation of independently decodable Zstandard frames. `zlib.zstdDecompressSync` decodes exactly one frame, so the reader walks frame headers structurally and decompresses each complete frame. A torn final frame is ignored. Relevant records are `user/message`, user-origin `agent/inbox/spliced` entries, and `session/title`. A `user/message` whose declared source kind is not `user` is skipped: DSH writes an agent's own tool loop (for example a `read_image` or PDF page crop) as a user-role message with `source.kind = "ptc-mode"`, and those bytes were never sent by a person.
2. **Attachment objects.** The SHA-256 in the log is the object path. The index joins the two and keeps only objects that exist. Files sent under `image.png` may be normalized images; the plugin never assumes the attachment bytes equal the original upload, and never re-uploads them.
3. **Cache.** The index is cached with a per-log `size + mtime` fingerprint. A cold start decodes every changed log; a warm start loads the cache instantly and rebuilds only changed sessions in the background. Each row carries every distinct workspace (cwd) that sent those bytes, deduplicated by resolved path (case-insensitive on Windows), so one digest can belong to several chats at once. The cache format version is bumped whenever that shape changes, which discards an older cache and rebuilds it.
4. **Bytes.** `/object/<sha>` streams the original object with `createReadStream`, `Accept-Ranges: bytes` (206/416), an ETag equal to the digest and an immutable cache header, so a preview costs no workspace copy. `/thumb/<sha>` serves image objects from the same store under a size cap and generates a deterministic SVG type card for everything else. The client always draws a type fallback underneath an image, so a failed image request never leaves a broken image.
5. **Filing.** The host resolves the session id to a workspace root from its own session header, creates `library/`, copies the object through a temporary file, verifies the destination SHA (bounded), then atomically rewrites the manifest and `INDEX.md`.

## What it writes where

| Path | What | Notes |
| --- | --- | --- |
| `$DSH_HOME/cache/dsh-file-library/index.v1.json` | Metadata index and per-log fingerprints | Delete it to force a cold rebuild. |
| `$DSH_HOME/cache/dsh-file-library/thumbs/<sha>.svg` | Generated type cards | Content-addressed; safe to delete. |
| `<session workspace>/library/<name>.<ext>` | Filed copies | Ordinary user-visible files. |
| `<session workspace>/library/.manifest.json` | Filing ledger: `sha`, `name`, `mime`, `bytes`, `addedAt`, `tags`, `source.sessionId`, `source.title` | Source of truth for `INDEX.md`. |
| `<session workspace>/library/INDEX.md` | Human- and agent-readable Markdown index | Regenerated after every change. |

The plugin never writes to, moves or deletes attachment objects. It never modifies session logs.

## Security and trust model

The plugin is written to be safe on a host that is reachable through a browser, a container, a tunnel or a reverse proxy.

- **Same-origin only.** Every route checks `Sec-Fetch-Site` and `Origin`/`Host`; a cross-site browser request is refused. An auth proxy may sit in front, but authorization never depends on it: the routes themselves only answer requests that pass this gate, and a deployment that exposes DSH without authentication is still exposed — the gate is CSRF defense, not user authentication.
- **No raw bytes without an index entry.** `/thumb/<sha>` and `/object/<sha>` answer only for a SHA present in the index, marked `available`, whose object is a regular file and whose path resolves inside `$DSH_HOME/attachments/v1/objects`. A random or orphaned SHA is a 404. There is no client-supplied path parameter anywhere.
- **Inline rendering is an allowlist.** `/object` renders inline only `application/pdf`, `image/png`, `image/jpeg`, `image/gif`, `image/webp`, `image/avif` and `text/plain`. Everything else — explicitly including `image/svg+xml`, `text/html` and `application/xhtml+xml` — is served as `application/octet-stream` with `Content-Disposition: attachment`, because rendering user markup same-origin would be stored XSS against the DSH GUI. Responses keep `X-Content-Type-Options: nosniff` and `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; sandbox`.
- **Workspace resolution is host-owned.** A client sends a session id; the host maps it to a workspace by reading its own session header. Path joins use `node:path`, the resolved destination must stay inside `<workspace>/library`, and a symlinked `library` directory is refused.
- **Hostile names are rejected, not repaired.** A name containing a path separator, NUL, drive letter/UNC prefix or `..` segment is refused with 400; `library/.manifest.json` and `INDEX.md` are reserved. Windows device names and trailing dots/spaces are sanitized at index time.
- **Bounded work and bounded bodies.** Request bodies are capped at 64 KiB, JSON only. Session scans have caps on sessions, log bytes, frames and objects; copies are capped at 256 MiB and SHA verification at 64 MiB per file. Thumbnail bytes are capped at 12 MiB.
- **No egress.** The plugin makes no outbound network request. It reads the attachment store and session logs and writes only the paths above.
- **No secrets.** Routes and tools never read credentials or environment secrets.

## Known limits

- **User-sent files only.** Tool-generated images (for example PDF page renders) are deliberately not indexed; the library is about files *you* sent.
- **Metadata can be stale.** A warm start serves the cache while the background rebuild runs. The refresh button re-reads the host; a file sent seconds ago may need one refresh.
- **Bounded scan.** Defaults: 5,000 session logs, 32 MiB per log, 20,000 frames per log, 50,000 objects, scan depth 4. A log over the byte cap is skipped and counted in status/warnings rather than partially indexed. The index publishes its `coverage` (`truncated`, `sessionsSeen`, `sessionsFound`, `sessionsSkipped`, `logsTooBig`) and the tab shows a banner after a restart when the scan was cut short — the numbers travel in the cache, so a warm start still knows. A cold build is proportional to log volume: on the development machine's 730 logs / 148k frames it took about 9 seconds; the warm start from cache took about 4 ms.
- **No PDF page thumbnails.** Rendering PDFs would need a native or heavy JS engine; PDFs and documents get generated type cards instead. Images use their original bytes, scaled by the browser. **Open** still shows a PDF in the browser's own viewer.
- **`library_read` returns text, not images.** Images, PDFs, Office files and archives come back as metadata plus a hint, because the tool cannot hand a model image bytes without the attachment store's decode and capability gate. The agent gets pixels by filing a copy and calling `read_image`, or you get them straight from **Preview**.
- **HTML and SVG files download.** As attachments they are never rendered in the GUI's origin (see the allowlist above), so open them in an editor instead of a preview tab.
- **Ambiguous names stay ambiguous.** When two different files share an exact name, tools return a candidate list and the UI shows both rows; nothing guesses which one you meant.
- **One row per SHA.** The same object sent in two sessions is one row with an occurrence count; the displayed source is the message whose name is shown. The row remembers every workspace that sent it, so it appears in the scoped view of each of those chats. Names in the logs are whatever the sender stored; the plugin prefers a specific name over a generic `image.png`.
- **Scope is a view, not a permission.** `scope=all` exists for every tab; the workspace scope is a browsing default, not an access control. Files remain in the one attachment store DSH owns, and the JSON never carries an absolute path — only boolean `inWorkspace` and the filing markers.
- **No full-text search.** Search covers metadata (name, type, extension, session title, tags), not document contents.
- **Tags are local.** Tags live in each workspace's `library/.manifest.json`; they are not a global database.
- **No per-user isolation beyond DSH's.** Anyone who can reach the DSH host and pass its own access controls sees the same attachment store the agent sees.
- **Not a file tree, editor, git panel or upload replacement.** Those are separate plugins; v0.2.5 stays inside the scope above. A PDF that was only *referenced by path* (for example `@C:\reports\Q3.pdf`) was never uploaded, so it is not in the attachment store and cannot appear here — attach the file in a chat, or use **⤓ Import** with its absolute path, to add it.
- **Server-rendered layouts are tested offline.** The responsive panel is exercised at 768 px and in fullscreen by deterministic view tests and a real HTTP route suite; a live browser rendering check is listed in the development notes as manual verification.

## Compatibility

- Built and tested against **DeepSeek Harness 0.2.2-rc.3** on Windows 11 x64 with Node 24.14.0.
- Declared supported range: `>=0.2.2-rc.3 <0.3.0`. The plugin relies on the `sidebarRightTabs` / `sidebar.right.pane.tab` seats and the `slash/input-insert-text` composer event of that release line; a DSH minor release that changes those APIs will need a plugin update.
- Runs on any OS Node runs on. No native module, no build step at install time, no desktop environment.

## Uninstall and rollback

- **Desktop:** Settings → Plugins → remove **dsh-file-library**.
- **CLI:** `dsh plugin --profile <name> remove dsh-file-library`.
- Refresh the page (or restart if the surface says so).

Rollback is removal: the plugin is stateless outside the cache. To discard the index cache too, delete `$DSH_HOME/cache/dsh-file-library/`. **Filed copies and `library/INDEX.md` are normal workspace files**; keep them, or remove `library/` yourself if you no longer want them. Removing the plugin never touches the attachment store or session logs.

## Development

```sh
npm test          # 55 offline tests, no network, no DSH install required
npm pack --dry-run
```

The suite covers cold/warm indexing over synthetic multi-frame logs, multi-frame decoding with two attachments, filing idempotency and manifest/INDEX consistency, `@library/...` reuse, `/object` full/HEAD/Range-206/Range-416 responses, the HTML/SVG download allowlist, 404 for unindexed SHAs, traversal rejection, cross-origin refusal, body caps, `library_read` text/truncation/binary/missing behaviour, ambiguity candidates for both tools, coverage surviving a warm start, per-row `state`, the empty/768 px/fullscreen layouts, the plugin entry's route and tool registrations, and a child-process run with an empty `PATH` and no desktop environment.

## License

MIT. See [LICENSE](LICENSE).
