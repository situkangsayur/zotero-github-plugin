# Repository data format

What the plugin writes, precisely enough to consume from another tool. Schema version
**1**, recorded in `.zotero-sync/manifest.json`.

The repository is a mirror of the library, not the source of truth. Editing files here does
not change Zotero unless you run *Import from GitHub*, and the next sync overwrites anything
the exporter also produces.

## What is included

| Data | Where |
| --- | --- |
| Regular items, standalone notes, standalone attachments | `items/<KE>/<KEY>.json` |
| Child notes, child attachments, PDF/EPUB/snapshot annotations, images embedded in notes | Inside the top-level item's JSON, under `children` |
| Attachment files: stored files, snapshots (every file in the snapshot directory), note images, linked files | `attachments/` or `attachments-lfs/` |
| Collections, with relations | `collections.json` |
| Saved searches | `searches.json` |
| Tag colors | `settings.json` |
| Human-readable copies | `notes/`, `index.md`, `README.md`, optional `library.bib` |

Not included: items in the trash, feeds, Zotero's full-text index (Zotero rebuilds it), the
rendered images of image/ink annotations (Zotero regenerates them from the annotation), and
per-file reader state such as the last page read.

## Directory layout

Everything sits under the configured base path (`zotero` by default; empty means the
repository root).

```
<base>/
├── README.md                              generated overview, if "Table of contents" is on
├── .zotero-sync/
│   ├── manifest.json                      schema and plugin version
│   └── files.json                         every path the plugin manages
├── my-library/                            the user library
│   ├── library.json
│   ├── collections.json
│   ├── searches.json
│   ├── settings.json
│   ├── index.md                           if "Table of contents" is on
│   ├── library.bib                        if "BibTeX export" is on
│   ├── items/
│   │   └── AB/ABCD1234.json               one per top-level item
│   ├── notes/
│   │   └── A/Attention Is All You Need (ABCD1234).md
│   ├── attachments/
│   │   └── WX/WXYZ5678/vaswani-2017.pdf   files up to the LFS threshold
│   └── attachments-lfs/
│       ├── .gitattributes                 marks everything here as LFS
│       └── BI/BIGF0001/handbook.pdf       Git LFS pointer; the file lives in LFS storage
└── group-42-Lab Shared/                   one per group library
    └── ... same structure
```

### Sharding

GitHub recommends no more than 3,000 entries in a directory, so nothing that grows with the
library sits flat:

- `items/`, `attachments/` and `attachments-lfs/` use the first two characters of the Zotero
  key. Keys draw on 32 characters, so each holds at most 1,024 subdirectories.
- `notes/` uses the first letter of the note's filename: `A`–`Z`, `0-9`, or `other` for
  everything else (including non-Latin titles). Accents are stripped for this purpose only,
  so `Élan` goes under `E`.

### Library directory names

| Library | Directory |
| --- | --- |
| User library | `my-library` |
| Group library | `group-<groupID>-<sanitized name, ≤40 chars>` |

The user library directory is fixed, so renaming your library does not move every file.
Group directories key on the numeric group ID first, so a group rename moves the directory
but importing still resolves it to the right local group.

## `items/<KE>/<KEY>.json`

`<KEY>` is the Zotero key of a top-level item: eight uppercase alphanumerics, stable for the
life of the item. `<KE>` is its first two characters.

Three top-level fields:

