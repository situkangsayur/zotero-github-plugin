/* Zotero GitHub Sync -- read a synced repository back into Zotero
 *
 * This is the "new laptop" direction, not a second sync engine: it adds items
 * the local library doesn't have, refreshes ones whose repository copy is newer,
 * and puts back attachment files that are missing on disk. It never deletes
 * anything locally, so a mistake here costs a duplicate at worst, not data.
 *
 * Items keep their keys, attachments included, which is what lets annotations
 * and note images find their parents again.
 */

ZoteroGitHubSync.Importer = {
	BLOB_CONCURRENCY: 5,


	/**
	 * Split a repository file path into the segments to join onto a local
	 * directory. A Git tree is not supposed to carry `.`, `..` or an empty
	 * component, but it comes from the server, so check instead of trusting it:
	 * a path like `../../evil` would otherwise write outside the attachment's
	 * storage folder.
	 *
	 * @param {String} name - Path relative to the attachment's folder in the repository
	 * @return {String[]|null} The segments, or null if the path leaves the folder
	 */
	safeSegments(name) {
		let segments = String(name || '').split('/');
		if (!segments.length || segments.some(s => !s || s === '.' || s === '..' || s.includes('\\'))) {
			return null;
		}
		return segments;
	},


	/**
	 * @param {Object} options
	 * @param {Object} options.config
	 * @param {String} options.token
	 * @param {Function} [options.onProgress]
	 * @return {Promise<Object>} { status, created, updated, skipped, files, failures }
	 */
	async run({ config, token, cancel = null, onProgress = () => {} }) {
		let client = new ZoteroGitHubSync.GitHub({
			token,
			apiURL: config.apiURL,
			owner: config.owner,
			repo: config.repo,
			cancel,
		});

		let head = await client.getBranchHead(config.branch);
		if (!head) {
			throw new Error(
				`${config.owner}/${config.repo}@${config.branch} has no commits to import.`
			);
		}
		let commit = await client.getCommit(head);
		let remoteFiles = await client.listTree(commit.tree.sha);

		let libraries = this.groupByLibrary(remoteFiles, config);
		if (!libraries.size) {
			throw new Error(
				'No Zotero data found in the repository. Check the base path setting.'
			);
		}
		return this._importGroups({ client, config, token, libraries, cancel, onProgress });
	},


	/**
	 * Import only the repository paths a person accepted in the review: changes
	 * made on GitHub or by another computer, and conflicts resolved in favour of
	 * the repository. Items are updated even when the local copy is newer, and
	 * files are overwritten, because that is what was chosen.
	 *
	 * @param {Object} options
	 * @param {ZoteroGitHubSync.GitHub} options.client
	 * @param {Map<String, Object>} options.remoteFiles - The whole remote tree
	 * @param {Iterable<String>} options.relPaths - Accepted paths, relative to the base path
	 * @param {Set<String>} [options.keepBoth] - File paths to add as a second attachment
	 * 		instead of replacing the local file
	 * @return {Promise<Object>} Totals, as run()
	 */
	async applyIncoming({ client, config, token, remoteFiles, relPaths, keepBoth = new Set(), cancel = null, onProgress = () => {} }) {
		let prefix = config.basePath ? `${config.basePath}/` : '';
		let wanted = new Set([...relPaths].map(p => prefix + p));
		let subset = new Map([...remoteFiles].filter(([path]) => wanted.has(path)));
		let libraries = this.groupByLibrary(subset, config, { keepEmpty: true });
		return this._importGroups({
			client, config, token, libraries, cancel, onProgress,
			force: true,
			overwriteFiles: true,
			keepBoth,
		});
	},


	async _importGroups({ client, config, token, libraries, cancel, onProgress, force = false, overwriteFiles = false, keepBoth = new Set() }) {
		let totals = { status: 'ok', created: 0, updated: 0, skipped: 0, files: 0, failures: [] };
		let ctx = { client, config, token, totals, onProgress, lfs: null };

		for (let [dir, group] of libraries) {
			cancel?.throwIfCancelled();
			let libraryID = this._resolveLibraryID(dir);
			if (libraryID === null) {
				ZoteroGitHubSync.log(`Skipping ${dir}: no matching local library`);
				totals.skipped += group.items.length;
				continue;
			}
			if (!Zotero.Libraries.get(libraryID)?.editable) {
				ZoteroGitHubSync.log(`Skipping ${dir}: library is read-only`);
				totals.skipped += group.items.length;
				continue;
			}

			onProgress(`Reading ${dir}…`);
			if (group.collections) {
				await this._importCollections({ client, entry: group.collections, libraryID });
			}

			if (group.items.length) {
				let records = await this._fetchItemRecords({ client, entries: group.items, onProgress });
				let result = await this._importItems({ records, libraryID, group, onProgress, force });
				totals.created += result.created;
				totals.updated += result.updated;
				totals.skipped += result.skipped;
			}

			if ((config.includeAttachments || overwriteFiles) && group.files.size) {
				onProgress(ZoteroGitHubSync.getString('progress.restoring'));
				totals.files += await this._restoreFiles({ ctx, group, libraryID, overwrite: overwriteFiles, keepBoth });
			}

			if (group.searches) {
				await this._importSearches({ client, entry: group.searches, libraryID });
			}
			if (group.settings) {
				await this._importSettings({ client, entry: group.settings, libraryID });
			}
		}

		if (totals.failures.length) {
			totals.failures.forEach(f => ZoteroGitHubSync.warn(f));
		}
		return totals;
	},


	/**
	 * @return {Map<String, Object>} library directory -> {
	 * 		collections, searches, settings: tree entries or null,
	 * 		items: [{ key, sha }],
	 * 		files: Map<attachmentKey, [{ name, sha, size, lfs }]>
	 * 	}
	 */
	groupByLibrary(remoteFiles, config, { keepEmpty = false } = {}) {
		let prefix = config.basePath ? `${config.basePath}/` : '';
		let libraries = new Map();

		let group = (dir) => {
			if (!libraries.has(dir)) {
				libraries.set(dir, {
					collections: null,
					searches: null,
					settings: null,
					items: [],
					files: new Map(),
				});
			}
			return libraries.get(dir);
		};

		for (let [path, entry] of remoteFiles) {
			if (prefix && !path.startsWith(prefix)) {
				continue;
			}
			let rel = path.slice(prefix.length);

			// Sharded (items/AB/ABCD1234.json) and flat layouts both read back
			let itemMatch = rel.match(/^([^/]+)\/items\/(?:[A-Z0-9]{2}\/)?([A-Z0-9]{8})\.json$/);
			if (itemMatch) {
				group(itemMatch[1]).items.push({ key: itemMatch[2], sha: entry.sha });
				continue;
			}
			let libraryFileMatch = rel.match(/^([^/]+)\/(collections|searches|settings)\.json$/);
			if (libraryFileMatch) {
				group(libraryFileMatch[1])[libraryFileMatch[2]] = { sha: entry.sha };
				continue;
			}
			let fileMatch = rel.match(/^([^/]+)\/(attachments|attachments-lfs)\/(?:[A-Z0-9]{2}\/)?([A-Z0-9]{8})\/(.+)$/);
			if (fileMatch) {
				let files = group(fileMatch[1]).files;
				if (!files.has(fileMatch[3])) {
					files.set(fileMatch[3], []);
				}
				files.get(fileMatch[3]).push({
					path: rel,
					name: fileMatch[4],
					sha: entry.sha,
					size: entry.size,
					lfs: fileMatch[2] === 'attachments-lfs',
				});
			}
		}

		// Directories with no items aren't libraries -- unless this is a subset
		// of paths chosen in a review, which may hold only files or settings
		if (!keepEmpty) {
			for (let [dir, data] of [...libraries]) {
				if (!data.items.length) {
					libraries.delete(dir);
				}
			}
		}
		return libraries;
	},


	/**
	 * @return {Number|null} Local library to import a directory into, or null if
	 * 		there isn't one (a group the user doesn't belong to, say)
	 */
	_resolveLibraryID(dir) {
		if (dir === 'my-library') {
			return Zotero.Libraries.userLibraryID;
		}
		let match = dir.match(/^group-(\d+)-/);
		if (match) {
			try {
				let group = Zotero.Groups.get(Number(match[1]));
				return group ? group.libraryID : null;
			}
			catch (e) {
				// The user isn't a member of this group locally
				return null;
			}
		}
		return null;
	},


	async _readJSON(client, sha) {
		return JSON.parse(await client.getBlobText(sha));
	},


	async _importCollections({ client, entry, libraryID }) {
		let collections;
		try {
			collections = await this._readJSON(client, entry.sha);
		}
		catch (e) {
			ZoteroGitHubSync.logError(e);
			return;
		}
		if (!Array.isArray(collections)) {
			return;
		}

		// Parents before children, so parentKey always resolves
		let byKey = new Map(collections.map(c => [c.key, c]));
		let ordered = [];
		let seen = new Set();
		let visit = (collection, stack = new Set()) => {
			if (!collection || seen.has(collection.key) || stack.has(collection.key)) {
				return;
			}
			stack.add(collection.key);
			if (collection.parentKey) {
				visit(byKey.get(collection.parentKey), stack);
			}
			seen.add(collection.key);
			ordered.push(collection);
		};
		for (let collection of collections) {
			visit(collection);
		}

		for (let data of ordered) {
			if (Zotero.Collections.getByLibraryAndKey(libraryID, data.key)) {
				continue;
			}
			try {
				let collection = new Zotero.Collection();
				collection.libraryID = libraryID;
				collection.key = data.key;
				await collection.loadPrimaryData();
				collection.name = data.name;
				if (data.parentKey && Zotero.Collections.getByLibraryAndKey(libraryID, data.parentKey)) {
					collection.parentKey = data.parentKey;
				}
				await collection.saveTx();
			}
			catch (e) {
				ZoteroGitHubSync.logError(e);
			}
		}
	},


	async _fetchItemRecords({ client, entries, onProgress }) {
		let done = 0;
		let records = await ZoteroGitHubSync.Utils.pMap(
			entries,
			async (entry) => {
				try {
					let data = await this._readJSON(client, entry.sha);
					done++;
					if (done % 25 === 0) {
						onProgress(`Downloaded ${done}/${entries.length} items…`);
					}
					return { key: entry.key, data };
				}
				catch (e) {
					if (e instanceof ZoteroGitHubSync.CancelledError) {
						throw e;
					}
					ZoteroGitHubSync.logError(e);
					return null;
				}
			},
			this.BLOB_CONCURRENCY
		);
		return records.filter(Boolean);
	},


	/**
	 * Every item JSON in the records, parents before children: regular items
	 * and standalone notes/attachments, then child notes and attachments, then
	 * annotations and note images.
	 *
	 * @return {Object[]} Zotero API JSON
	 */
	flattenRecords(records) {
		let byKey = new Map();
		for (let record of records) {
			let data = record.data;
			for (let json of [data?.zotero, ...(Array.isArray(data?.children) ? data.children : [])]) {
				if (json?.itemType && json.key && !byKey.has(json.key)) {
					byKey.set(json.key, json);
				}
			}
		}
		let depthCache = new Map();
		let depth = (json, seen = new Set()) => {
			if (depthCache.has(json.key)) {
				return depthCache.get(json.key);
			}
			let parent = json.parentItem ? byKey.get(json.parentItem) : null;
			let value = parent && !seen.has(parent.key)
				? depth(parent, seen.add(json.key)) + 1
				: 0;
			depthCache.set(json.key, value);
			return value;
		};
		return [...byKey.values()]
			.map(json => ({ json, depth: depth(json) }))
			.sort((a, b) => a.depth - b.depth || (a.json.key < b.json.key ? -1 : 1))
			.map(entry => entry.json);
	},


	async _importItems({ records, libraryID, group, onProgress, force = false }) {
		let created = 0;
		let updated = 0;
		let skipped = 0;
		let all = this.flattenRecords(records);

		for (let json of all) {
			try {
				let existing = Zotero.Items.getByLibraryAndKey(libraryID, json.key);
				if (existing) {
					if (!force && !this._remoteIsNewer(json, existing)) {
						skipped++;
						continue;
					}
					existing.fromJSON(this._prepareJSON(json, libraryID, group));
					// Keep the repository's modification date, so exporting the item
					// again produces the same file instead of a new commit
					await existing.saveTx({ skipSelect: true, skipDateModifiedUpdate: true });
					updated++;
				}
				else {
					let item = new Zotero.Item();
					item.libraryID = libraryID;
					item.key = json.key;
					await item.loadPrimaryData();
					item.fromJSON(this._prepareJSON(json, libraryID, group, { isNew: true }));
					await item.saveTx({ skipSelect: true, skipCache: true, skipDateModifiedUpdate: true });
					created++;
				}
			}
			catch (e) {
				ZoteroGitHubSync.logError(
					new Error(`Failed to import item ${json.key}: ${e.message || e}`)
				);
				skipped++;
			}
			if ((created + updated + skipped) % 100 === 0) {
				onProgress(`Imported ${created + updated + skipped}/${all.length} items…`);
			}
		}

		return { created, updated, skipped };
	},


	/**
	 * Strip the fields that belong to whoever exported the data rather than to
	 * this library: `version` is Zotero-server bookkeeping, and a parent or
	 * collection we don't have locally would fail validation.
	 */
	_prepareJSON(json, libraryID, group, { isNew = false } = {}) {
		let prepared = { ...json };
		delete prepared.version;
		delete prepared.key;
		delete prepared.mtime;
		delete prepared.md5;

		if (prepared.parentItem && !Zotero.Items.getByLibraryAndKey(libraryID, prepared.parentItem)) {
			delete prepared.parentItem;
		}
		if (Array.isArray(prepared.collections)) {
			prepared.collections = prepared.collections.filter(
				key => Zotero.Collections.getByLibraryAndKey(libraryID, key)
			);
		}

		// A linked file whose path doesn't exist on this computer would be a
		// broken link. If the repository has the file, bring it in as a stored
		// file instead.
		if (isNew && prepared.itemType === 'attachment' && prepared.linkMode === 'linked_file') {
			let repoFiles = group.files.get(json.key);
			if (repoFiles?.length && !this._linkedPathExists(prepared.path)) {
				prepared.linkMode = 'imported_file';
				prepared.filename = repoFiles[0].name.split('/').pop();
				delete prepared.path;
			}
		}
		return this.orderForFromJSON(prepared);
	},


	// Zotero.Item.prototype.fromJSON() applies fields in the order it meets them,
	// and some fields refuse to be set before others: an attachment's path or
	// filename needs its link mode, and every annotation field needs the type.
	// The exporter sorts keys alphabetically, which puts them the wrong way round.
	FROM_JSON_FIRST: ['itemType', 'parentItem', 'linkMode', 'contentType', 'charset', 'annotationType'],

	/**
	 * @param {Object} json
	 * @return {Object} The same fields, with the ones fromJSON() depends on first
	 */
	orderForFromJSON(json) {
		let ordered = {};
		for (let key of this.FROM_JSON_FIRST) {
			if (key in json) {
				ordered[key] = json[key];
			}
		}
		for (let [key, value] of Object.entries(json)) {
			if (!(key in ordered)) {
				ordered[key] = value;
			}
		}
		return ordered;
	},


	_linkedPathExists(path) {
		try {
			if (!path) {
				return false;
			}
			let resolved = path.startsWith('attachments:')
				? Zotero.Attachments.resolveRelativePath(path)
				: path;
			return !!resolved && Zotero.File.pathToFile(resolved).exists();
		}
		catch (e) {
			return false;
		}
	},


	_remoteIsNewer(json, item) {
		if (!json.dateModified) {
			return false;
		}
		let remote = new Date(json.dateModified.replace(' ', 'T') + 'Z').getTime();
		let local = new Date(String(item.dateModified).replace(' ', 'T') + 'Z').getTime();
		return Number.isFinite(remote) && Number.isFinite(local) && remote > local;
	},


	/**
	 * Put attachment files back into Zotero's storage directory, the same place
	 * Zotero's own file sync writes them. Files already present with the right
	 * size are left alone, so running an import twice costs nothing.
	 *
	 * @return {Promise<Number>} Files written
	 */
	async _restoreFiles({ ctx, group, libraryID, overwrite = false, keepBoth = new Set() }) {
		let { client, config, totals } = ctx;
		let written = 0;
		let lfsTargets = [];
		let copies = [];

		for (let [key, entries] of group.files) {
			let attachment = Zotero.Items.getByLibraryAndKey(libraryID, key);
			if (!attachment || !attachment.isFileAttachment()) {
				continue;
			}
			if (attachment.isLinkedFileAttachment() && !keepBoth.size) {
				// A linked file that resolves here is the user's own copy
				continue;
			}
			let storageDir = Zotero.Attachments.getStorageDirectory(attachment).path;

			for (let entry of entries) {
				let label = `${key}/${entry.name}`;
				let segments = this.safeSegments(entry.name);
				if (!segments) {
					totals.failures.push(`${label}: the repository path leaves the attachment folder`);
					continue;
				}
				let both = keepBoth.has(entry.path);
				let tempRoot = PathUtils.join(Zotero.getTempDirectory().path, `zgs-copy-${key}`);
				let target = both
					? PathUtils.join(tempRoot, ...segments)
					: PathUtils.join(storageDir, ...segments);
				try {
					let pointer = null;
					let size = entry.size;
					if (entry.lfs) {
						// The tree holds a pointer; read it for the object ID
						pointer = ZoteroGitHubSync.Utils.parseLFSPointer(await client.getBlobText(entry.sha));
						if (!pointer) {
							totals.failures.push(`${label}: not a valid Git LFS pointer`);
							continue;
						}
						size = pointer.size;
					}
					if (!both) {
						let stat = await ZoteroGitHubSync.Files.statFile(target);
						if (stat && stat.size === size && !overwrite) {
							continue;
						}
						if (stat && !overwrite) {
							// Never replace a file that differs from the repository copy
							// unless someone chose the repository's version
							totals.failures.push(
								`${label}: kept the file on this computer; the repository copy differs `
								+ '(choose it in Review sync changes to replace it)'
							);
							continue;
						}
					}
					if (both) {
						copies.push({ attachment, target, tempRoot, name: entry.name });
					}
					if (pointer) {
						lfsTargets.push({ ...pointer, path: target, label });
					}
					else {
						await client.downloadBlob(entry.sha, target);
						if (!both) {
							written++;
						}
					}
				}
				catch (e) {
					totals.failures.push(`${label}: ${e.message || e}`);
				}
			}
		}

		if (lfsTargets.length) {
			if (!ctx.lfs) {
				ctx.lfs = await ZoteroGitHubSync.Sync._lfsClient(client, config, ctx.token);
			}
			let failed = await ctx.lfs.downloadAll(lfsTargets, { ref: `refs/heads/${config.branch}` });
			let failedPaths = new Set(failed.map(f => f.path));
			written += lfsTargets.filter(t => !failedPaths.has(t.path) && !copies.some(c => c.target === t.path)).length;
			for (let failure of failed) {
				totals.failures.push(`${failure.label}: ${failure.error}`);
			}
			copies = copies.filter(c => !failedPaths.has(c.target));
		}

		// "Keep both": the repository's version becomes a second attachment next
		// to the local one, so nothing is lost and both get synced
		for (let copy of copies) {
			try {
				let parentItemID = copy.attachment.parentID || null;
				let dot = copy.name.lastIndexOf('.');
				let base = dot > 0 ? copy.name.slice(0, dot) : copy.name;
				let ext = dot > 0 ? copy.name.slice(dot) : '';
				let renamed = PathUtils.join(PathUtils.parent(copy.target), `${base} (GitHub copy)${ext}`);
				await IOUtils.move(copy.target, renamed);
				let imported = await Zotero.Attachments.importFromFile({
					file: renamed,
					parentItemID,
					libraryID: parentItemID ? undefined : copy.attachment.libraryID,
					collections: parentItemID ? undefined : copy.attachment.getCollections(),
					title: `${copy.attachment.getField('title') || base} (GitHub copy)`,
				});
				if (imported) {
					written++;
				}
			}
			catch (e) {
				totals.failures.push(`${copy.attachment.key}/${copy.name}: could not keep the GitHub copy: ${e.message || e}`);
			}
		}
		// One temp folder holds every file of a multi-file attachment, so it can
		// only go once they have all been imported
		for (let root of new Set(copies.map(c => c.tempRoot))) {
			try {
				await IOUtils.remove(root, { recursive: true, ignoreAbsent: true });
			}
			catch (e) {}
		}
		return written;
	},


	async _importSearches({ client, entry, libraryID }) {
		let searches;
		try {
			searches = await this._readJSON(client, entry.sha);
		}
		catch (e) {
			ZoteroGitHubSync.logError(e);
			return;
		}
		for (let json of Array.isArray(searches) ? searches : []) {
			if (!json?.key || Zotero.Searches.getByLibraryAndKey(libraryID, json.key)) {
				continue;
			}
			try {
				let search = new Zotero.Search();
				search.libraryID = libraryID;
				search.key = json.key;
				await search.loadPrimaryData();
				let prepared = { ...json };
				delete prepared.key;
				delete prepared.version;
				search.fromJSON(prepared);
				await search.saveTx();
			}
			catch (e) {
				ZoteroGitHubSync.logError(new Error(`Failed to import saved search ${json.key}: ${e.message || e}`));
			}
		}
	},


	async _importSettings({ client, entry, libraryID }) {
		let settings;
		try {
			settings = await this._readJSON(client, entry.sha);
		}
		catch (e) {
			ZoteroGitHubSync.logError(e);
			return;
		}
		let remoteColors = Array.isArray(settings?.tagColors) ? settings.tagColors : [];
		if (!remoteColors.length) {
			return;
		}
		try {
			// Merge rather than replace: a color the user set locally wins
			let local = Zotero.SyncedSettings.get(libraryID, 'tagColors') || [];
			let names = new Set(local.map(c => c.name));
			let merged = [...local, ...remoteColors.filter(c => c?.name && !names.has(c.name))];
			if (merged.length !== local.length) {
				await Zotero.SyncedSettings.set(libraryID, 'tagColors', merged);
			}
		}
		catch (e) {
			ZoteroGitHubSync.logError(e);
		}
	},
};
