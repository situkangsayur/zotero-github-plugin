# Zotero GitHub Sync

Sync a Zotero library to a GitHub repository — public or private — the way Obsidian Git
backs up a vault. Every item becomes a JSON file and a Markdown note, changes land as
ordinary Git commits, and you can push manually, from a toolbar button, on a timer, or
whenever the library changes.

Works with Zotero 7 and later.

---

## What it does

- **Pushes your library to Git.** Metadata, notes, tags, collections, and (optionally)
  attachment files.
- **Commits only what changed.** File contents are hashed locally with Git's own blob
  hash, so an unchanged library produces no commit at all — a 5-minute interval doesn't
  mean 288 empty commits a day.
- **One commit per sync.** It uses the Git Data API (blobs → tree → commit → ref), not
  one API call per file, so a hundred changed items is still a single commit.
- **Readable output.** Markdown notes carry YAML front matter, so the repository doubles
  as an Obsidian vault.
- **Imports back.** *Import from GitHub* rebuilds items and collections on a new machine.

## What it is not

It is not a replacement for Zotero's own sync, and not a two-way sync engine. The
authoritative copy lives in Zotero; the repository is a versioned, readable mirror.
Import only ever adds or refreshes items — it never deletes anything locally.

---

## Install

1. Download `zotero-github-sync-<version>.xpi` from the
   [Releases](https://github.com/situkangsayur/zotero-github-plugin/releases) page.
   (In Firefox, right-click the link and choose *Save Link As…* so the browser doesn't
   try to install it itself.)
2. In Zotero: **Tools → Add-ons → gear icon → Install Add-on From File…**
3. Pick the `.xpi` and restart Zotero if prompted.

Or build it yourself — see [Development](#development).

## Set up

### 1. Create a GitHub token

**Fine-grained token** (recommended) — <https://github.com/settings/tokens?type=beta>

- *Repository access*: only the repository you'll sync to (or "All repositories" if you
  want the plugin to create it for you).
- *Permissions → Repository permissions → Contents*: **Read and write**.
- *Administration*: **Read and write** — only if you want the plugin to create the
  repository for you. Not needed if you create it yourself first.

**Classic token** — <https://github.com/settings/tokens>: tick the **repo** scope.

The token is stored in Zotero's password manager (the same place Zotero keeps its own
API key), not in the preferences file.

### 2. Configure the plugin

**Edit → Settings → GitHub Sync** (macOS: **Zotero → Settings**)

| Setting | What it does |
| --- | --- |
| Personal access token | Paste, then **Save token**, then **Test connection** |
| Owner | Your GitHub username or an organization |
| Repository | e.g. `my-zotero-library` |
| Branch | `main` by default; created from the default branch if missing |
| Folder inside the repository | e.g. `zotero`. Leave empty to use the repository root |
| Create the repository if it does not exist | Creates it on the first sync |
| Create it as a private repository | Applies only when the plugin creates it |

**Test connection** tells you who the token authenticates as, whether the repository
exists, and whether the token can actually write to it — check it before your first sync.

### 3. Choose when to sync

| Trigger | Where |
| --- | --- |
| Manual | Toolbar button, **Tools → GitHub Sync → Sync Library Now**, or **Sync now** in settings |
| Selected items | Right-click items → *Sync Selected Items to GitHub* |
| A collection | Right-click a collection → *Sync This Collection to GitHub* (includes subcollections) |
| Every N minutes | *Sync every … minutes* |
| After edits | *Sync after the library changes*, waiting N minutes for edits to settle |
| At startup | *Sync shortly after Zotero starts* (runs one minute after launch) |

Periodic and change-triggered syncs run quietly and only surface a notification when
something goes wrong.

---

## Repository layout

```
<base path>/
├── README.md                              overview, regenerated each sync
├── .zotero-sync/
│   ├── manifest.json                      schema and plugin version
│   └── files.json                         every path this plugin manages
└── my-library/
    ├── library.json                       library metadata
    ├── collections.json                   every collection with its full path
    ├── index.md                           table of contents by collection
    ├── library.bib                        optional BibTeX export
    ├── items/
    │   └── ABCD1234.json                  Zotero API JSON + derived metadata
    ├── notes/
    │   └── Attention Is All You Need (ABCD1234).md
    └── attachments/
        └── WXYZ5678/paper.pdf             optional
```

Group libraries land in `group-<groupID>-<name>/` with the same structure.

Each `items/<KEY>.json` holds two objects: `zotero` (the untouched Zotero API JSON, which
is what *Import from GitHub* reads back) and `meta` (derived fields — resolved collection
paths, author strings, attachment list, `zotero://` link).

Markdown notes look like this:

```markdown
---
title: "Attention Is All You Need"
item-type: "conferencePaper"
authors:
  - "Vaswani, Ashish"
date: "2017"
doi: "10.48550/arXiv.1706.03762"
tags:
  - "transformers"
collections:
  - "Papers/NLP"
zotero-key: "ABCD1234"
zotero-uri: "zotero://select/library/items/ABCD1234"
---

# Attention Is All You Need
...
```