```json
{
  "children": [
    {
      "itemType": "annotation",
      "key": "ANNO0001",
      "parentItem": "WXYZ5678",
      "annotationType": "highlight",
      "annotationText": "Attention is all you need",
      "annotationComment": "the thesis",
      "annotationColor": "#ffd400",
      "annotationPageLabel": "1",
      "annotationSortIndex": "00000|000123|00456",
      "annotationPosition": "{\"pageIndex\":0,\"rects\":[[...]]}",
      "tags": [],
      "dateAdded": "2024-06-18 14:05:00",
      "dateModified": "2024-06-18 14:05:00"
    },
    {
      "itemType": "attachment",
      "key": "WXYZ5678",
      "parentItem": "ABCD1234",
      "linkMode": "imported_file",
      "contentType": "application/pdf",
      "filename": "vaswani-2017.pdf",
      "title": "Full Text PDF"
    }
  ],
  "meta": {
    "attachments": [
      {
        "annotationCount": 1,
        "contentType": "application/pdf",
        "files": [
          { "path": "attachments/WX/WXYZ5678/vaswani-2017.pdf", "size": 2215520, "storage": "git" }
        ],
        "filename": "vaswani-2017.pdf",
        "key": "WXYZ5678",
        "linkMode": "imported_file",
        "status": "ok",
        "title": "Full Text PDF",
        "url": null
      }
    ],
    "collections": ["Papers/NLP"],
    "creators": ["Vaswani, Ashish", "Shazeer, Noam"],
    "itemType": "conferencePaper",
    "libraryID": 1,
    "libraryName": "My Library",
    "notes": [{ "key": "NOTE0001", "title": "Reading notes" }],
    "title": "Attention Is All You Need",
    "year": "2017",
    "zoteroURI": "zotero://select/library/items/ABCD1234"
  },
  "zotero": {
    "itemType": "conferencePaper",
    "key": "ABCD1234",
    "title": "Attention Is All You Need",
    "creators": [{ "creatorType": "author", "firstName": "Ashish", "lastName": "Vaswani" }],
    "date": "2017",
    "tags": [{ "tag": "transformers" }],
    "collections": ["COLL0001"],
    "relations": {},
    "dateAdded": "2024-03-01 09:12:44",
    "dateModified": "2024-06-18 14:03:10"
  }
}
```

