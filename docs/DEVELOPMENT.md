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

Most of `utils.js`, plus the deterministic serializer, commit-message templating and the
importer's tree grouping, are free of Zotero APIs and can be exercised under plain Node.
`htmlToMarkdown()` needs a `DOMParser`, which Node does not have — `linkedom` is a
drop-in for that:

```bash
mkdir -p /tmp/zgs-test && cd /tmp/zgs-test && npm install linkedom
```

```js
// /tmp/zgs-test/t.mjs
import { readFileSync } from 'node:fs';
import { DOMParser } from 'linkedom';
globalThis.DOMParser = DOMParser;
globalThis.ZoteroGitHubSync = { log: () => {}, logError: console.error, version: '0.1.0' };

const SRC = '/path/to/zotero-github-plugin/src';
eval(readFileSync(`${SRC}/utils.js`, 'utf8'));
eval(readFileSync(`${SRC}/exporter.js`, 'utf8'));

const U = ZoteroGitHubSync.Utils;
console.log(await U.gitBlobSha(U.encode('hello zotero\n')));
console.log(U.htmlToMarkdown('<p>a <strong>b</strong></p>'));
```

The blob hash is worth checking against Git itself, since the whole change-detection
scheme rests on it:

```bash
printf 'hello zotero\n' | git hash-object --stdin
```

Anything that touches `Zotero.Items`, `Zotero.Collections` or the DOM has to be exercised
in the application.

## Testing against GitHub

Use a throwaway private repository and a fine-grained token scoped to it alone. Worth
walking through at least once:

- First sync into an **empty** repository (no commits) — exercises the no-parent commit
  path.
- First sync into a repository that already has files — should add, never delete, because
  there is no `files.json` yet.
- Second sync with nothing changed — must report *Already up to date* and create no
  commit. If it commits, something in the export is non-deterministic.
- Delete an item, sync — the files should disappear from the repository.
- Set the base path to empty (repository root) with an unrelated file present, delete an
  item, sync — the unrelated file must survive.
- A branch that does not exist yet — should be created from the default branch.

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