### Deleting files

When *Remove files from the repository when their items are deleted* is on, the plugin
compares the current export against `.zotero-sync/files.json` — the list of paths it wrote
last time — and deletes only paths on that list. Files it has never written are never
touched, so pointing the plugin at a repository root is safe.

---

## Attachments

Off by default. GitHub rejects files over 100 MB, warns above 50 MB, and a repository full
of PDFs grows fast. With attachments off you still get every item, note, tag and
collection — just not the files.

When on, the plugin uploads stored files under the size limit you set (25 MB by default).
Linked files are never uploaded, since they live outside the Zotero data directory.

For large PDF collections, use [Git LFS](https://git-lfs.com) on the repository or keep
attachments in Zotero's own file sync.

## Import from GitHub

**Tools → GitHub Sync → Import from GitHub…**

- Adds items your library doesn't have (matched by Zotero key).
- Updates items whose repository copy has a newer `dateModified`.
- Recreates missing collections first, so items land in the right place.
- Never deletes anything locally.
- Skips attachment *items*; with attachments enabled it re-imports the attachment
  *files* under their parent item.

It downloads one blob per item, so importing a large library takes a while and uses a
chunk of your hourly API quota.

---

## Development

```bash
git clone git@github.com:situkangsayur/zotero-github-plugin.git
cd zotero-github-plugin
npm run build          # writes build/zotero-github-sync-<version>.xpi
```

The build script has no dependencies — it writes the XPI directly with Node's standard
library.

### Running from source

Zotero can load a plugin from a directory, which avoids rebuilding on every change:

1. Find your [Zotero profile directory](https://www.zotero.org/support/kb/profile_directory).
2. Create `extensions/zotero-github-sync@situkangsayur.github.io` (a *file*, not a folder)
   containing the absolute path to your clone.
3. In `prefs.js`, set `extensions.lastAppBuildId` and `extensions.lastAppVersion` to
   empty strings so Zotero re-reads the extensions directory.
4. Start Zotero with `-ZoteroDebugText -jsconsole` to see plugin logs.

Plugin log lines are prefixed with `[GitHub Sync]` in **Help → Debug Output Logging**.

### Layout

| File | Responsibility |
| --- | --- |
| `bootstrap.js` | Zotero plugin hooks; loads `src/` into the plugin sandbox |
| `src/core.js` | Namespace, lifecycle, localized strings |
| `src/utils.js` | Git blob hashing, base64, YAML, HTML→Markdown, bounded concurrency |
| `src/prefs.js` | Preference access and token storage |
| `src/github.js` | GitHub REST client (repos + Git Data API) |
| `src/exporter.js` | Zotero library → repository files (deterministic) |
| `src/importer.js` | Repository files → Zotero library |
| `src/sync.js` | Diffing, committing, scheduling, triggers |
| `src/ui.js` | Toolbar button and menus |
| `content/` | Preference pane |

Adding a language means adding one key to `_strings` in `src/core.js`. English and
Indonesian ship today.

---

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| *GitHub rejected the token (401)* | Token expired, mistyped, or revoked |
| *GitHub denied the request (403)* | Token lacks **Contents: Read and write** on that repository |
| *Not found (404)* | Wrong owner/repository, or a fine-grained token that wasn't granted access to it |
| Repository not created | *Administration: Read and write* is required to create repositories |
| Sync says "Already up to date" but you changed something | Only exported fields count; toggling a setting that isn't exported produces no diff |
| Rate limited | Authenticated requests are capped at 5,000/hour; a long interval and attachments off keep you well under it |

Errors are also written to **Help → Debug Output Logging**, and the last one is shown in
the settings pane.

---

## Ringkas (Bahasa Indonesia)

Plugin ini menyinkronkan pustaka Zotero ke repositori GitHub — publik maupun privat —
mirip Obsidian Git.

1. Buat *personal access token* di GitHub dengan izin **Contents: Read and write**
   (tambahkan **Administration** bila ingin plugin membuat repositori sendiri).
2. Buka **Edit → Settings → GitHub Sync**, tempel token, klik **Save token**, lalu
   **Test connection**.
3. Isi *Owner* dan *Repository*, misalnya `situkangsayur` dan `my-zotero-library`.
4. Sinkronkan lewat tombol di toolbar, menu **Tools → GitHub Sync**, klik kanan pada item
   atau koleksi, atau nyalakan sinkronisasi berkala / otomatis saat pustaka berubah.

Setiap item disimpan sebagai JSON (bisa diimpor kembali) dan catatan Markdown dengan YAML
front matter sehingga repositori bisa langsung dibuka di Obsidian. Sinkronisasi yang tidak
menemukan perubahan tidak membuat commit. Lampiran (PDF) mati secara bawaan karena ukuran
repositori cepat membengkak — nyalakan di pengaturan bila diperlukan.

---

## License

MIT — see [LICENSE](LICENSE).
