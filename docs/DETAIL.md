# File library

A searchable right-sidebar library of every file ever sent to DSH, with one-click reuse.

## What it adds

- A new right-sidebar tab type, **File library** (`library`). It does not replace the built-in `files` tab.
- A thumbnail grid and a list view, type chips, search, recency order and multi-select.
- **File this**: copies an indexed attachment into `<workspace>/library/<name>.<ext>`, updates `library/.manifest.json` and regenerates `library/INDEX.md`.
- **Use in chat**: files the file if needed and inserts `@library/<name>` into the current composer.
- Two agent tools: `library_list` (search and filter) and `library_use` (file and return the reference).

## How files arrive

The host reads DSH's existing attachment objects and v4 session logs. Original names, media types, sizes, times and session titles live only in those logs; the plugin joins them to the object store. It never re-uploads, moves or deletes attachment bytes.

A warm start loads a metadata cache (`$DSH_HOME/cache/dsh-file-library/index.v1.json`) immediately and rebuilds changed sessions in the background. A cold start scans bounded logs once and shows an indexing state.

## Where to find it

Open the right sidebar, use the add control or the guide, and pick **File library**. Press `/` in the tab to focus search, arrows to move, `Enter` to use, `Esc` to clear.

## Limits

User-sent attachments only (not tool-generated images). Session scans are bounded (5,000 logs, 32 MiB per log, 20,000 frames, 50,000 objects). PDFs and documents get generated type cards rather than page thumbnails. Search is metadata-only. Filed copies and their manifest are ordinary workspace files and are not deleted when the plugin is removed.

## Trust model

All routes are same-origin and registered on the host's existing web server — no second listener. Bytes are served only for a SHA present in the index. A session id is resolved to a workspace by the host from its own session header; destination paths must resolve inside `<workspace>/library`, and hostile names, traversal and symlinked library directories are refused. Request bodies, copies, thumbnails and scans are capped. The plugin makes no outbound network request, reads no credentials, and writes only its cache plus the workspace `library/` directory.

## Compatibility

Built and tested against DeepSeek Harness 0.2.2-rc.3; declared range `>=0.2.2-rc.3 <0.3.0`. Pure JavaScript, no native modules, no desktop helpers and no build step at install time.
