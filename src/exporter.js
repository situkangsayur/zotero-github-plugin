/* Zotero GitHub Sync -- turns a Zotero library into a set of repository files
 *
 * The output is deliberately deterministic: exporting an unchanged library twice
 * must produce byte-identical files, otherwise every sync would create a commit.
 * That is why nothing here embeds a timestamp and why arrays are sorted.
 *
 * Layout, relative to the configured base path:
 *
 *   <library>/library.json          library metadata
 *   <library>/collections.json      every collection, with its full path
 *   <library>/index.md              human-readable table of contents
 *   <library>/library.bib           optional BibTeX of the whole library
 *   <library>/items/<KEY>.json      one file per item, Zotero API JSON + extras
 *   <library>/notes/<Title> (<KEY>).md   Obsidian-style note per top-level item
 *   <library>/attachments/<KEY>/<file>   optional attachment files
 *   .zotero-sync/manifest.json      what produced this tree
 */

ZoteroGitHubSync.Exporter = {
	SCHEMA_VERSION: 1,
	BIBTEX_TRANSLATOR_ID: '9cb70025-a888-4a29-a210-93ec52da40d4',


	/**
	 * @param {Object} options
	 * @param {Object} options.config - From Prefs.getConfig()
	 * @param {Zotero.Item[]} [options.items] - Export only these items (and their
	 * 		children) instead of whole libraries
	 * @param {Function} [options.onProgress] - Called with a status string
	 * @return {Promise<Map<String, Object>>} Repository-relative path ->
	 * 		{ bytes: Uint8Array }
	 */
	async build({ config, items = null, onProgress = () => {} }) {
		let files = new Map();
		let libraries = await this._resolveLibraries(config, items);
		let stats = [];

		for (let library of libraries) {
			onProgress(`Reading ${library.name}…`);
			let stat = await this._buildLibrary({ library, config, items, files });
			stats.push(stat);
		}

		if (!items) {
			files.set('.zotero-sync/manifest.json', this._jsonFile({
				schema: this.SCHEMA_VERSION,
				generator: 'zotero-github-sync',
				pluginVersion: ZoteroGitHubSync.version,
				libraries: stats,
			}));
			if (config.exportIndex) {
				files.set('README.md', this._textFile(this._buildRootReadme(stats, config)));
			}
		}

		return files;
	},


	/**
	 * @return {Promise<Zotero.Library[]>}
	 */
	async _resolveLibraries(config, items) {
		if (items?.length) {
			let ids = [...new Set(items.map(item => item.libraryID))];
			return ids.map(id => Zotero.Libraries.get(id)).filter(Boolean);
		}
		let libraries = [Zotero.Libraries.userLibrary];
		if (config.includeGroupLibraries) {
			for (let library of Zotero.Libraries.getAll()) {
				if (library.libraryType === 'group') {
					libraries.push(library);
				}
			}
		}
		return libraries.filter(Boolean);
	},


	async _buildLibrary({ library, config, items, files }) {
		let dir = this.librarySlug(library);
		await Zotero.Items.loadAll(library.libraryID);

		let collections = this._buildCollectionIndex(library.libraryID);
		let topLevelItems = items
			? items.filter(item => item.libraryID === library.libraryID && !item.deleted)
			: (await Zotero.Items.getAll(library.libraryID, true, false))
				.filter(item => !item.deleted);

		// Sorting keeps index.md and the BibTeX file stable across syncs
		topLevelItems.sort((a, b) => a.key.localeCompare(b.key));

		let exported = [];
		for (let item of topLevelItems) {
			if (item.isAttachment() && !item.isTopLevelItem()) {
				continue;
			}
			let record = await this._buildItemRecord({ item, library, collections, config });
			exported.push(record);

			if (config.exportJSON) {
				files.set(`${dir}/items/${item.key}.json`, this._jsonFile(record.json));
				for (let child of record.childRecords) {
					files.set(`${dir}/items/${child.key}.json`, this._jsonFile(child.json));
				}
			}
			if (config.exportMarkdown && !item.isAttachment()) {
				files.set(`${dir}/notes/${record.markdownFilename}`, this._textFile(record.markdown));
			}
			for (let attachment of record.attachmentFiles) {
				files.set(`${dir}/attachments/${attachment.path}`, { bytes: attachment.bytes });
			}
		}

		// Whole-library files only make sense on a full sync
		if (!items) {
			files.set(`${dir}/library.json`, this._jsonFile({
				id: library.libraryID,
				type: library.libraryType,
				name: library.name,
				groupID: library.libraryType === 'group' ? library.groupID : undefined,
				itemCount: exported.length,
			}));
			files.set(`${dir}/collections.json`, this._jsonFile(
				[...collections.values()]
					.map(c => ({ key: c.key, name: c.name, parentKey: c.parentKey || null, path: c.path }))
					.sort((a, b) => a.path.localeCompare(b.path))
			));
			if (config.exportIndex) {
				files.set(`${dir}/index.md`, this._textFile(
					this._buildLibraryIndex({ library, exported })
				));
			}
			if (config.exportBibTeX) {
				let bibtex = await this._exportBibTeX(topLevelItems.filter(i => i.isRegularItem()));
				if (bibtex) {
					files.set(`${dir}/library.bib`, this._textFile(bibtex));
				}
			}
		}

		return {
			id: library.libraryID,
			type: library.libraryType,
			name: library.name,
			directory: dir,
			itemCount: exported.length,
			collectionCount: collections.size,
		};
	},


	/**
	 * @return {String} Directory name for a library, stable across renames for
	 * 		the user library and keyed by group ID for groups
	 */
	librarySlug(library) {
		if (library.libraryType === 'user') {
			return 'my-library';
		}
		return `group-${library.groupID}-${ZoteroGitHubSync.Utils.sanitizeSegment(library.name, 40)}`;
	},


	/**
	 * @return {Map<String, Object>} collection key -> { key, name, parentKey, path }
	 */
	_buildCollectionIndex(libraryID) {
		let collections = Zotero.Collections.getByLibrary(libraryID, true) || [];
		let byKey = new Map();
		for (let collection of collections) {
			byKey.set(collection.key, {
				key: collection.key,
				name: collection.name,
				parentKey: collection.parentKey || null,
				path: null,
			});
		}
		// Resolve full paths ("Papers/Machine Learning") now that every parent is known
		let resolvePath = (key, seen = new Set()) => {
			let entry = byKey.get(key);
			if (!entry) {
				return '';
			}
			if (entry.path !== null) {
				return entry.path;
			}
			// Guard against a cycle rather than recursing forever
			if (seen.has(key)) {
				return entry.name;
			}
			seen.add(key);
			entry.path = entry.parentKey
				? `${resolvePath(entry.parentKey, seen)}/${entry.name}`
				: entry.name;
			return entry.path;
		};
		for (let key of byKey.keys()) {
			resolvePath(key);
		}
		return byKey;
	},


	/**
	 * Build everything we know about one top-level item and its children.
	 */
	async _buildItemRecord({ item, library, collections, config }) {
		let json = item.toJSON();
		json.key = item.key;

		let collectionPaths = (item.getCollections() || [])
			.map(id => Zotero.Collections.get(id))
			.filter(Boolean)
			.map(c => collections.get(c.key)?.path || c.name)
			.sort();
		if (Array.isArray(json.collections)) {
			json.collections.sort();
		}
		if (Array.isArray(json.tags)) {
			json.tags.sort((a, b) => String(a.tag).localeCompare(String(b.tag)));
		}

		let childRecords = [];
		let notes = [];
		let attachments = [];
		let attachmentFiles = [];

		if (item.isRegularItem()) {
			if (config.includeNotes) {
				for (let noteID of item.getNotes(false)) {
					let note = await Zotero.Items.getAsync(noteID);
					if (!note || note.deleted) {
						continue;
					}
					let noteJSON = note.toJSON();
					noteJSON.key = note.key;
					childRecords.push({ key: note.key, json: noteJSON });
					notes.push({
						key: note.key,
						title: note.getNoteTitle() || 'Note',
						markdown: ZoteroGitHubSync.Utils.htmlToMarkdown(note.getNote()),
					});
				}
			}

			for (let attachmentID of item.getAttachments(false)) {
				let attachment = await Zotero.Items.getAsync(attachmentID);
				if (!attachment || attachment.deleted) {
					continue;
				}
				let attachmentJSON = attachment.toJSON();
				attachmentJSON.key = attachment.key;
				childRecords.push({ key: attachment.key, json: attachmentJSON });

				let entry = {
					key: attachment.key,
					title: attachment.getField('title') || attachment.attachmentFilename || 'Attachment',
					filename: attachment.attachmentFilename || null,
					contentType: attachment.attachmentContentType || null,
					linkMode: Zotero.Attachments.linkModeToName(attachment.attachmentLinkMode),
					url: attachment.getField('url') || null,
					path: null,
				};

				if (config.includeAttachments) {
					let file = await this._readAttachment(attachment, config);
					if (file) {
						entry.path = `${attachment.key}/${file.filename}`;
						attachmentFiles.push({ path: entry.path, bytes: file.bytes });
					}
				}
				attachments.push(entry);
			}
		}

		let record = {
			key: item.key,
			item,
			json: {
				zotero: json,
				meta: {
					libraryID: library.libraryID,
					libraryName: library.name,
					itemType: item.itemType,
					title: item.getDisplayTitle(),
					creators: this._creatorStrings(item),
					year: this._year(item),
					collections: collectionPaths,
					zoteroURI: this.itemURI(item, library),
					notes: notes.map(n => ({ key: n.key, title: n.title })),
					attachments,
				},
			},
			childRecords,
			attachmentFiles,
			notes,
			attachments,
			collectionPaths,
		};

		record.markdown = this._buildItemMarkdown({ record, library });
		record.markdownFilename = this._markdownFilename(item);
		return record;
	},


	/**
	 * @return {Promise<{filename: String, bytes: Uint8Array}|null>}
	 */
	async _readAttachment(attachment, config) {
		try {
			if (!attachment.isFileAttachment() || attachment.isLinkedFileAttachment()) {
				// Linked files live outside the Zotero data directory; pushing
				// them would copy files the user never put in their library
				return null;
			}
			let path = await attachment.getFilePathAsync();
			if (!path) {
				return null;
			}
			let stat = await IOUtils.stat(path);
			if (config.maxAttachmentBytes && stat.size > config.maxAttachmentBytes) {
				ZoteroGitHubSync.log(
					`Skipping ${attachment.key} (${ZoteroGitHubSync.Utils.formatSize(stat.size)} `
					+ `exceeds the ${ZoteroGitHubSync.Utils.formatSize(config.maxAttachmentBytes)} limit)`
				);
				return null;
			}
			let bytes = await IOUtils.read(path);
			return {
				filename: ZoteroGitHubSync.Utils.sanitizeSegment(
					attachment.attachmentFilename || PathUtils.filename(path),
					120
				),
				bytes,
			};
		}
		catch (e) {
			ZoteroGitHubSync.logError(e);
			return null;
		}
	},


	_creatorStrings(item) {
		if (!item.getCreators) {
			return [];
		}
		return item.getCreators().map((creator) => {
			if (creator.fieldMode === 1 || !creator.firstName) {
				return creator.lastName;
			}
			return `${creator.lastName}, ${creator.firstName}`;
		});
	},


	_year(item) {
		let date = item.getField ? item.getField('date', true, true) : '';
		let match = String(date || '').match(/\d{4}/);
		return match ? match[0] : '';
	},


	itemURI(item, library) {
		if (library.libraryType === 'group') {
			return `zotero://select/groups/${library.groupID}/items/${item.key}`;
		}
		return `zotero://select/library/items/${item.key}`;
	},


	_markdownFilename(item) {
		let title = ZoteroGitHubSync.Utils.sanitizeSegment(item.getDisplayTitle() || 'Untitled', 80);
		return `${title} (${item.key}).md`;
	},


	_buildItemMarkdown({ record, library }) {
		let { item } = record;
		let get = field => (item.getField ? item.getField(field) : '');

		let frontMatter = ZoteroGitHubSync.Utils.yamlFrontMatter({
			title: item.getDisplayTitle(),
			'item-type': item.itemType,
			authors: record.json.meta.creators,
			date: get('date'),
			year: record.json.meta.year,
			publication: get('publicationTitle') || get('bookTitle') || get('proceedingsTitle'),
			publisher: get('publisher'),
			volume: get('volume'),
			issue: get('issue'),
			pages: get('pages'),
			doi: get('DOI'),
			isbn: get('ISBN'),
			issn: get('ISSN'),
			url: get('url'),
			language: get('language'),
			tags: (item.getTags() || []).map(t => t.tag).sort(),
			collections: record.collectionPaths,
			'zotero-key': item.key,
			'zotero-library': library.libraryID,
			'zotero-uri': record.json.meta.zoteroURI,
			'date-added': get('dateAdded'),
			'date-modified': get('dateModified'),
		});

		let sections = [frontMatter, `# ${item.getDisplayTitle() || 'Untitled'}\n`];

		if (record.json.meta.creators.length) {
			sections.push(`**${record.json.meta.creators.join('; ')}**\n`);
		}

		let abstract = get('abstractNote');
		if (abstract) {
			sections.push(`## Abstract\n\n${abstract.trim()}\n`);
		}

		// A standalone note has no child notes -- its body is the item
		if (item.isNote && item.isNote()) {
			let body = ZoteroGitHubSync.Utils.htmlToMarkdown(item.getNote());
			if (body) {
				sections.push(`${body}\n`);
			}
		}

		let extra = get('extra');
		if (extra) {
			sections.push(`## Extra\n\n${extra.trim()}\n`);
		}

		if (record.notes.length) {
			let notes = record.notes.map(note => `### ${note.title}\n\n${note.markdown || '_(empty note)_'}\n`);
			sections.push(`## Notes\n\n${notes.join('\n')}`);
		}

		if (record.attachments.length) {
			let lines = record.attachments.map((attachment) => {
				let label = attachment.filename || attachment.title;
				if (attachment.path) {
					return `- [${label}](../attachments/${encodeURI(attachment.path)})`;
				}
				if (attachment.url) {
					return `- [${label}](${attachment.url})`;
				}
				return `- ${label} _(not uploaded)_`;
			});
			sections.push(`## Attachments\n\n${lines.join('\n')}\n`);
		}

		sections.push(`---\n\n[Open in Zotero](${record.json.meta.zoteroURI})\n`);
		return sections.join('\n');
	},


	_buildLibraryIndex({ library, exported }) {
		let byCollection = new Map();
		const UNFILED = '(No collection)';
		for (let record of exported) {
			let paths = record.collectionPaths.length ? record.collectionPaths : [UNFILED];
			for (let path of paths) {
				if (!byCollection.has(path)) {
					byCollection.set(path, []);
				}
				byCollection.get(path).push(record);
			}
		}

		let lines = [
			`# ${library.name}`,
			'',
			`${exported.length} item(s) in ${byCollection.size} collection(s).`,
			'',
		];
		for (let path of [...byCollection.keys()].sort()) {
			lines.push(`## ${path}`, '');
			let records = byCollection.get(path).slice().sort((a, b) => {
				return (a.json.meta.title || '').localeCompare(b.json.meta.title || '');
			});
			for (let record of records) {
				let authors = record.json.meta.creators.slice(0, 3).join('; ');
				let year = record.json.meta.year;
				let suffix = [authors, year].filter(Boolean).join(', ');
				let target = `notes/${encodeURI(record.markdownFilename)}`;
				lines.push(`- [${record.json.meta.title || 'Untitled'}](${target})${suffix ? ` — ${suffix}` : ''}`);
			}
			lines.push('');
		}
		return lines.join('\n');
	},


	_buildRootReadme(stats, config) {
		let lines = [
			'# Zotero Library',
			'',
			'This directory is written by the [Zotero GitHub Sync]'
			+ '(https://github.com/situkangsayur/zotero-github-plugin) plugin. '
			+ 'Edits made here are not read back into Zotero unless you run **Import from GitHub**.',
			'',
			'## Libraries',
			'',
		];
		for (let stat of stats) {
			lines.push(`- [${stat.name}](${encodeURI(stat.directory)}/index.md) — `
				+ `${stat.itemCount} item(s), ${stat.collectionCount} collection(s)`);
		}
		lines.push(
			'',
			'## Layout',
			'',
			'| Path | Contents |',
			'| --- | --- |',
			'| `<library>/items/<KEY>.json` | One file per item: Zotero API JSON plus derived metadata |',
			'| `<library>/notes/*.md` | Markdown with YAML front matter, readable in Obsidian |',
			'| `<library>/collections.json` | Every collection and its full path |',
			'| `<library>/index.md` | Table of contents grouped by collection |',
		);
		if (config.exportBibTeX) {
			lines.push('| `<library>/library.bib` | BibTeX export of the library |');
		}
		if (config.includeAttachments) {
			lines.push('| `<library>/attachments/<KEY>/` | Attachment files |');
		}
		lines.push('');
		return lines.join('\n');
	},


	/**
	 * @return {Promise<String>} BibTeX for the given items, or '' on failure
	 */
	async _exportBibTeX(items) {
		if (!items.length) {
			return '';
		}
		try {
			return await new Promise((resolve, reject) => {
				let translation = new Zotero.Translate.Export();
				translation.setItems(items.slice());
				translation.setTranslator(this.BIBTEX_TRANSLATOR_ID);
				translation.setHandler('done', (obj, worked) => {
					if (worked) {
						resolve(obj.string || '');
					}
					else {
						reject(new Error('BibTeX translation failed'));
					}
				});
				translation.translate();
			});
		}
		catch (e) {
			ZoteroGitHubSync.logError(e);
			return '';
		}
	},


	// -- File helpers ------------------------------------------------------

	_textFile(text) {
		let content = text.endsWith('\n') ? text : `${text}\n`;
		return { bytes: ZoteroGitHubSync.Utils.encode(content) };
	},


	_jsonFile(value) {
		return this._textFile(this.stableStringify(value));
	},


	/**
	 * JSON.stringify with object keys sorted, so the same library always
	 * serializes to the same bytes and unchanged items produce no diff.
	 *
	 * @param {*} value
	 * @return {String}
	 */
	stableStringify(value) {
		let sort = (input) => {
			if (Array.isArray(input)) {
				return input.map(sort);
			}
			if (input && typeof input === 'object' && input.constructor === Object) {
				let out = {};
				for (let key of Object.keys(input).sort()) {
					if (input[key] !== undefined) {
						out[key] = sort(input[key]);
					}
				}
				return out;
			}
			return input;
		};
		return JSON.stringify(sort(value), null, '\t');
	},
};
