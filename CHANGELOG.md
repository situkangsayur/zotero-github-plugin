# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.2] — 2026-09-25

### Fixed

- **The "Remove files from the repository when their items are deleted" preference did nothing.**
  It was read but never used, so a full sync deleted files on the server even with the box
  unchecked. The planner now honours it: with pruning off, files whose items are gone here stay
  on the server and are counted as unchanged. Reported by a reader of the source.
- **Repository paths are checked before they become local paths.** A file path from the Git tree
  was joined onto the attachment's storage folder as-is; a component of `.`, `..` or an empty
  segment could have written outside that folder. Git does not normally allow such a tree, but
  the path comes from the server, so each segment is now validated and a bad one is reported as
  a failure instead of written.
- **"Keep both" could lose the other files of a multi-file attachment.** After importing the
  repository's copy, the plugin deleted its temporary folder recursively -- and a web snapshot's
  files share one temporary folder, so the files not yet imported went with it. The folder is
  now removed once, after every copy has been imported.

## [0.3.1] — 2026-09-14

### Fixed

- The collection context menu and Tools menu commands did nothing on Zotero 10: they called
  `ZoteroPane.getSelectedCollection()`, which Zotero 10 removed (it now throws). The plugin uses
  `getSelectedCollections()` where available.

## [0.3.0] — 2026-09-13

### Added

- **Three-way sync.** Each computer keeps, per repository, the blob SHA of every file it
  last synced (`<profile>/zotero-github-sync/state/`). Every sync compares Zotero's export,
  the branch, and that record, and sorts each path into: upload, delete, changed on GitHub,
  changed in both places, deleted on GitHub, or a generated file edited on GitHub.
  Installations upgrading from 0.2 adopt the branch as their record when this computer made
  its latest commit.
- **Review panel**, drawn inside Zotero's main window (not a separate or modal window):
  import changes from GitHub, choose Zotero's or GitHub's version when both changed — or keep
  both, for files — upload items deleted on GitHub again, and exclude any file the sync would
  replace or delete. **Tools → GitHub Sync → Review Changes and Sync…** opens it on demand.
- **Background syncs never decide for you.** They upload what is safe, leave everything that
  needs a decision untouched, and mark the toolbar button with an orange dot and a count.
- A computer syncing a repository for the first time compares modification dates to tell
  which side of a differing item is newer, and treats anything it can't tell apart as a
  conflict.
- `scripts/conflict-test/`: a scripted two-computer test in throwaway profiles.

### Changed

- **Deletion is driven by the last-synced record**, not by what this computer's library
  happens to contain: a computer that is behind can no longer delete another computer's
  items from the repository. A computer with no record deletes nothing.
- **Import never replaces a local attachment file that differs** from the repository copy;
  it keeps the local file and reports it. Choosing GitHub's version in the review replaces
  it; "keep both" adds the repository copy as a second attachment.
- Imported items keep the repository's modification date, so exporting them again produces
  identical files instead of another commit.

### Fixed

- **Stale reads after a commit.** GitHub marks API responses cacheable for 60 seconds, and
  a branch head served from the HTTP cache made the next commit build on an outdated parent,
  which GitHub refused as "not a fast forward" — for example when two computers synced within
  a minute. Requests now bypass the cache.
- **Annotations were also exported as top-level items**, each with its own item JSON and
  Markdown note, because `Zotero.Items.getAll(…, onlyTopLevel)` includes them. They are now
  only written under their attachment; the first sync with 0.3.0 removes the extra files.

### Verification status

On Zotero 10 (Linux), two throwaway profiles took turns syncing one repository: a first sync
into an empty repository; an empty second computer importing everything through the review
with no extra commit; edits, a deletion and an addition on the first computer; the second
computer, still behind, editing the same item and adding a note in a background sync — its
note was uploaded while the first computer's edit, addition and deletion were all left
intact and flagged for review; the review then taking GitHub's version of the conflicting
item, importing the addition and declining to re-upload the deleted item; and the first
computer accepting the other's note. The review panel, attention state and all other
screenshots were rendered in Zotero.

## [0.2.1] — 2026-09-13

### Fixed

- **Import from GitHub skipped every attachment and annotation.** Zotero's `fromJSON()`
  applies fields in key order and refuses an attachment's filename before its link mode, or
  any annotation field before its type; the exporter's alphabetical keys put them the wrong
  way round, so 0.2.0 restored metadata and notes but no files. The importer now puts the
  fields `fromJSON()` depends on first.

### Verification status

*Import from GitHub* run end to end in an empty headless profile on Zotero 10 against the
repository written by the 0.2.0 sync: all 1,740 top-level items, 288 attachments, 42
annotations, 41 notes and 58 collections were created, with counts per item type identical
to the source library, and all 195 attachment files (two from Git LFS) restored with
SHA-256 hashes identical to the originals. It took about nine minutes.

## [0.2.0] — 2026-09-13

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
