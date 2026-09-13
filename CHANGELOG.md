# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] — unreleased

Makes the repository hold the whole library, files included. Not yet exercised inside a
running Zotero — see the verification note below.

### Added

- **Annotations.** Highlights, underlines, notes, image and ink annotations on PDFs, EPUBs
  and snapshots are exported with their attachment and restored on import.
- **Standalone attachments.** PDFs without a parent item now upload their files; 0.1.0
  exported only their metadata.
- **Images embedded in notes**, linked to from the Markdown.
- **Linked files**, on by default (*Include linked files*). On import, a linked file whose
  path doesn't exist becomes a stored file.
- **Whole snapshot directories**, so snapshots keep their resources.
- **Git LFS** for files above a threshold (50 MB by default, up to 95 MB), via the LFS
  batch API, with a directory-scoped `.gitattributes`.
- **Saved searches** (`searches.json`) and **tag colors** (`settings.json`), both
  restored on import without overwriting local ones.
- **Collection relations** in `collections.json`.
- **Warnings** for skipped files, shown in the progress window and the settings pane.
- **Full restore on import.** Attachments keep their keys and files go back into Zotero's
  storage directory, from Git or LFS. Files already present at the right size are skipped.
- **Annotations section** in Markdown notes.
- Change-triggered sync also reacts to collection membership, saved search and setting
  changes.
- **Toolbar button next to Zotero's sync button**, part of the plugin: spins while syncing,
  shows the percentage beside the icon and details in its tooltip, turns red with a dot on
  failure. Click to sync or show progress; right-click for Cancel, Import, Open repository
  and Settings.
- **Live progress** in a progress window and in the settings pane (files, megabytes,
  percentage, and when a rate-limit wait ends), with a **Cancel** button.
- **Sync to GitHub after Zotero's own sync finishes** (off by default).
- **Batched uploads.** Text files (item JSON, Markdown, LFS pointers) travel inside tree
  requests, up to 300 per request, instead of one blob request each: a first sync of a
  1,740-item library went from about 3,500 upload requests to a few dozen.
- **Checkpoint commits.** Metadata and notes are committed first; attachment files follow in
  commits every 100 MB, 150 files or 5 minutes. A cancelled or failed sync keeps what it
  committed, and the next sync continues from there.
- **Rate limiting.** Content-creating requests are paced at 70 a minute, under GitHub's
  secondary limit of 80, and rate-limit responses are waited out with `retry-after` or
  exponential backoff (up to six times, fifteen minutes each) instead of failing the sync.
- **Empty repositories.** A repository with no commits gets an initial commit through the
  Contents API, since the Git Data API refuses to work on one.
- Tutorial with screenshots in English and Indonesian, and a scripted way to retake the
  screenshots in a throwaway profile.

### Changed

- **Everything is on by default**: attachment files, linked files, group libraries, Git
  LFS. The default attachment size limit is now none (0).
- **Layout.** `items/`, `attachments/` and `notes/` are sharded to stay under GitHub's
  3,000-entries-per-directory recommendation. One JSON file per top-level item now carries
  all of its descendants under `children`, instead of one file per child.
- `version` is no longer written to item JSON; it changed on every Zotero server sync.
- JSON key sorting now works on objects created by Zotero (0.1.0 compared against the
  plugin sandbox's `Object`, which never matched), and sorting no longer depends on locale.
- Attachment files are never read during export. Hashes are computed in 4 MB chunks and
  cached by size and modification time in the profile directory; blob uploads of large
  files run one at a time; LFS uploads stream from disk.
- Every uploaded blob's SHA is checked against the local hash before committing.
- Content already in the repository under another path is not uploaded again.
- Import downloads files by streaming them to disk instead of decoding base64 in memory.

### Fixed

- **Every sync failed with "Items already loading for library 1".** The exporter called
  `Zotero.Items.loadAll()`, which may only run once per library; it now waits on
  `library.waitForDataLoad('item')`.
- **Saving or removing the token failed** on Zotero 10 with
  `Services.logins.modifyLoginAsync is not a function`; the synchronous `modifyLogin()` and
  `removeLogin()` exist on every supported version.
- **A token that couldn't see the repository** was reported as a 403 from an attempt to
  create it. The sync and *Test connection* now say the token lacks access and how to grant
  it.
- **Errors opened modal alerts.** On some window managers a modal dialog is drawn too small
  to dismiss, which locks Zotero. All messages are now passive notifications.
- **A 409 was retried as if the branch had moved**, and parallel uploads kept going after
  one failed. Only a refused ref update is retried now, and a failure stops the batch.
- **The plugin could not be installed.** Zotero 10 rejects any plugin manifest without
  `applications.zotero.strict_max_version` (alongside `id` and `update_url`), and deletes
  a sideloaded XPI that fails that check. The manifest now declares `"10.*"`.
- A sync on a computer that hadn't downloaded an attachment file would have pruned the copy
  another computer uploaded. Such files are now kept.
- Blob uploads had a fixed two-minute timeout regardless of file size.
- Documentation suggested enabling Git LFS on the repository for large PDFs; uploads through
  the Git Data API bypass LFS, so that had no effect. The plugin now uploads to LFS itself.

### Verification status

Run in Zotero 10.0 (source build, Linux/Wayland): the manifest is accepted, the plugin
starts, the preference pane and toolbar button appear, the token saves, and a first sync of
a 1,740-item library (about 700 MB of attachments, two files through Git LFS) into an empty
private repository completed in five commits with no error. The toolbar states, progress
window, settings pane and plugin manager were rendered and captured in a throwaway profile.

Not yet run end to end: *Import from GitHub*, conflicts between two computers, syncs of
group libraries, and installing through **Install Plugin From File…** on Zotero 10 (the test
install was placed in the profile directly).

Exercised standalone under Node: chunked base64 across block boundaries against Node's
encoder, the Git blob hash, LFS pointer writing and parsing, key and letter sharding, JSON
sorting of objects from another realm, repository-tree grouping for both layouts, and the
parent-before-child import order.

Everything that touches Zotero (export of annotations and files, the hash cache,
`nsICryptoHash`, storage-directory writes, the preference pane), every GitHub API call and
every Git LFS call has **not** been run yet.

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
