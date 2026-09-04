/* Zotero GitHub Sync -- read a synced repository back into Zotero
 *
 * This is the "new laptop" direction, not a second sync engine: it adds items
 * the local library doesn't have and refreshes ones whose repository copy is
 * newer. It never deletes anything locally, so a mistake here costs a duplicate
 * at worst, not data.
 */

ZoteroGitHubSync.Importer = {
	BLOB_CONCURRENCY: 5,


	/**
	 * @param {Object} options
	 * @param {Object} options.config
	 * @param {String} options.token
	 * @param {Function} [options.onProgress]
	 * @return {Promise<Object>} { status, created, updated, skipped, attachments }
	 */
	async run({ config, token, onProgress = () => {} }) {
		let client = new ZoteroGitHubSync.GitHub({
			token,
			apiURL: config.apiURL,
			owner: config.owner,
			repo: config.repo,
		});

		let head = await client.getBranchHead(config.branch);
		if (!head) {
			throw new Error(
				`${config.owner}/${config.repo}@${config.branch} has no commits to import.`
			);
		}
		let commit = await client.getCommit(head);
		let remoteFiles = await client.listTree(commit.tree.sha);

		let libraries = this._groupByLibrary(remoteFiles, config);
		if (!libraries.size) {
			throw new Error(
				'No Zotero data found in the repository. Check the base path setting.'
			);
		}

		let totals = { status: 'ok', created: 0, updated: 0, skipped: 0, attachments: 0 };

		for (let [dir, group] of libraries) {
			let libraryID = this._resolveLibraryID(dir);
			if (libraryID === null) {
				ZoteroGitHubSync.log(`Skipping ${dir}: no matching local library`);
				totals.skipped += group.items.length;
				continue;
			}

			onProgress(`Reading ${dir}…`);
			if (group.collections) {
				await this._importCollections({ client, entry: group.collections, libraryID });
			}

			let records = await this._fetchItemRecords({ client, entries: group.items, onProgress });
			let result = await this._importItems({ records, libraryID });
			totals.created += result.created;
			totals.updated += result.updated;
			totals.skipped += result.skipped;

			if (config.includeAttachments && group.attachments.length) {
				onProgress('Restoring attachments…');
				totals.attachments += await this._importAttachments({
					client,
					entries: group.attachments,
					libraryID,
					attachmentParents: this._mapAttachmentParents(records),
				});
			}
		}

		return totals;
	},


	/**
	 * @return {Map<String, {collections: Object, items: Object[], attachments: Object[]}>}
	 */
	_groupByLibrary(remoteFiles, config) {
		let prefix = config.basePath ? `${config.basePath}/` : '';
		let libraries = new Map();

		let group = (dir) => {
			if (!libraries.has(dir)) {
				libraries.set(dir, { collections: null, items: [], attachments: [] });
			}
			return libraries.get(dir);
		};

		for (let [path, entry] of remoteFiles) {
			if (prefix && !path.startsWith(prefix)) {
				continue;
			}
			let rel = path.slice(prefix.length);
			let itemMatch = rel.match(/^([^/]+)\/items\/([A-Z0-9]+)\.json$/);
			if (itemMatch) {
				group(itemMatch[1]).items.push({ key: itemMatch[2], sha: entry.sha });
				continue;
			}
			let collectionsMatch = rel.match(/^([^/]+)\/collections\.json$/);
			if (collectionsMatch) {
				group(collectionsMatch[1]).collections = { sha: entry.sha };
				continue;
			}
			let attachmentMatch = rel.match(/^([^/]+)\/attachments\/([A-Z0-9]+)\/(.+)$/);
			if (attachmentMatch) {
				group(attachmentMatch[1]).attachments.push({
					key: attachmentMatch[2],
					filename: attachmentMatch[3],
					sha: entry.sha,
					size: entry.size,
				});
			}
		}

		// Directories with no items aren't libraries
		for (let [dir, data] of [...libraries]) {
			if (!data.items.length) {
				libraries.delete(dir);
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
		let bytes = await client.getBlobBytes(sha);
		return JSON.parse(ZoteroGitHubSync.Utils.textDecoder.decode(bytes));
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
					ZoteroGitHubSync.logError(e);
					return null;
				}
			},
			this.BLOB_CONCURRENCY
		);
		return records.filter(Boolean);
	},


	async _importItems({ records, libraryID }) {
		let created = 0;
		let updated = 0;
		let skipped = 0;

		// A child item can't be saved before its parent exists
		let ordered = records.slice().sort((a, b) => {
			let aChild = a.data?.zotero?.parentItem ? 1 : 0;
			let bChild = b.data?.zotero?.parentItem ? 1 : 0;
			return aChild - bChild;
		});

		for (let record of ordered) {
			let json = record.data?.zotero;
			if (!json?.itemType) {
				skipped++;
				continue;
			}
			// Attachment files are restored separately; importing the item alone
			// would leave a permanently broken link in the library
			if (json.itemType === 'attachment') {
				skipped++;
				continue;
			}

			try {
				let existing = Zotero.Items.getByLibraryAndKey(libraryID, record.key);
				if (existing) {
					if (!this._remoteIsNewer(json, existing)) {
						skipped++;
						continue;
					}
					existing.fromJSON(this._prepareJSON(json, libraryID));
					await existing.saveTx({ skipSelect: true });
					updated++;
				}
				else {
					let item = new Zotero.Item();
					item.libraryID = libraryID;
					item.key = record.key;
					await item.loadPrimaryData();
					item.fromJSON(this._prepareJSON(json, libraryID));
					await item.saveTx({ skipSelect: true, skipCache: true });
					created++;
				}
			}
			catch (e) {
				ZoteroGitHubSync.logError(
					new Error(`Failed to import item ${record.key}: ${e.message || e}`)
				);
				skipped++;
			}
		}

		return { created, updated, skipped };
	},


	/**
	 * Strip the fields that belong to whoever exported the data rather than to
	 * this library: `version` is Zotero-server bookkeeping, and a parent or
	 * collection we don't have locally would fail validation.
	 */
	_prepareJSON(json, libraryID) {
		let prepared = { ...json };
		delete prepared.version;
		delete prepared.key;

		if (prepared.parentItem && !Zotero.Items.getByLibraryAndKey(libraryID, prepared.parentItem)) {
			delete prepared.parentItem;
		}
		if (Array.isArray(prepared.collections)) {
			prepared.collections = prepared.collections.filter(
				key => Zotero.Collections.getByLibraryAndKey(libraryID, key)
			);
		}
		return prepared;
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
	 * Download attachment files whose parent item exists locally and that aren't
	 * already attached under the same filename.
	 *
	 * @return {Promise<Number>} Number of files imported
	 */
	async _importAttachments({ client, entries, libraryID, attachmentParents }) {
		let imported = 0;
		let tempDir = Zotero.getTempDirectory().path;

		for (let entry of entries) {
			try {
				// The key in the path is the exported attachment's own key; its
				// parent comes from the exported item metadata
				let existing = Zotero.Items.getByLibraryAndKey(libraryID, entry.key);
				if (existing) {
					continue;
				}
				let parentKey = attachmentParents.get(entry.key);
				let parentItem = parentKey
					? Zotero.Items.getByLibraryAndKey(libraryID, parentKey)
					: null;
				if (!parentItem) {
					continue;
				}
				if (await this._parentHasFile(parentItem, entry.filename)) {
					continue;
				}

				let bytes = await client.getBlobBytes(entry.sha);
				let tempPath = PathUtils.join(
					tempDir,
					`zgs-${entry.key}-${ZoteroGitHubSync.Utils.sanitizeSegment(entry.filename, 100)}`
				);
				await IOUtils.write(tempPath, bytes, { tmpPath: `${tempPath}.tmp` });
				try {
					await Zotero.Attachments.importFromFile({
						file: tempPath,
						parentItemID: parentItem.id,
						title: entry.filename,
					});
					imported++;
				}
				finally {
					await IOUtils.remove(tempPath, { ignoreAbsent: true });
				}
			}
			catch (e) {
				ZoteroGitHubSync.logError(e);
			}
		}
		return imported;
	},


	/**
	 * Attachment items themselves are not imported, so the link back to a parent
	 * comes from the `meta.attachments` list the exporter writes on each item.
	 *
	 * @return {Map<String, String>} attachment key -> parent item key
	 */
	_mapAttachmentParents(records) {
		let parents = new Map();
		for (let record of records) {
			for (let attachment of record.data?.meta?.attachments || []) {
				if (attachment?.key) {
					parents.set(attachment.key, record.key);
				}
			}
		}
		return parents;
	},


	async _parentHasFile(parentItem, filename) {
		for (let id of parentItem.getAttachments(false)) {
			let attachment = await Zotero.Items.getAsync(id);
			if (attachment?.attachmentFilename === filename) {
				return true;
			}
		}
		return false;
	},
};
