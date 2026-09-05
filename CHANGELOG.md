# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] — unreleased

First release. Not yet exercised inside a running Zotero — see the note below.

### Added

- **Push to GitHub.** Exports each item as Zotero API JSON plus derived metadata, and as
  an Obsidian-style Markdown note with YAML front matter, alongside `collections.json`,
  `library.json`, a per-library `index.md`, a generated `README.md`, and an optional
  BibTeX export.
- **Change detection.** File contents are hashed locally with Git's own blob hash, so an
  unchanged library produces no commit and only changed files are uploaded.
- **Single-commit syncs.** Uses the Git Data API (blobs → tree → commit → ref), so any
  number of changed files lands as one commit. Tree entries are chunked 200 at a time and
  blobs upload four at a time.
- **Triggers.** Toolbar button with a dropdown, a Tools menu, item and collection context
  menus, a periodic timer, a debounced library-change watcher, and an optional sync one
  minute after startup.
- **Safe pruning.** Deleted items' files are removed from the repository, but only paths
  recorded in `.zotero-sync/files.json` — the list the plugin wrote itself — are ever
  eligible, so syncing into a repository root cannot touch unrelated files.
- **Import from GitHub.** Rebuilds collections and items on a new machine, adding what is
  missing and refreshing items whose repository copy is newer. Never deletes locally.
- **Attachments.** Optional upload of stored files under a configurable size limit
  (25 MB by default), with re-import under the parent item on the way back.
- **Group libraries.** Optional, each in its own directory keyed on group ID.
- **Repository creation.** Creates the repository (public or private) and the target
  branch when they do not exist yet.
- **GitHub Enterprise.** Configurable API URL.
- **Preference pane** with a connection test that reports the authenticated user, whether
  the repository exists, and whether the token can actually write to it.
- **Token storage** in Zotero's login manager rather than in `prefs.js`.
- **Error handling** that names the actual cause for 401/403/404/409/422, with bounded
  retries for rate limits and 5xx, and one automatic retry when the branch moves mid-sync.
- **English and Indonesian** interface strings.
- **Dependency-free build** producing an installable XPI, and a GitHub Actions workflow
  that publishes it on tag.

### Known limitations

- Push is the primary direction; import is a recovery path, not a second sync engine.
- Attachment keys are not preserved across an export/import round trip — Zotero assigns a
  new key on import. Item and collection keys are stable.
- Attachment *items* are not imported without their files, to avoid leaving broken links
  in the library.
- Import downloads one blob per item, so a large library takes a while and uses a
  noticeable share of the hourly API quota.
- Retitling an item renames its Markdown note, which appears in Git history as a delete
  plus an add. `items/<KEY>.json` never moves.

### Verification status

The pure logic has been exercised standalone under Node: the Git blob hash (matches
`git hash-object`), base64 round-trips, the HTML-to-Markdown converter including nested
lists, deterministic JSON serialization, commit-message templating, the repository-tree to
library grouping, XHTML well-formedness, and that the built XPI is a valid ZIP.

The XUL paths (menu injection, toolbar button, preference pane) and every GitHub API call
have **not** been run yet — that needs an installed Zotero and a real token. Treat 0.1.0
as untested until someone has installed it.
