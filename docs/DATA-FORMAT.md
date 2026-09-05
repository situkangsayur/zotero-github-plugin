# Repository data format

What the plugin writes, precisely enough to consume from another tool. Schema version
**1**, recorded in `.zotero-sync/manifest.json`.

The repository is a mirror, not the source of truth. Editing files here does not change
Zotero unless you run *Import from GitHub*, and the next sync overwrites anything the
exporter also produces.

## Directory layout

Everything sits under the configured base path (`zotero` by default; empty means the
repository root).

```
<base>/
├── README.md                       generated overview, if "Table of contents" is on
├── .zotero-sync/
│   ├── manifest.json               schema and plugin version
│   └── files.json                  every path the plugin manages
├── my-library/                     the user library
│   ├── library.json
│   ├── collections.json
│   ├── index.md                    if "Table of contents" is on
│   ├── library.bib                 if "BibTeX export" is on
│   ├── items/
│   │   └── ABCD1234.json           one per item, including child notes
│   ├── notes/
│   │   └── Attention Is All You Need (ABCD1234).md
│   └── attachments/
│       └── WXYZ5678/paper.pdf      if "Attachment files" is on
└── group-42-Lab Shared/            one per synced group library
    └── ... same structure
```

### Library directory names

| Library | Directory |
| --- | --- |
| User library | `my-library` |
| Group library | `group-<groupID>-<sanitized name, ≤40 chars>` |

The user library directory is fixed, so renaming your library does not move every file.
Group directories key on the numeric group ID first, so a group rename moves the directory
but importing still resolves it to the right local group.

## `items/<KEY>.json`

`<KEY>` is the Zotero item key: eight uppercase alphanumerics, stable for the life of the
item. One file per item, including child notes. Child attachments get a file too, but see
[Attachments](#attachments) for what that does and does not mean.

Two top-level objects:

```json
{
  "meta": {
    "attachments": [
      {
        "contentType": "application/pdf",
        "filename": "vaswani-2017.pdf",
        "key": "WXYZ5678",
        "linkMode": "imported_file",
        "path": "WXYZ5678/vaswani-2017.pdf",
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
    "dateAdded": "2024-03-01 09:12:44",
    "dateModified": "2024-06-18 14:03:10",
    "version": 0
  }
}
```

**`zotero`** is unmodified [Zotero API JSON](https://www.zotero.org/support/dev/web_api/v3/basics),
exactly what `Zotero.Item.prototype.toJSON()` returns. This is the half *Import from
GitHub* reads back, and the half to use if you want to POST items to the Zotero API. Its
`collections` array holds collection *keys*.

**`meta`** is derived, for humans and for tools that would rather not resolve keys. It is
never read back on import.

| Field | Notes |
| --- | --- |
| `collections` | Full paths (`"Papers/NLP"`), not keys; sorted |
| `creators` | `"Last, First"`, or just the name for single-field creators |
| `year` | First four-digit run in the date field; `""` if there isn't one |
| `notes` | Child notes; each has its own `items/<KEY>.json` |
| `attachments` | `path` is relative to the library's `attachments/` directory, or `null` when the file was not uploaded |
| `zoteroURI` | `zotero://select/library/items/<KEY>` or `.../groups/<groupID>/items/<KEY>` |

Object keys are sorted alphabetically at every level and the file is tab-indented. That is
what keeps an unchanged item from producing a diff — do not reformat these files in place
if you also sync, or every sync will fight your formatter.

## `collections.json`

Every collection in the library, sorted by path:

```json
[
  { "key": "COLL0001", "name": "NLP", "parentKey": "COLL0000", "path": "Papers/NLP" },
  { "key": "COLL0000", "name": "Papers", "parentKey": null, "path": "Papers" }
]
```

`path` is the full ancestor chain joined with `/`. Cycles (which should not exist) fall
back to the bare name rather than recursing.

## `library.json`

```json
{ "id": 1, "itemCount": 412, "name": "My Library", "type": "user" }
```

Group libraries also carry `groupID`.

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
  "pluginVersion": "0.1.0",
  "schema": 1
}
```

No timestamp, on purpose — see [ARCHITECTURE.md](ARCHITECTURE.md#determinism-is-a-correctness-requirement).

## `.zotero-sync/files.json`

A sorted JSON array of every repository-relative path the plugin manages, excluding
itself:

```json
[
  "README.md",
  ".zotero-sync/manifest.json",
  "my-library/collections.json",
  "my-library/items/ABCD1234.json"
]
```

This is the plugin's delete list. Paths absent from it are never removed, which is what
makes it safe to sync into a repository root alongside other content. Deleting this file
does not break anything; it just disables pruning until the next full sync rewrites it.

## Markdown notes

One file per top-level item (not per child note), written only when *Markdown notes* is
on. Filename: `<sanitized title, ≤80 chars> (<KEY>).md`.

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

- [vaswani-2017.pdf](../attachments/WXYZ5678/vaswani-2017.pdf)

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
simple tables. Embedded images (which Zotero stores as `data:` URIs) become the marker
`` `[embedded image]` `` rather than a screenful of base64.

The Markdown is generated output. Editing it is fine for reading, but the next sync
overwrites it, and *Import from GitHub* reads `items/*.json` — never the Markdown.

## Attachments

Off by default. When enabled, files land at
`<library>/attachments/<attachment KEY>/<filename>`.

What is uploaded: stored files (`imported_file`, `imported_url`) whose size is under the
configured limit, 25 MB by default. What is not: linked files, because they live outside
the Zotero data directory; anything over the limit, which is logged and skipped.

GitHub rejects blobs over 100 MB and warns above 50 MB. For a large PDF collection, use
[Git LFS](https://git-lfs.com) on the repository, or keep files in Zotero's own file sync
and let this plugin carry the metadata.

Round-tripping an attachment file through export and import gives it a **new key**, since
Zotero assigns one on import. Item and collection keys survive; attachment keys do not.

## Path sanitization

Every path segment derived from user data (titles, group names, filenames) is passed
through the same filter: control characters removed; `/ \ : * ? " < > |` replaced with
`-`; runs of whitespace collapsed; leading and trailing dots and spaces trimmed;
truncated (80 characters for note titles, 40 for group names, 120 for filenames); and
`untitled` substituted if nothing survives.

The rules are stricter than Git needs because they also have to hold on Windows
checkouts.

## Stability: what causes a rename

| Change | Effect |
| --- | --- |
| Item edited | `items/<KEY>.json` changes in place |
| Item title changed | The Markdown note is **renamed** — old path deleted, new one added |
| Item deleted | Its files are deleted, if pruning is on |
| Collection renamed | `collections.json` and affected `meta.collections` change; no file moves |
| Group renamed | The whole group directory moves |
| Plugin upgraded | `manifest.json` changes once |

Because titles are part of Markdown filenames, retitling an item shows up in Git history
as a delete plus an add. `items/<KEY>.json` is keyed only on the Zotero key and never
moves, which is why it is the format to build on.

## Consuming this from another tool

- Read `.zotero-sync/manifest.json` first and check `schema`. This document describes
  schema 1; a higher number means fields may have been added.
- Iterate `<library>/items/*.json` and use the `zotero` object. It is standard Zotero API
  JSON, so existing tooling applies.
- Join items to collections through `zotero.collections` (keys) and `collections.json`.
- Treat `meta`, `index.md`, `README.md` and the Markdown notes as presentation. They are
  regenerated wholesale and are not a stable API.
