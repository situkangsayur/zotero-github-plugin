# Architecture

How the plugin is put together and why. For the file format it produces, see
[DATA-FORMAT.md](DATA-FORMAT.md); for building and debugging, see
[DEVELOPMENT.md](DEVELOPMENT.md).

## Module map

Zotero loads `bootstrap.js` into a per-plugin sandbox and calls `startup()`,
`onMainWindowLoad()`, `onMainWindowUnload()` and `shutdown()`. `bootstrap.js` does one
thing: it loads every file in `src/` into that same sandbox with
`Services.scriptloader.loadSubScript()`, so the modules share one scope and one `Zotero`
global. `src/core.js` declares the `ZoteroGitHubSync` namespace; every other file hangs
one object off it.

```
bootstrap.js            Zotero lifecycle hooks
└── src/
    ├── core.js         namespace, init/shutdown, localized strings
    ├── utils.js        pure helpers, no Zotero or GitHub knowledge
    ├── prefs.js        preference access, token storage
    ├── github.js       GitHub REST client
    ├── exporter.js     Zotero library -> repository files
    ├── importer.js     repository files -> Zotero library
    ├── sync.js         diffing, committing, scheduling
    └── ui.js           toolbar button, menus
```

The dependency direction is one-way: `ui` and `sync` know about `exporter`, `importer`,
`github` and `prefs`; those know about `utils`; `utils` knows about nothing. Nothing
depends on `ui`, which is why the plugin still works headlessly (a timer-driven sync
needs no window).

`core.js` also assigns `Zotero.GitHubSync = this`. That is the only bridge to the
preference pane, which runs in the preferences window and cannot see the plugin sandbox —
the `Zotero` global is the one object both sides share.

## The sync pipeline

One sync is `Sync.syncNow()` → `_runSyncWithRetry()` → `_runSync()`:

1. **Guard.** Refuse if a sync is already running, if owner/repo/token are missing, or if
   a selection-scoped sync was handed an empty selection.
2. **Export.** `Exporter.build()` walks the libraries and returns a
   `Map<relativePath, {bytes}>`. Nothing has touched the network yet.
3. **File list.** On a full sync, `.zotero-sync/files.json` is appended — the sorted list
   of every path the plugin manages. This is what makes pruning safe (below).
4. **Ensure the repository.** Create it if it is missing and the user allowed that.
5. **Resolve the head.** Read the branch tip. A missing branch is created from the
   default branch; a completely empty repository means the first commit has no parent.
6. **Diff.** Hash every exported file locally with Git's blob hash and compare against the
   remote tree. Files whose hash already matches are skipped entirely.
7. **Upload.** Create a blob per changed file, four at a time.
8. **Commit.** Build tree entries (deletions are entries with `sha: null`), chunk them 200
   at a time layering `base_tree`, create one commit, move the ref.
9. **Record.** Write `lastSync`, `lastCommit`, clear `lastError`.

If nothing changed and nothing needs deleting, step 7 onward is skipped and the sync ends
as `up-to-date` — no commit, no empty history entry.

### Why the Git Data API

The obvious approach — the Contents API, one `PUT /repos/{owner}/{repo}/contents/{path}`
per file — produces one commit per file and one rate-limited request per file. Syncing a
thousand-item library would mean thousands of commits.

Blobs → tree → commit → ref instead produces exactly one commit no matter how many files
changed, and costs one request per *changed* file plus a small constant. A sync that
changes nothing costs three requests total.

### Determinism is a correctness requirement

Exporting an unchanged library twice must produce byte-identical files. If it did not,
every scheduled sync would find a diff and commit, and a 5-minute interval would add 288
junk commits a day.

That constraint shapes the exporter:

- `stableStringify()` sorts object keys recursively, so JSON output does not depend on
  insertion order.
- Arrays that Zotero returns in unstable order (`tags`, `collections`) are sorted.
- Nothing embeds a timestamp. `manifest.json` carries the schema and plugin version, not
  a "generated at" field — that alone would defeat the whole scheme.
- Items are sorted by key before `index.md` and `library.bib` are built.

The plugin version *is* in `manifest.json`, so upgrading produces exactly one extra
commit. That is deliberate: it dates the format the repository was written with.

### Pruning only touches our own files

Deleting remote files that no longer exist locally is the dangerous half of a sync. Naïve
approaches — "delete everything under the base path that we did not just write" — destroy
unrelated files the moment someone points the plugin at a repository root.

