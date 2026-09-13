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
    ├── files.js        attachment files on disk: hashing, hash cache, transfers
    ├── prefs.js        preference access, token storage
    ├── github.js       GitHub REST client and Git LFS client
    ├── planner.js      three-way comparison: what to push, delete, import or ask about
    ├── state.js        what this computer last synced, per repository
    ├── exporter.js     Zotero library -> repository files
    ├── importer.js     repository files -> Zotero library
    ├── sync.js         analyse, decide, act; scheduling
    ├── review.js       review panel inside the main window
    └── ui.js           toolbar button, menus
```

The dependency direction is one-way: `ui` and `sync` know about `exporter`, `importer`,
`github` and `prefs`; those know about `files` and `utils`; `utils` knows about nothing. Nothing
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
   `Map<relativePath, entry>`. Generated files (JSON, Markdown) are `{bytes}`. Attachment
   files are `{source: {path, size, mtime}, lfs}` — nothing reads them yet. It also returns
   *keep prefixes* for attachments whose file is not on this computer, and warnings for
   files it had to skip. Nothing has touched the network yet.
3. **Ensure the repository.** Create it if it is missing and the user allowed that.
4. **Resolve the head.** Read the branch tip. A missing branch is created from the
   default branch; a completely empty repository means the first commit has no parent.
5. **Keep.** Remote files under a keep prefix that the export didn't produce are marked
   as kept: not uploaded, not deleted, still listed as managed.
6. **File list.** On a full sync, `.zotero-sync/files.json` is appended — the sorted list
   of every path the plugin manages, kept paths included. This is what makes pruning safe.
7. **Diff.** Compute each file's Git blob hash and compare against the remote tree.
   Generated files are hashed in memory. Attachment files come from the hash cache, or are
   hashed from disk in 4 MB chunks. An LFS file's blob is its pointer, so its SHA-256 is
   what gets cached and the pointer is hashed. Content that already exists anywhere in the
   tree is not uploaded again.
8. **LFS upload.** Objects for changed LFS pointers go to Git LFS through the batch API,
   streamed from disk. This happens before any commit, so the branch never points at an
   LFS object that isn't there.
9. **Text in trees.** Every changed text file (item JSON, Markdown, pointers) is sent as
   inline `content` in tree requests — up to 300 entries or 3 MB each — so thousands of
   files cost a few dozen requests. On a first sync these are committed straight away.
10. **Blobs in checkpoints.** Attachment files go up as blobs, three at a time below 8 MB
    and one at a time above, each SHA checked against the local hash. Every 100 MB, 150
    files or 5 minutes the pending entries become a commit and the branch moves.
11. **Final commit.** Whatever is left, `files.json`, and the deletions.
12. **Record.** Write `lastSync`, `lastCommit`, `lastWarnings`, clear `lastError`.

### Rate limits

GitHub allows 80 content-creating requests a minute per account. A `RateLimiter` shared by
all syncs spaces POST/PUT/PATCH requests at 70 a minute. When GitHub still answers 403 or
429 for rate limiting, the client waits for `retry-after`, for `x-ratelimit-reset`, or —
with neither header — a minute doubling on each attempt, up to six attempts and fifteen
minutes per wait. A 403 that isn't about rate limits is never retried. Every wait listens to
the cancel token, so **Cancel** takes effect immediately.

### Progress and cancellation

`Sync.progress` holds the current phase, file and byte counts, and the end of any rate-limit
wait. Every change calls `UI.onStatusChange()`, which updates the toolbar button (spinning
icon, percentage label, tooltip) and the progress window; the settings pane polls it every
second. `Sync.cancel()` trips a `CancelToken` checked between files and inside every wait;
the sync then ends as `cancelled`, with any checkpoints already on the branch.

If nothing changed and nothing needs deleting, step 8 onward is skipped and the sync ends
as `up-to-date` — no commit, no empty history entry.

### Why the Git Data API

The obvious approach — the Contents API, one `PUT /repos/{owner}/{repo}/contents/{path}`
per file — produces one commit per file and one rate-limited request per file. Syncing a
thousand-item library would mean thousands of commits.

Blobs → tree → commit → ref instead produces one commit for an ordinary sync however many
files changed — a large first sync adds a few checkpoint commits — and text files ride
inside the tree requests, so only attachment files cost a request each. A sync that changes
nothing costs three requests total, however many PDFs the library holds.

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

### Three-way comparison

Two versions of a file can't say which side changed. The plugin keeps a third: for every
path, the blob SHA both sides held after this computer's last successful sync (`State`, one
JSON file per repository, branch and base path, in the profile directory — it describes
this computer and must not travel with the library). `Planner.plan()` then classifies each
path from `local` (export), `remote` (branch) and `base`:

| local vs remote vs base | Action |
| --- | --- |
| local = remote | nothing |
| remote = base, local differs | push |
| local gone, remote = base | delete (if the path is on `files.json`) |
| local = base, remote differs, or only on the remote | incoming |
| all three differ | conflict |
| remote gone, local still there | restore |
| no base, both differ | diverged: item dates decide, otherwise conflict |

Generated files (Markdown, indexes, manifests) can't be imported, so a server-side edit to
one is reported as *overwrite* rather than incoming. Paths kept because their file isn't on
this computer are left out entirely.

`Sync._runSync()` runs in three stages. **Analyse** exports, reads the branch, hashes, loads
the base and plans. **Decide** returns immediately when nothing needs a decision; otherwise
a manual sync awaits `Review.ask()` and a background sync takes no decision at all. Accepted
changes are imported with `Importer.applyIncoming()`, which forces updates and overwrites
files because that was the choice, and the sync starts over with the same decisions — the
library changed, so the export must be redone. **Act** pushes and deletes, then stores the
next base with `Planner.nextBase()`: a path is recorded only where both sides now agree, and
every undecided or excluded path keeps its old record, so the same question comes back next
time instead of silently becoming a push or a delete.

### Pruning only touches our own files

Deleting remote files that no longer exist locally is the dangerous half of a sync. Naïve
approaches — "delete everything under the base path that we did not just write" — destroy
unrelated files the moment someone points the plugin at a repository root.

Instead two records must agree before anything is deleted. `.zotero-sync/files.json` is the
sorted list of paths the plugin wrote on the last full sync: a file the plugin has never
written is not on it and can never be deleted, so pointing the plugin at a repository root
is safe. And the base above must show that this computer synced the path and that the
branch still holds exactly that version: a path merely absent from this computer's export —
because another computer added it — is incoming, not a deletion. A computer with no base
deletes nothing at all.

The list is also the reason partial syncs — selected items, a collection — never prune:
they are not authoritative about what the library contains, so they do not rewrite the
list and do not delete.

### Attachment files never sit in memory together

Reading every PDF on every sync would make a 5 GB library cost 5 GB of RAM every few
minutes. Instead:

- `Files.cachedHash()` keeps a cache in `<profile>/zotero-github-sync/hash-cache.json`,
  keyed on absolute path and validated by size and modification time. An unchanged file is
  never opened again. A full sync drops entries for files it no longer exports.
- Hashing reads 4 MB at a time into `nsICryptoHash`.
- A file is read whole only when it is actually being uploaded as a Git blob, which the LFS
  threshold caps at 95 MB, and large blobs upload one at a time.
- LFS uploads pass a `File` as the `fetch()` body, so they stream from disk.

The cache is safe to delete; it only costs rehashing. If a cached hash were ever wrong, the
upload check in step 9 would catch it: GitHub's SHA for the received blob would not match.

### Files that aren't on this computer

With "download files as needed", Zotero on a given computer knows an attachment exists but
has never downloaded it. Treating that as a deleted file would prune the copy another
computer uploaded. The exporter marks such attachments with keep prefixes instead — both
`attachments/<KE>/<KEY>/` and `attachments-lfs/<KE>/<KEY>/` — and whatever is there
survives, still on the managed-file list, until the attachment itself is deleted.

The same applies when attachment syncing or linked-file syncing is turned off: turning an
option off stops uploads but doesn't delete what is already in the repository.

### Git LFS

`GitLFS` in `github.js` speaks the [batch API](https://github.com/git-lfs/git-lfs/blob/main/docs/api/batch.md)
directly, with Basic auth (the account login and the personal access token). The LFS
endpoint is derived from the API URL — `github.com/<owner>/<repo>.git/info/lfs` — and can
be overridden with the `lfsURL` preference.

The plugin writes exactly what git-lfs would: an uploaded object, a pointer blob in the
tree, and a `.gitattributes` scoped to `attachments-lfs/`. Scoping it there means it can
never collide with a `.gitattributes` the user keeps at the repository root.

### Retrying a moved branch

If another machine syncs between reading the head and updating the ref, GitHub rejects the
non-fast-forward update. The ref update marks that error as `branchMoved`, and
`_runSyncWithRetry()` redoes the sync once against the new head. No other 409 or 422 is
retried. The second pass is cheap: every checkpoint already on the branch is skipped by the
diff.

## Triggers and scheduling

`Sync.updateSchedule()` is the single place that reconciles timers with preferences. It
runs at startup and again from a `Zotero.Prefs` observer whenever one of the four
scheduling preferences changes, so toggling a setting takes effect immediately.

| Trigger | Mechanism |
| --- | --- |
| Toolbar button, menus | `command` listeners in `ui.js` |
| Interval | `setInterval` at the configured minutes |
| Library change | `Zotero.Notifier` observer on `item`, `collection`, `collection-item`, `item-tag`, `search`, `setting` |
| Startup | one `setTimeout`, one minute after `startup()` |
| After Zotero's sync | `Zotero.Notifier` observer on `sync` / `finish` |

The change observer does not sync on the notification. Editing a single item fires a
stream of them, so it resets a debounce timer instead and syncs only once the user has
been quiet for the configured number of minutes.

Two flags keep the observer from feeding itself: `_running` (a sync in progress ignores
notifications) and `_suppressChangeTrigger` (set during an import, which writes to the
library and would otherwise immediately trigger a push).

Background syncs — interval, change, startup, after Zotero's sync — pass `silent: true`.
They open no progress window; the toolbar button shows them, and a failure appears as a
passive notification. Nothing in the plugin opens a modal alert: on some window managers a
modal dialog is drawn too small to dismiss and locks the application.

## Error handling

`github.js` translates HTTP status codes into messages that name the actual cause (an
expired token, a token without Contents write, a repository the token cannot see) rather
than echoing GitHub's generic text.

Retries are narrow and bounded:

- **Rate limits** (403/429 with `retry-after`, an exhausted quota with a reset time, or a
  "rate limit" message) — wait and retry, up to six times, as described under
  [Rate limits](#rate-limits). The wait shows on the toolbar button and can be cancelled.
- **5xx** — two retries, after two and four seconds.
- **Everything else** — thrown immediately. A 401 will not fix itself.

Blob uploads pass `logBodyLength: 0` so base64 payloads never reach the debug log.

## The import direction

`Importer` is deliberately not a second sync engine. It:

- adds items the library does not have, matched by Zotero key;
- refreshes items whose repository copy has a newer `dateModified`;
- recreates missing collections first, so items land in the right place;
- restores attachment files that are missing or have the wrong size;
- adds missing saved searches and tag colors, never overwriting local ones;
- **never deletes anything locally.**

Worst case, a bug here costs a duplicate, not data. That asymmetry is the whole design.

Items are saved parents first — regular items, then their notes and attachments, then
annotations and note images — and every item keeps its key, attachments included. That is
what lets an annotation find its PDF and a note find its images. `version` is stripped so
Zotero's own sync treats restored items as local changes, and references to parents and
collections that do not exist locally are dropped rather than failing validation.

Attachment files go into `storage/<KEY>/`, where Zotero's own file sync puts them. Blobs
stream to disk from the raw blob endpoint; LFS files stream from the URLs the batch API
hands out. Each download lands in a temporary file first, so a failure never leaves a
truncated PDF. Files already present at the right size are skipped, which makes a second
import cheap.

A linked file whose path doesn't exist on the importing computer becomes a stored file,
since a link to nothing is useless. A linked file that does resolve is left pointing at the
user's own copy.

Import reads one blob per top-level item, so a large library takes a while and uses a share
of the hourly API quota; attachment files add one request each.

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
