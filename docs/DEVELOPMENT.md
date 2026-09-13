# Development

## Requirements

Node 18 or newer, and a Zotero 7+ installation to test against. That is all — the build
has no dependencies and there is nothing to `npm install`.

## Build

```bash
npm run build
```

Writes `build/zotero-github-sync-<version>.xpi` and prints its size and SHA-256. An XPI is
just a ZIP with `manifest.json` at the root; `scripts/build.mjs` writes one directly
(stored, not deflated, which Zotero accepts) so that producing a release never depends on
the npm registry.

The archive contains `manifest.json`, `bootstrap.js`, `prefs.js`, `README.md`, `LICENSE`,
`src/` and `content/`. Dotfiles are skipped. `docs/`, `scripts/` and `package.json` are
not shipped — they are repository material, not runtime.

## Run from source

Rebuilding and reinstalling an XPI for every change gets old fast. Zotero can load a
plugin straight from a directory instead:

1. Close Zotero.
2. Find your [profile directory](https://www.zotero.org/support/kb/profile_directory) —
   on Linux, usually `~/.zotero/zotero/<random>.default/`.
3. In it, create `extensions/` if it does not exist, then create a **file** (not a folder)
   named exactly:

   ```
   extensions/zotero-github-sync@situkangsayur.github.io
   ```

   whose entire contents is the absolute path to your clone:

   ```
   /home/hendri/own_project/apps/zotero/zotero-github-plugin
   ```

4. In the profile's `prefs.js`, set these two to empty strings so Zotero re-reads the
   extensions directory on the next launch:

   ```js
   user_pref("extensions.lastAppBuildId", "");
   user_pref("extensions.lastAppVersion", "");
   ```

5. Start Zotero with a console attached:

   ```bash
   /path/to/zotero -ZoteroDebugText -jsconsole
   ```

If you already installed the XPI, remove it first — two copies of the same plugin ID
conflict.

Zotero does not hot-reload plugin code. After editing `src/`, restart Zotero, or disable
and re-enable the plugin in **Tools → Add-ons** (which runs `shutdown()` then `startup()`
and reloads every file in `src/`).

## Debugging

- **Log output** — every plugin line is prefixed `[GitHub Sync]`. Read it in
  **Help → Debug Output Logging → View Output**, or on the terminal with
  `-ZoteroDebugText`.
- **Errors** — `ZoteroGitHubSync.logError()` routes to Zotero's error console
  (**Help → Debug Output Logging**), and the most recent sync failure is also shown in
  the settings pane.
- **Poking at the plugin live** — **Tools → Developer → Run JavaScript**, where the
  namespace is reachable as `Zotero.GitHubSync`:

  ```js
  Zotero.GitHubSync.Prefs.getConfig()
  await Zotero.GitHubSync.Prefs.getToken()
  await Zotero.GitHubSync.Sync.syncNow({ trigger: 'manual' })
  Zotero.GitHubSync.Sync.lastResult
  ```

- **Seeing the export without pushing anything** — build the file map and inspect it. This
  touches no network:

  ```js
  let config = Zotero.GitHubSync.Prefs.getConfig();
  let files = await Zotero.GitHubSync.Exporter.build({ config });
  [...files.keys()].slice(0, 20)
  new TextDecoder().decode(files.get('my-library/collections.json').bytes)
  ```

- **HTTP traffic** — `Zotero.HTTP.request()` logs request lines at debug level 5. Blob
  bodies are suppressed on purpose (`logBodyLength: 0`), so base64 payloads and anything
  resembling a token stay out of the log.

## Testing the pure logic outside Zotero

```bash
npm test
```

`test/pure.test.mjs` loads `src/utils.js`, `src/exporter.js` and `src/importer.js` into
Node with a stub namespace and checks what doesn't need Zotero: chunked base64 against
Node's encoder, the Git blob hash, LFS pointers, sharding, JSON key sorting for objects from
another realm, repository-tree grouping, and the parent-before-child import order. No
dependencies.

`htmlToMarkdown()` needs a `DOMParser`, which Node does not have; `linkedom` is a drop-in
if you want to test it:

```bash
mkdir -p /tmp/zgs-test && cd /tmp/zgs-test && npm install linkedom
```

The blob hash is worth checking against Git itself, since the whole change-detection
scheme rests on it:

```bash
printf 'hello zotero\n' | git hash-object --stdin
```

Anything that touches `Zotero.Items`, `IOUtils`, `nsICryptoHash`, `fetch` or the DOM has to
be exercised in the application.

## Testing against GitHub

Use a throwaway private repository and a fine-grained token scoped to it alone. Worth
walking through at least once:

- First sync into an **empty** repository (no commits) — exercises the no-parent commit
  path.
- First sync into a repository that already has files — should add, never delete, because
  there is no `files.json` yet.
- Second sync with nothing changed — must report *Already up to date*, create no commit,
  and not re-read attachment files (the debug log shows no hashing). If it commits,
  something in the export is non-deterministic.
- A file over the LFS threshold — the tree gets a pointer under `attachments-lfs/`, and
  `git lfs pull` in a clone fetches a file whose `sha256sum` matches the original.
- A PDF with highlights, then *Import from GitHub* into a fresh profile — the highlights
  appear on the restored PDF.
- Delete an item, sync — its files should disappear from the repository.
- Set "download files as needed" on a second computer where a file isn't downloaded, sync —
  the file must stay in the repository.
- Set the base path to empty (repository root) with an unrelated file present, delete an
  item, sync — the unrelated file must survive.
- A branch that does not exist yet — should be created from the default branch.

To test import without touching your real library, start Zotero with a separate profile
and data directory (`zotero -P` to create one, then set its data directory under
**Settings → Advanced → Files and Folders**).

The attachment hash cache is `<profile>/zotero-github-sync/hash-cache.json`. Delete it to
force every file to be rehashed.

## Adding things

**A preference.** Declare the default in `prefs.js` at the repository root, read it in
`Prefs.getConfig()` (normalize and clamp there, not at the call site), and add a control
to `content/preferences.xhtml` with
`preference="extensions.zotero-github-sync.<name>"`. Zotero binds it automatically —
`content/preferences.js` only handles what the binding cannot, which is the token and the
buttons.

**A language.** Add one key to `_strings` in `src/core.js`, matching the shape of
`en-US`. `getString()` falls back per key, so a partial translation is fine. The pane and
the README stay English.

**An exported file.** Put an entry into the `files` map in `exporter.js`. Diffing,
uploading, committing and pruning pick it up with no further work — but keep the content
deterministic, or every sync will commit. See
[ARCHITECTURE.md](ARCHITECTURE.md#determinism-is-a-correctness-requirement).

## Code style

Follows the Zotero codebase: tabs, `let` over `const` except for true constants, opening
brace on the same line with `else`/`catch` on their own, and two hyphens rather than an em
dash in comments. Comments explain why, not what.

## Testing Import from GitHub end to end

`scripts/import-test/` restores a real repository into an empty, headless profile and
reports what arrived. The addon reads the token from a file, so it never appears in a
command line or log:

```bash
ssh host 'umask 077; mkdir -p ~/.config/zotero-github-sync; cat > ~/.config/zotero-github-sync/token' < token.txt
scp build/zotero-github-sync-<version>.xpi host:zgs-import-test/zotero-github-sync.xpi
scp zgs-import-test.xpi host:zgs-import-test/zgs-import-test.xpi   # zip of scripts/import-test/addon
(echo 'export ZGS_OWNER=me ZGS_REPO=my-library ZGS_BASE_PATH=zotero'; cat scripts/import-test/run-remote.sh) | ssh host 'bash -s'
```

It returns once Zotero is running; `~/zgs-import-test/out/DONE` appears when the import
ends, next to `report.json` (items by type, attachments with and without files,
collections, searches, tag colors, warnings). To check the files themselves, compare
`sha256sum` of every file under `storage/` in the source data directory and in
`~/zgs-import-test/data`.

## Testing two computers

`scripts/conflict-test/` has two throwaway profiles, A and B, take turns against one
throwaway repository, one headless Zotero launch per step: A creates a library and syncs; B
starts empty and imports it; A edits, deletes and adds; B, still behind, edits the same item
and adds a note in a background sync; B reviews (taking GitHub's version of the conflict,
importing the addition, declining to restore the deletion); A accepts B's note. The review
panel is replaced by a scripted chooser. Each step writes `out/<step>.json` with the sync
result, what the review offered, and the library and repository afterwards.

```bash
scp build/zotero-github-sync-<version>.xpi host:zgs-conflict/zotero-github-sync.xpi
scp zgs-conflict-test.xpi host:zgs-conflict/zgs-conflict-test.xpi   # zip of scripts/conflict-test/addon
(echo 'export ZGS_OWNER=me ZGS_REPO=sync-test ZGS_BASE_PATH=run-1'; cat scripts/conflict-test/run-remote.sh) | ssh host 'bash -s'
```

Use a new `ZGS_BASE_PATH` for each run so the repository never has to be emptied.

## Tutorial screenshots

The images in `docs/images/` come from a real Zotero, not mockups, in a throwaway profile
filled with sample papers. `scripts/screenshots/addon/` is a development-only plugin that,
when `ZGS_SHOTS_DIR` is set, creates the sample library, puts the GitHub Sync UI into each
state (idle, syncing, failed, settings, plugin manager), draws each window to a PNG and quits.
It opens no ports.

```bash
# build both XPIs, copy them to the Zotero machine, then:
scp build/zotero-github-sync-<version>.xpi host:zgs-demo/zotero-github-sync.xpi
scp zgs-screenshots.xpi host:zgs-demo/zgs-screenshots.xpi   # zip of scripts/screenshots/addon
ssh host 'bash -s' < scripts/screenshots/run-remote.sh
```

`run-remote.sh` creates `~/zgs-demo/{profile,data}`, runs Zotero headless twice (once to
register the add-ons, once to take the pictures) and leaves the PNGs in `~/zgs-demo/shots`.
The syncing screenshots show representative numbers; no sync runs. Crop them into
`docs/images/` with ImageMagick.

## Manifest requirements

Zotero 10 refuses a plugin whose `manifest.json` lacks any of
`applications.zotero.id`, `update_url` or `strict_max_version`, and shows only the generic
"could not be installed" alert. A sideloaded XPI that fails the check is silently deleted
from the profile's `extensions/` directory. Raise `strict_max_version` in `manifest.json`
and `update.json` together when a new Zotero major version ships.

## Releasing

1. Bump the version in **`manifest.json`**, `package.json` and `update.json` — all three.
   The CI job fails the build if the tag and `manifest.json` disagree.
2. Point `update_link` in `update.json` at the release asset for the new version.
3. Add a `CHANGELOG.md` entry.
4. Commit, then tag and push:

   ```bash
   git tag v0.2.0
   git push origin main --tags
   ```

`.github/workflows/release.yml` builds the XPI and attaches it, along with `update.json`,
to a GitHub release. Zotero's auto-update reads `update.json` from `main`, so users are
offered the new version once both are in place.