Instead the plugin keeps `.zotero-sync/files.json`: the sorted list of paths it wrote on
the last full sync. Pruning is `previous_list − current_export`, intersected with what is
actually in the tree. A file the plugin has never written is not on the list and can never
be deleted. A repository with no `files.json` yet (a first sync into an existing
repository) prunes nothing at all.

The list is also the reason partial syncs — selected items, a collection — never prune:
they are not authoritative about what the library contains, so they do not rewrite the
list and do not delete.

### Retrying a moved branch

If another machine syncs between reading the head and updating the ref, GitHub rejects the
non-fast-forward update. `_runSyncWithRetry()` catches that (422/409) and redoes the sync
once against the new head. The second pass is cheap: every blob it already uploaded is
still there, so the diff finds almost nothing to send.

## Triggers and scheduling

`Sync.updateSchedule()` is the single place that reconciles timers with preferences. It
runs at startup and again from a `Zotero.Prefs` observer whenever one of the four
scheduling preferences changes, so toggling a setting takes effect immediately.

| Trigger | Mechanism |
| --- | --- |
| Toolbar button, menus | `command` listeners in `ui.js` |
| Interval | `setInterval` at the configured minutes |
| Library change | `Zotero.Notifier` observer on `item`, `collection`, `item-tag` |
| Startup | one `setTimeout`, one minute after `startup()` |

The change observer does not sync on the notification. Editing a single item fires a
stream of them, so it resets a debounce timer instead and syncs only once the user has
been quiet for the configured number of minutes.

Two flags keep the observer from feeding itself: `_running` (a sync in progress ignores
notifications) and `_suppressChangeTrigger` (set during an import, which writes to the
library and would otherwise immediately trigger a push).

Background syncs — interval, change, startup — pass `silent: true`. They open no progress
window on success and surface only failures, as a passive notification rather than a modal
alert.

## Error handling

`github.js` translates HTTP status codes into messages that name the actual cause (an
expired token, a token without Contents write, a repository the token cannot see) rather
than echoing GitHub's generic text.

Retries are narrow and bounded:

- **403/429 with `Retry-After`, or 403 with an exhausted quota and a reset time** — wait
  and retry, up to 90 seconds. Anything longer is reported instead of silently hanging.
- **5xx** — one retry after two seconds.
- **Everything else** — thrown immediately. A 401 will not fix itself.

Blob uploads pass `logBodyLength: 0` so base64 payloads never reach the debug log.

## The import direction

`Importer` is deliberately not a second sync engine. It:

- adds items the library does not have, matched by Zotero key;
- refreshes items whose repository copy has a newer `dateModified`;
- recreates missing collections first, so items land in the right place;
- **never deletes anything locally.**

Worst case, a bug here costs a duplicate, not data. That asymmetry is the whole design.

It strips `version` from imported JSON so Zotero's own sync treats the item as a local
change, and drops references to parents and collections that do not exist locally rather
than failing validation.

Attachment *items* are not imported — an attachment item without its file is a permanently
broken link in the library. Attachment *files* are re-imported under their parent through
`Zotero.Attachments.importFromFile()` when the feature is enabled, which means they get
fresh keys. Attachment keys are therefore not stable across an export/import round trip;
item and collection keys are.

## Credentials

The personal access token goes into the Firefox login manager under the origin
`chrome://zotero-github-sync`, following the pattern Zotero uses for its own API key in
`syncLocal.js`. It is deliberately not a preference: `prefs.js` in the profile directory is
plain text.

`Prefs.getToken()` caches the value in memory after the first read, since every sync needs
it and the login manager is async.

## Localization

Strings live in a plain table in `core.js` rather than in Fluent `.ftl` files. Fluent is
what Zotero recommends, but plugin FTL registration differs across Zotero versions, and
menu labels that silently render blank on an older build are a worse failure than a table
lookup. Adding a language is adding one key to `_strings`; English and Indonesian ship
today.

Menus are injected with plain DOM calls rather than `Zotero.MenuManager` for the same
reason — `MenuManager` does not exist in Zotero 7, and manual injection works on every
version from 7 onward. `ZoteroPane.buildItemContextMenu()` addresses its own items by
index, so appended menu items survive its rebuild; the plugin manages their visibility
from a `popupshowing` listener.

## Extension points

- **A new export format** — add a writer in `exporter.js` that puts entries into the
  `files` map. Diffing, uploading, committing and pruning all follow automatically.
- **A new trigger** — call `Sync.syncNow({ trigger: 'name' })`. The trigger name reaches
  the commit message via `{trigger}`.
- **A different Git host** — `github.js` is the only file that knows about GitHub. The
  `apiURL` preference already covers GitHub Enterprise.