**`zotero`** is the item as [Zotero API JSON](https://www.zotero.org/support/dev/web_api/v3/basics),
exactly what `Zotero.Item.prototype.toJSON()` returns minus `version`. That number changes
every time Zotero's own sync touches an item, even when nothing about it changed, so keeping
it would add commits that record nothing. Its `collections` array holds collection *keys*.

Annotations never get a file of their own; they are only under their attachment.

**`children`** holds every descendant in the same format, sorted by key: child notes,
child attachments, the annotations on any attachment (including a standalone one), and the
images embedded in notes. Each child's `parentItem` names its direct parent, so an
annotation points at its attachment and a note image at its note. For a standalone
attachment, `zotero` is the attachment and `children` holds its annotations.

**`meta`** is derived, for humans and for tools that would rather not resolve keys. It is
never read back on import.

| Field | Notes |
| --- | --- |
| `collections` | Full paths (`"Papers/NLP"`), not keys; sorted |
| `creators` | `"Last, First"`, or just the name for single-field creators |
| `year` | First four-digit run in the date field; `""` if there isn't one |
| `notes` | Child notes, by key and title |
| `attachments[].files` | The repository files for that attachment, relative to the library directory. The primary file comes first. `storage` is `git` or `lfs` |
| `attachments[].status` | See below |
| `zoteroURI` | `zotero://select/library/items/<KEY>` or `.../groups/<groupID>/items/<KEY>` |

Attachment `status`:

| Status | Meaning |
| --- | --- |
| `ok` | Every file was synced |
| `partial` | Some files were skipped (over the size limit, or over 100 MB with LFS off); the sync reports each one |
| `missing` | Zotero knows the attachment but the file isn't on the computer that synced — typically "download files as needed". Files an earlier sync uploaded are left in place |
| `not-synced` | Attachment files, or linked files, are turned off in settings. Earlier uploads are left in place |
| `no-file` | A link to a URL; there is no file |

Object keys are sorted alphabetically at every level and the file is tab-indented. That is
what keeps an unchanged item from producing a diff — do not reformat these files in place
if you also sync, or every sync will fight your formatter.

## Attachment files

`attachments/<KE>/<KEY>/` (or `attachments-lfs/...`) mirrors Zotero's
`storage/<KEY>/` directory:

- **Stored files and snapshots** — every regular file in the storage directory, with
  subdirectories preserved. Zotero's own `.zotero-*` cache files are skipped.
- **Embedded note images** — the image file, under the image attachment's key.
- **Linked files** — the single file, under its original filename. Turn off *Include linked
  files* to skip them.

Filenames are kept exactly as they are on disk, so a restored snapshot's internal links
still work.

### Git or Git LFS

A file goes to **Git LFS** when LFS is on and the file is larger than the threshold (50 MB
by default, at most 95 MB). Everything else is an ordinary Git blob.

In `attachments-lfs/` the tree holds a standard
[Git LFS pointer](https://github.com/git-lfs/git-lfs/blob/main/docs/spec.md):

```
version https://git-lfs.github.com/spec/v1
oid sha256:4d7a214614ab2935c943f9e0ff69d22eadbb8f32b1258daaa5e2ca24d17e2393
size 131072000
```

and `attachments-lfs/.gitattributes` marks the directory for LFS, so `git clone` with
git-lfs installed checks out the real files. Without git-lfs you get the pointers.

Changing the threshold moves files between the two directories on the next sync.

LFS objects count against the account's Git LFS quota — on GitHub Free, 10 GiB of storage
and 10 GiB of bandwidth a month. Once storage runs out without a payment method, pushes of
new LFS files are refused; the sync fails with a message saying so rather than committing
pointers to files that were never uploaded.

## `collections.json`

Every collection in the library, sorted by path:

```json
[
  { "key": "COLL0000", "name": "Papers", "parentKey": null, "path": "Papers", "relations": {} },
  { "key": "COLL0001", "name": "NLP", "parentKey": "COLL0000", "path": "Papers/NLP", "relations": {} }
]
```

`path` is the full ancestor chain joined with `/`. Cycles (which should not exist) fall
back to the bare name rather than recursing.

## `searches.json`

Saved searches as Zotero API JSON, minus `version`, sorted by key:

```json
[
  {
    "conditions": [{ "condition": "tag", "operator": "is", "value": "to-read" }],
    "key": "SRCH0001",
    "name": "To read"
  }
]
```

## `settings.json`

```json
{ "tagColors": [{ "color": "#FF6666", "name": "important" }] }
```

An empty object when the library has no tag colors.

## `library.json`

```json
{ "id": 1, "itemCount": 412, "name": "My Library", "type": "user" }
```

`itemCount` counts top-level items. Group libraries also carry `groupID`.

## `.zotero-sync/manifest.json`

```json
{
  "generator": "zotero-github-sync",
  "libraries": [
    {
      "collectionCount": 17,
      "directory": "my-library",
      "id": 1,
      "itemCount": 412,
      "name": "My Library",
      "type": "user"
    }
  ],
  "pluginVersion": "0.2.0",
  "schema": 1
}
```

No timestamp, on purpose — see [ARCHITECTURE.md](ARCHITECTURE.md#determinism-is-a-correctness-requirement).

## `.zotero-sync/files.json`

A sorted JSON array of every repository-relative path the plugin manages, excluding
itself:

```json
[
  ".zotero-sync/manifest.json",
  "README.md",
  "my-library/collections.json",
  "my-library/items/AB/ABCD1234.json"
]
```

This is the plugin's delete list. Paths absent from it are never removed, which is what
makes it safe to sync into a repository root alongside other content. Files kept for
attachments whose file isn't on the syncing computer stay on the list. Deleting this file
does not break anything; it just disables pruning until the next full sync rewrites it.

## Markdown notes

One file per top-level item, written only when *Markdown notes* is on. Filename:
`<sanitized title, ≤80 chars> (<KEY>).md`, under the letter directory described above.

```markdown
---
title: "Attention Is All You Need"
item-type: "conferencePaper"
authors:
  - "Vaswani, Ashish"
date: "2017"
year: "2017"
publication: "NeurIPS"
doi: "10.48550/arXiv.1706.03762"
url: "https://arxiv.org/abs/1706.03762"
tags:
  - "transformers"
collections:
  - "Papers/NLP"
zotero-key: "ABCD1234"
zotero-library: 1
zotero-uri: "zotero://select/library/items/ABCD1234"
date-added: "2024-03-01 09:12:44"
date-modified: "2024-06-18 14:03:10"
---

# Attention Is All You Need

**Vaswani, Ashish; Shazeer, Noam**

## Abstract

...

## Notes

### Reading notes

...

## Attachments

- [vaswani-2017.pdf](../../attachments/WX/WXYZ5678/vaswani-2017.pdf)

## Annotations

- **p. 1, highlight** “Attention is all you need”
  the thesis

---

[Open in Zotero](zotero://select/library/items/ABCD1234)
```

Front-matter keys, in order: `title`, `item-type`, `authors`, `date`, `year`,
`publication`, `publisher`, `volume`, `issue`, `pages`, `doi`, `isbn`, `issn`, `url`,
`language`, `tags`, `collections`, `zotero-key`, `zotero-library`, `zotero-uri`,
`date-added`, `date-modified`. **Empty values are omitted entirely**, so a book has no
`publication` key at all rather than an empty one. Every string is double-quoted and
escaped; `zotero-library` is a bare number.

`publication` takes the first of `publicationTitle`, `bookTitle`, `proceedingsTitle`.

A standalone note renders its own body in place of an abstract. Child notes appear under
`## Notes`, converted from Zotero's HTML to Markdown: headings, bold, italic, strike,
inline code, code blocks, links, blockquotes, ordered and nested unordered lists, and
simple tables. Images embedded in a note link to their file in `attachments/`; an image
with no synced file becomes the marker `` `[embedded image]` ``.

Annotations are listed per attachment in reading order, with page label, type,
highlighted text and comment.

The Markdown is generated output. Editing it is fine for reading, but the next sync
overwrites it, and *Import from GitHub* reads `items/**/*.json` — never the Markdown.

## Path sanitization

Segments derived from metadata — note titles and group names — go through the same filter:
control characters removed; `/ \ : * ? " < > |` replaced with `-`; runs of whitespace
collapsed; leading and trailing dots and spaces trimmed; truncated (80 characters for note
titles, 40 for group names); and `untitled` substituted if nothing survives.

Attachment filenames are not rewritten, because a restore has to put back the exact name
Zotero expects. Zotero already restricts stored filenames to names valid on every platform;
linked files keep whatever name they have.

## Stability: what causes a rename

| Change | Effect |
| --- | --- |
| Item edited, note or annotation added | `items/<KE>/<KEY>.json` changes in place |
| Item title changed | The Markdown note is **renamed** — old path deleted, new one added |
| Item deleted | Its files are deleted, if pruning is on |
| Attachment file replaced | The file changes in place |
| Attachment crosses the LFS threshold | The file moves between `attachments/` and `attachments-lfs/` |
| Collection renamed | `collections.json` and affected `meta.collections` change; no file moves |
| Group renamed | The whole group directory moves |
| Plugin upgraded | `manifest.json` changes once |

Content that already exists in the repository under another path is not uploaded again, so
a rename costs a tree update, not a re-upload.

## Consuming this from another tool

- Read `.zotero-sync/manifest.json` first and check `schema`. This document describes
  schema 1; a higher number means fields may have been added.
- Iterate `<library>/items/*/*.json` and use `zotero` plus `children`. They are standard
  Zotero API JSON, so existing tooling applies.
- Join items to collections through `zotero.collections` (keys) and `collections.json`.
- Find an attachment's files through `meta.attachments[].files`, or by listing
  `attachments/<KE>/<KEY>/` and `attachments-lfs/<KE>/<KEY>/`.
- Treat `meta`, `index.md`, `README.md` and the Markdown notes as presentation. They are
  regenerated wholesale and are not a stable API.
