/* Zotero GitHub Sync -- turns a Zotero library into a set of repository files
 *
 * The output is deliberately deterministic: exporting an unchanged library twice
 * must produce byte-identical files, otherwise every sync would create a commit.
 * That is why nothing here embeds a timestamp and why arrays are sorted.
 *
 * Layout, relative to the configured base path:
 *
 *   <library>/library.json                    library metadata
 *   <library>/collections.json                every collection, with its full path
 *   <library>/searches.json                   saved searches
 *   <library>/settings.json                   tag colors
 *   <library>/index.md                        human-readable table of contents
 *   <library>/library.bib                     optional BibTeX of the whole library
 *   <library>/items/<KE>/<KEY>.json           one file per top-level item, holding
 *                                             the item and every descendant: notes,
 *                                             attachments, annotations, note images
 *   <library>/notes/<A>/<Title> (<KEY>).md    Obsidian-style note per top-level item
 *   <library>/attachments/<KE>/<KEY>/...      attachment files, in Git
 *   <library>/attachments-lfs/<KE>/<KEY>/...  attachment files, as Git LFS pointers
 *   .zotero-sync/manifest.json                what produced this tree
 *
 * Attachment files are not read here. They are returned as `source` entries
 * (path, size, mtime) and hashed or read by Sync only when it needs them.
 */

ZoteroGitHubSync.Exporter = {
	SCHEMA_VERSION: 1,
	BIBTEX_TRANSLATOR_ID: '9cb70025-a888-4a29-a210-93ec52da40d4',

	// GitHub refuses Git objects over 100 MB outright
	GIT_HARD_LIMIT: 100 * 1024 * 1024,


	/**
	 * @param {Object} options
	 * @param {Object} options.config - From Prefs.getConfig()
	 * @param {Zotero.Item[]} [options.items] - Export only these items (and their
	 * 		children) instead of whole libraries
	 * @param {Function} [options.onProgress] - Called with a status string
	 * @return {Promise<Object>} {
	 * 		files: Map<relPath, {bytes: Uint8Array} | {source: Object, lfs: Boolean}>,
	 * 		keepPrefixes: String[] - repository paths to leave alone because the
	 * 			file exists in the library but is not on this computer,
	 * 		warnings: String[]
	 * 	}
	 */
	async build({ config, items = null, onProgress = () => {} }) {
		let out = { files: new Map(), keepPrefixes: [], warnings: [] };
		let libraries = await this._resolveLibraries(config, items);
		let stats = [];

		for (let library of libraries) {
			onProgress(`Reading ${library.name}…`);
			let stat = await this._buildLibrary({ library, config, items, out, onProgress });
			stats.push(stat);
		}

		if (!items) {
			out.files.set('.zotero-sync/manifest.json', this._jsonFile({
				schema: this.SCHEMA_VERSION,
				generator: 'zotero-github-sync',
				pluginVersion: ZoteroGitHubSync.version,
				libraries: stats,
			}));
			if (config.exportIndex) {
				out.files.set('README.md', this._textFile(this._buildRootReadme(stats, config)));
			}
		}

		return out;
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


	async _buildLibrary({ library, config, items, out, onProgress }) {
		let dir = this.librarySlug(library);
		// Not Zotero.Items.loadAll(): Zotero loads every library at startup, and a
		// second loadAll() throws "Items already loading". This waits for that
		// load, or starts one for a library that hasn't been loaded yet.
		await library.waitForDataLoad('item');

		let collections = this._buildCollectionIndex(library.libraryID);
		let topLevelItems;
		if (items) {
			// A selected child exports as part of its parent's record
			let tops = new Map();
			for (let item of items) {
				if (item.libraryID !== library.libraryID) {
					continue;
				}
				let top = item.topLevelItem || item;
				if (!top.deleted) {
					tops.set(top.id, top);
				}
			}
			topLevelItems = [...tops.values()];
		}
		else {
			topLevelItems = (await Zotero.Items.getAll(library.libraryID, true, false))
				.filter(item => !item.deleted);
		}

		// Sorting keeps index.md and the BibTeX file stable across syncs
		topLevelItems.sort((a, b) => this._compare(a.key, b.key));

		let exported = [];
		let ctx = { library, dir, collections, config, out };
		for (let item of topLevelItems) {
			let record = await this._buildItemRecord({ item, ctx });
			exported.push(record);

			if (config.exportJSON) {
				out.files.set(this.itemPath(dir, item.key), this._jsonFile(record.json));
			}
			if (config.exportMarkdown) {
				out.files.set(`${dir}/${record.markdownPath}`, this._textFile(record.markdown));
			}
			if (exported.length % 100 === 0) {
				onProgress(`Read ${exported.length}/${topLevelItems.length} items in ${library.name}…`);
			}
		}

		let lfsUsed = [...out.files.keys()].some(path => path.startsWith(`${dir}/attachments-lfs/`));
		if (lfsUsed) {
			// Scoped to the LFS directory, so it can't collide with a
			// .gitattributes the user keeps at the repository root
			out.files.set(`${dir}/attachments-lfs/.gitattributes`, this._textFile(
				'* filter=lfs diff=lfs merge=lfs -text\n'
				+ '.gitattributes !filter !diff !merge text\n'
			));
		}

		// Whole-library files only make sense on a full sync
		if (!items) {
			out.files.set(`${dir}/library.json`, this._jsonFile({
				id: library.libraryID,
				type: library.libraryType,
				name: library.name,
				groupID: library.libraryType === 'group' ? library.groupID : undefined,
				itemCount: exported.length,
			}));
			out.files.set(`${dir}/collections.json`, this._jsonFile(
				[...collections.values()]
					.map(c => ({
						key: c.key,
						name: c.name,
						parentKey: c.parentKey || null,
						path: c.path,
						relations: c.relations,
					}))
					.sort((a, b) => this._compare(a.path, b.path) || this._compare(a.key, b.key))
			));
			out.files.set(`${dir}/searches.json`, this._jsonFile(await this._buildSearches(library.libraryID)));
			out.files.set(`${dir}/settings.json`, this._jsonFile(this._buildSettings(library.libraryID)));
			if (config.exportIndex) {
				out.files.set(`${dir}/index.md`, this._textFile(
					this._buildLibraryIndex({ library, exported })
				));
			}
			if (config.exportBibTeX) {
				let bibtex = await this._exportBibTeX(topLevelItems.filter(i => i.isRegularItem()));
				if (bibtex) {
					out.files.set(`${dir}/library.bib`, this._textFile(bibtex));
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


	itemPath(dir, key) {
		return `${dir}/items/${ZoteroGitHubSync.Utils.shard(key)}/${key}.json`;
	},


	/**
	 * @param {Boolean} lfs
	 * @return {String} Repository directory holding an attachment's files,
	 * 		relative to the library directory
	 */
	attachmentDir(key, lfs) {
		return `${lfs ? 'attachments-lfs' : 'attachments'}/${ZoteroGitHubSync.Utils.shard(key)}/${key}`;
	},


	/**
	 * Plain code-unit ordering. localeCompare() depends on the user's locale,
	 * which would make the same library serialize differently on two machines.
	 */
	_compare(a, b) {
		a = String(a ?? '');
		b = String(b ?? '');
		return a < b ? -1 : a > b ? 1 : 0;
	},


	/**
	 * @return {Map<String, Object>} collection key -> { key, name, parentKey, path, relations }
	 */
	_buildCollectionIndex(libraryID) {
		let collections = Zotero.Collections.getByLibrary(libraryID, true) || [];
		let byKey = new Map();
		for (let collection of collections) {
			byKey.set(collection.key, {
				key: collection.key,
				name: collection.name,
				parentKey: collection.parentKey || null,
				relations: collection.getRelations?.() || {},
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


	async _buildSearches(libraryID) {
		let searches = [];
		try {
			for (let search of await Zotero.Searches.getAll(libraryID)) {
				if (search.deleted) {
					continue;
				}
				let json = search.toJSON();
				json.key = search.key;
				delete json.version;
				searches.push(json);
			}
		}
		catch (e) {
			ZoteroGitHubSync.logError(e);
		}
		return searches.sort((a, b) => this._compare(a.key, b.key));
	},


	_buildSettings(libraryID) {
		let settings = {};
		try {
			let tagColors = Zotero.SyncedSettings.get(libraryID, 'tagColors');
			if (tagColors) {
				settings.tagColors = tagColors;
			}
		}
		catch (e) {
			ZoteroGitHubSync.logError(e);
		}
		return settings;
	},


	/**
	 * Zotero API JSON with the bookkeeping that would churn the repository
	 * stripped out: `version` changes on every Zotero server sync even when
	 * nothing about the item did.
	 */
	_itemJSON(item) {
		let json = item.toJSON();
		json.key = item.key;
		delete json.version;
		if (Array.isArray(json.collections)) {
			json.collections.sort();
		}
		if (Array.isArray(json.tags)) {
			json.tags.sort((a, b) => this._compare(a.tag, b.tag) || (a.type || 0) - (b.type || 0));
		}
		return json;
	},


	/**
	 * Build everything we know about one top-level item and its descendants.
	 */
	async _buildItemRecord({ item, ctx }) {
		let { library, config, collections } = ctx;
		let json = this._itemJSON(item);

		let collectionPaths = (item.getCollections() || [])
			.map(id => Zotero.Collections.get(id))
			.filter(Boolean)
			.map(c => collections.get(c.key)?.path || c.name)
			.sort(this._compare);

		let children = [];
		let notes = [];
		let attachments = [];
		let imageLinks = new Map();

		let attachmentItems = [];
		if (item.isRegularItem()) {
			for (let id of item.getAttachments(false)) {
				attachmentItems.push(await Zotero.Items.getAsync(id));
			}
		}
		else if (item.isAttachment()) {
			// A standalone PDF is its own attachment
			attachmentItems.push(item);
		}

		for (let attachment of attachmentItems) {
			if (!attachment || attachment.deleted) {
				continue;
			}
			let entry = await this._buildAttachment({ attachment, ctx, children, isTopLevel: attachment === item });
			attachments.push(entry);
		}

		let noteItems = [];
		if (item.isRegularItem() && config.includeNotes) {
			for (let id of item.getNotes(false)) {
				noteItems.push(await Zotero.Items.getAsync(id));
			}
		}
		if (item.isNote()) {
			noteItems.push(item);
		}
		for (let note of noteItems) {
			if (!note || note.deleted) {
				continue;
			}
			if (note !== item) {
				children.push(this._itemJSON(note));
			}
			// Images pasted into a note are attachments of the note
			for (let id of note.getAttachments(false)) {
				let image = await Zotero.Items.getAsync(id);
				if (!image || image.deleted) {
					continue;
				}
				let entry = await this._buildAttachment({ attachment: image, ctx, children, isTopLevel: false });
				if (entry.files.length) {
					imageLinks.set(image.key, entry.files[0].path);
				}
			}
			notes.push({ key: note.key, item: note, title: note.getNoteTitle() || 'Note' });
		}

		children.sort((a, b) => this._compare(a.key, b.key));

		let markdownFilename = this._markdownFilename(item);
		let markdownPath = `notes/${ZoteroGitHubSync.Utils.letterShard(markdownFilename)}/${markdownFilename}`;
		// Links in the Markdown are relative to notes/<A>/
		let resolveImage = (key) => {
			let path = imageLinks.get(key);
			return path ? `../../${this._encodePath(path)}` : null;
		};
		for (let note of notes) {
			note.markdown = ZoteroGitHubSync.Utils.htmlToMarkdown(note.item.getNote(), { resolveImage });
		}

		let record = {
			key: item.key,
			item,
			json: {
				zotero: json,
				children,
				meta: {
					libraryID: library.libraryID,
					libraryName: library.name,
					itemType: item.itemType,
					title: item.getDisplayTitle(),
					creators: this._creatorStrings(item),
					year: this._year(item),
					collections: collectionPaths,
					zoteroURI: this.itemURI(item, library),
					notes: notes.filter(n => n.item !== item).map(n => ({ key: n.key, title: n.title })),
					attachments: attachments.map(({ annotations, ...rest }) => ({
						...rest,
						annotationCount: annotations.length,
					})),
				},
			},
			notes,
			attachments,
			collectionPaths,
			markdownFilename,
			markdownPath,
		};

		record.markdown = this._buildItemMarkdown({ record, library });
		return record;
	},


	/**
	 * Add an attachment, its annotations and its files to the export.
	 *
	 * @return {Promise<Object>} Summary for `meta.attachments`
	 */
	async _buildAttachment({ attachment, ctx, children, isTopLevel }) {
		let { config, dir, out } = ctx;
		if (!isTopLevel) {
			children.push(this._itemJSON(attachment));
		}

		let annotations = [];
		if (attachment.isFileAttachment()) {
			for (let annotation of attachment.getAnnotations(false)) {
				let annotationJSON = this._itemJSON(annotation);
				children.push(annotationJSON);
				annotations.push(annotationJSON);
			}
			annotations.sort((a, b) => this._compare(a.annotationSortIndex, b.annotationSortIndex));
		}

		let entry = {
			key: attachment.key,
			title: attachment.getField('title') || attachment.attachmentFilename || 'Attachment',
			filename: attachment.attachmentFilename || null,
			contentType: attachment.attachmentContentType || null,
			linkMode: Zotero.Attachments.linkModeToName(attachment.attachmentLinkMode),
			url: attachment.getField('url') || null,
			status: 'ok',
			files: [],
			annotations,
		};

		if (!attachment.isFileAttachment()) {
			entry.status = 'no-file';
			return entry;
		}

		let label = `${attachment.key} (${entry.filename || entry.title})`;
		let keepExisting = () => {
			// The item exists, so its file does too -- just not here. Leave
			// whatever an earlier sync uploaded exactly where it is.
			out.keepPrefixes.push(
				`${dir}/${this.attachmentDir(attachment.key, false)}/`,
				`${dir}/${this.attachmentDir(attachment.key, true)}/`
			);
		};

		if (!config.includeAttachments) {
			entry.status = 'not-synced';
			keepExisting();
			return entry;
		}

		let sources = [];
		if (attachment.isLinkedFileAttachment()) {
			if (!config.includeLinkedFiles) {
				entry.status = 'not-synced';
				keepExisting();
				return entry;
			}
			let path = await attachment.getFilePathAsync();
			let stat = path ? await ZoteroGitHubSync.Files.statFile(path) : null;
			if (!stat) {
				entry.status = 'missing';
				keepExisting();
				return entry;
			}
			sources.push({ ...stat, relPath: PathUtils.filename(path) });
		}
		else {
			let mainPath = await attachment.getFilePathAsync();
			if (!mainPath || !await IOUtils.exists(mainPath)) {
				// Common with "download files as needed": Zotero knows the file
				// but hasn't fetched it to this computer
				entry.status = 'missing';
				keepExisting();
				return entry;
			}
			let storageDir = Zotero.Attachments.getStorageDirectory(attachment).path;
			sources = await ZoteroGitHubSync.Files.listDirectory(storageDir);
			// The primary file first, so links in Markdown point at it
			let mainName = PathUtils.filename(mainPath);
			sources.sort((a, b) => (b.relPath === mainName) - (a.relPath === mainName) || this._compare(a.relPath, b.relPath));
		}

		for (let source of sources) {
			if (config.maxAttachmentBytes && source.size > config.maxAttachmentBytes) {
				out.warnings.push(
					`Skipped ${label}/${source.relPath}: ${ZoteroGitHubSync.Utils.formatSize(source.size)} is over the configured limit`
				);
				entry.status = 'partial';
				continue;
			}
			let lfs = config.lfsEnabled && source.size > config.lfsThresholdBytes;
			if (!lfs && source.size > this.GIT_HARD_LIMIT) {
				out.warnings.push(
					`Skipped ${label}/${source.relPath}: ${ZoteroGitHubSync.Utils.formatSize(source.size)} is over GitHub's 100 MB limit. Turn on Git LFS to sync it.`
				);
				entry.status = 'partial';
				continue;
			}
			let relPath = `${this.attachmentDir(attachment.key, lfs)}/${source.relPath}`;
			out.files.set(`${dir}/${relPath}`, {
				source: { path: source.path, size: source.size, mtime: source.mtime },
				lfs,
			});
			entry.files.push({ path: relPath, size: source.size, storage: lfs ? 'lfs' : 'git' });
		}
		return entry;
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


	_encodePath(path) {
		return String(path).split('/').map(encodeURIComponent).join('/');
	},


	_buildItemMarkdown({ record, library }) {
		let { item } = record;
		let get = (field) => {
			try {
				return item.getField ? item.getField(field) : '';
			}
			catch (e) {
				// Standalone notes and attachments lack most fields
				return '';
			}
		};

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
			tags: (item.getTags() || []).map(t => t.tag).sort(this._compare),
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
		let ownNote = record.notes.find(note => note.item === item);
		if (ownNote?.markdown) {
			sections.push(`${ownNote.markdown}\n`);
		}

		let extra = get('extra');
		if (extra) {
			sections.push(`## Extra\n\n${extra.trim()}\n`);
		}

		let childNotes = record.notes.filter(note => note.item !== item);
		if (childNotes.length) {
			let notes = childNotes.map(note => `### ${note.title}\n\n${note.markdown || '_(empty note)_'}\n`);
			sections.push(`## Notes\n\n${notes.join('\n')}`);
		}

		if (record.attachments.length) {
			let lines = record.attachments.map((attachment) => {
				let label = attachment.filename || attachment.title;
				if (attachment.files.length) {
					return `- [${label}](../../${this._encodePath(attachment.files[0].path)})`;
				}
				if (attachment.url) {
					return `- [${label}](${attachment.url})`;
				}
				return `- ${label} _(file not in repository: ${attachment.status})_`;
			});
			sections.push(`## Attachments\n\n${lines.join('\n')}\n`);
		}

		let annotated = record.attachments.filter(attachment => attachment.annotations.length);
		if (annotated.length) {
			let blocks = annotated.map((attachment) => {
				let lines = attachment.annotations.map(a => this._annotationMarkdown(a));
				let heading = annotated.length > 1 ? `### ${attachment.filename || attachment.title}\n\n` : '';
				return `${heading}${lines.join('\n')}\n`;
			});
			sections.push(`## Annotations\n\n${blocks.join('\n')}`);
		}

		sections.push(`---\n\n[Open in Zotero](${record.json.meta.zoteroURI})\n`);
		return sections.join('\n');
	},


	_annotationMarkdown(annotation) {
		let oneLine = value => String(value || '').replace(/\s*\n\s*/g, ' ').trim();
		let page = annotation.annotationPageLabel ? `p. ${annotation.annotationPageLabel}` : null;
		let head = [page, annotation.annotationType].filter(Boolean).join(', ');
		let parts = [`- **${head}**`];
		if (annotation.annotationText) {
			parts.push(`“${oneLine(annotation.annotationText)}”`);
		}
		let line = parts.join(' ');
		if (annotation.annotationComment) {
			line += `\n  ${oneLine(annotation.annotationComment)}`;
		}
		return line;
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
		for (let path of [...byCollection.keys()].sort(this._compare)) {
			lines.push(`## ${path}`, '');
			let records = byCollection.get(path).slice().sort((a, b) => {
				return this._compare(a.json.meta.title, b.json.meta.title) || this._compare(a.key, b.key);
			});
			for (let record of records) {
				let authors = record.json.meta.creators.slice(0, 3).join('; ');
				let year = record.json.meta.year;
				let suffix = [authors, year].filter(Boolean).join(', ');
				let target = this._encodePath(record.markdownPath);
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
			lines.push(`- [${stat.name}](${this._encodePath(stat.directory)}/index.md) — `
				+ `${stat.itemCount} item(s), ${stat.collectionCount} collection(s)`);
		}
		lines.push(
			'',
			'## Layout',
			'',
			'| Path | Contents |',
			'| --- | --- |',
			'| `<library>/items/<KE>/<KEY>.json` | One file per top-level item: Zotero API JSON for the item and all its notes, attachments and annotations |',
			'| `<library>/notes/<A>/*.md` | Markdown with YAML front matter, readable in Obsidian |',
			'| `<library>/collections.json` | Every collection and its full path |',
			'| `<library>/searches.json` | Saved searches |',
			'| `<library>/settings.json` | Tag colors |',
			'| `<library>/index.md` | Table of contents grouped by collection |',
		);
		if (config.exportBibTeX) {
			lines.push('| `<library>/library.bib` | BibTeX export of the library |');
		}
		if (config.includeAttachments) {
			lines.push('| `<library>/attachments/<KE>/<KEY>/` | Attachment files |');
			if (config.lfsEnabled) {
				lines.push('| `<library>/attachments-lfs/<KE>/<KEY>/` | Large attachment files, stored with Git LFS |');
			}
		}
		if (config.lfsEnabled && config.includeAttachments) {
			lines.push(
				'',
				'Large files are stored with [Git LFS](https://git-lfs.com). Install it before cloning, '
				+ 'or those files check out as small pointer files.'
			);
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
			// Not `constructor === Object`: objects from Zotero's toJSON() come
			// from another global, whose Object is a different function
			if (input && typeof input === 'object' && Object.prototype.toString.call(input) === '[object Object]') {
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
