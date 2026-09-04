/* Zotero GitHub Sync -- orchestration and scheduling
 *
 * One sync is: export the library to files, compare their Git blob hashes with
 * what the branch already contains, upload only what changed, and land it as a
 * single commit.
 *
 * Deletions are driven by `.zotero-sync/files.json`, a sorted list of the paths
 * this plugin wrote last time. Pruning only ever touches paths on that list, so
 * pointing the plugin at a repository root can never delete files that belong to
 * something else.
 */

ZoteroGitHubSync.Sync = {
	FILE_LIST_PATH: '.zotero-sync/files.json',
	TREE_CHUNK_SIZE: 200,
	BLOB_CONCURRENCY: 4,
	STARTUP_DELAY_MS: 60 * 1000,

	status: 'idle',
	lastResult: null,

	_running: false,
	_intervalTimer: null,
	_changeTimer: null,
	_startupTimer: null,
	_notifierID: null,
	_suppressChangeTrigger: false,


	// -- Lifecycle ---------------------------------------------------------

	init() {
		ZoteroGitHubSync.Prefs.observe(
			['intervalEnabled', 'intervalMinutes', 'syncOnChange', 'changeDelayMinutes'],
			() => this.updateSchedule()
		);
		this.updateSchedule();

		if (ZoteroGitHubSync.Prefs.getConfig().syncOnStartup) {
			this._startupTimer = setTimeout(() => {
				this._startupTimer = null;
				this.syncNow({ trigger: 'startup', silent: true }).catch(e => ZoteroGitHubSync.logError(e));
			}, this.STARTUP_DELAY_MS);
		}
	},


	shutdown() {
		this._clearTimer('_intervalTimer', true);
		this._clearTimer('_changeTimer');
		this._clearTimer('_startupTimer');
		if (this._notifierID) {
			Zotero.Notifier.unregisterObserver(this._notifierID);
			this._notifierID = null;
		}
		ZoteroGitHubSync.Prefs.unobserveAll();
	},


	_clearTimer(name, isInterval = false) {
		if (this[name]) {
			(isInterval ? clearInterval : clearTimeout)(this[name]);
			this[name] = null;
		}
	},


	/**
	 * Bring the periodic timer and the change observer in line with the prefs.
	 * Called on startup and whenever one of those prefs changes.
	 */
	updateSchedule() {
		let config = ZoteroGitHubSync.Prefs.getConfig();

		this._clearTimer('_intervalTimer', true);
		if (config.intervalEnabled) {
			let ms = config.intervalMinutes * 60 * 1000;
			this._intervalTimer = setInterval(() => {
				this.syncNow({ trigger: 'interval', silent: true }).catch(e => ZoteroGitHubSync.logError(e));
			}, ms);
			ZoteroGitHubSync.log(`Periodic sync every ${config.intervalMinutes} minute(s)`);
		}

		if (config.syncOnChange && !this._notifierID) {
			this._notifierID = Zotero.Notifier.registerObserver(
				{ notify: (...args) => this._onNotify(...args) },
				['item', 'collection', 'item-tag'],
				'zotero-github-sync'
			);
			ZoteroGitHubSync.log('Watching the library for changes');
		}
		else if (!config.syncOnChange && this._notifierID) {
			Zotero.Notifier.unregisterObserver(this._notifierID);
			this._notifierID = null;
			this._clearTimer('_changeTimer');
		}
	},


	_onNotify(event, type, ids, _extraData) {
		if (this._suppressChangeTrigger || this._running) {
			return;
		}
		if (!['add', 'modify', 'delete', 'trash'].includes(event) || !ids?.length) {
			return;
		}
		let config = ZoteroGitHubSync.Prefs.getConfig();
		if (!config.syncOnChange) {
			return;
		}
		// Editing an item fires a stream of notifications; wait until the user
		// has been quiet for a while rather than syncing after every keystroke
		this._clearTimer('_changeTimer');
		this._changeTimer = setTimeout(() => {
			this._changeTimer = null;
			this.syncNow({ trigger: 'change', silent: true }).catch(e => ZoteroGitHubSync.logError(e));
		}, config.changeDelayMinutes * 60 * 1000);
	},


	_setStatus(status) {
		this.status = status;
		try {
			ZoteroGitHubSync.UI.onStatusChange(status);
		}
		catch (e) {
			ZoteroGitHubSync.logError(e);
		}
	},


	// -- Sync --------------------------------------------------------------

	/**
	 * @param {Object} [options]
	 * @param {String} [options.trigger='manual'] - manual | interval | change | startup
	 * @param {Zotero.Item[]} [options.items] - Sync only these items
	 * @param {Boolean} [options.silent] - Don't open a progress window on success
	 * @return {Promise<Object>} { status, added, updated, deleted, commit }
	 */
	async syncNow({ trigger = 'manual', items = null, silent = false } = {}) {
		if (this._running) {
			if (!silent) {
				this._showError(new Error(ZoteroGitHubSync.getString('error.running')));
			}
			return { status: 'busy' };
		}

		let config = ZoteroGitHubSync.Prefs.getConfig();
		let token = await ZoteroGitHubSync.Prefs.getToken();
		if (!config.owner || !config.repo || !token) {
			if (!silent) {
				this._showError(new Error(ZoteroGitHubSync.getString('error.notConfigured')));
			}
			return { status: 'not-configured' };
		}
		if (items && !items.length) {
			if (!silent) {
				this._showError(new Error(ZoteroGitHubSync.getString('error.noItems')));
			}
			return { status: 'no-items' };
		}

		this._running = true;
		this._setStatus('syncing');
		// Background syncs stay out of the way; only failures interrupt
		let progress = silent ? null : this._openProgress();

		try {
			let result = await this._runSyncWithRetry({ config, token, items, progress, trigger });
			ZoteroGitHubSync.Prefs.set('lastSync', ZoteroGitHubSync.Utils.isoDate());
			ZoteroGitHubSync.Prefs.set('lastError', '');
			if (result.commit) {
				ZoteroGitHubSync.Prefs.set('lastCommit', result.commit);
			}
			this.lastResult = result;
			this._setStatus('idle');

			if (progress) {
				if (result.status === 'up-to-date') {
					progress.changeHeadline(ZoteroGitHubSync.getString('progress.upToDate'));
					progress.addDescription(`${config.owner}/${config.repo}`);
				}
				else {
					progress.changeHeadline(ZoteroGitHubSync.getString(
						'progress.done',
						String(result.added + result.updated + result.deleted),
						`${config.owner}/${config.repo}`
					));
					progress.addDescription(
						`+${result.added} ~${result.updated} -${result.deleted}`
						+ (result.commit ? `  (${result.commit.slice(0, 7)})` : '')
					);
				}
				progress.startCloseTimer(5000);
			}
			return result;
		}
		catch (e) {
			ZoteroGitHubSync.logError(e);
			ZoteroGitHubSync.Prefs.set('lastError', e.message || String(e));
			this._setStatus('error');
			if (progress) {
				progress.close();
			}
			// A background sync shouldn't throw a window in the user's face, but
			// they still need to know it stopped working
			this._showError(e, { silent });
			return { status: 'error', error: e.message || String(e) };
		}
		finally {
			this._running = false;
		}
	},


	/**
	 * If the branch moved while we were building the commit -- another machine
	 * synced, or someone pushed -- GitHub refuses the non-fast-forward ref
	 * update. Redoing the sync against the new head is the correct response, and
	 * it is cheap: the second pass re-uses every blob that already uploaded.
	 */
	async _runSyncWithRetry(options) {
		try {
			return await this._runSync(options);
		}
		catch (e) {
			let movedUnderUs = e instanceof ZoteroGitHubSync.GitHubError
				&& (e.status === 422 || e.status === 409);
			if (!movedUnderUs) {
				throw e;
			}
			ZoteroGitHubSync.log('Branch moved during sync; retrying against the new head');
			return this._runSync(options);
		}
	},


	async _runSync({ config, token, items, progress, trigger }) {
		let prefix = config.basePath ? `${config.basePath}/` : '';

		progress?.changeHeadline(ZoteroGitHubSync.getString('progress.collecting'));
		let files = await ZoteroGitHubSync.Exporter.build({
			config,
			items,
			onProgress: msg => progress?.addDescription(msg),
		});

		// The path list is what makes pruning safe, so it is only written (and
		// only trusted) on a full sync
		let isFullSync = !items;
		if (isFullSync) {
			files.set(this.FILE_LIST_PATH, {
				bytes: ZoteroGitHubSync.Utils.encode(
					ZoteroGitHubSync.Exporter.stableStringify([...files.keys()].sort()) + '\n'
				),
			});
		}

		let client = new ZoteroGitHubSync.GitHub({
			token,
			apiURL: config.apiURL,
			owner: config.owner,
			repo: config.repo,
		});

		await this._ensureRepo(client, config);

		progress?.changeHeadline(ZoteroGitHubSync.getString('progress.comparing'));
		let head = await this._resolveHead(client, config);
		let baseTreeSha = null;
		let remoteFiles = new Map();
		if (head) {
			let commit = await client.getCommit(head);
			baseTreeSha = commit.tree.sha;
			remoteFiles = await client.listTree(baseTreeSha);
		}

		// What changed
		let uploads = [];
		let updatedCount = 0;
		for (let [relPath, file] of files) {
			let fullPath = prefix + relPath;
			let sha = await ZoteroGitHubSync.Utils.gitBlobSha(file.bytes);
			let remote = remoteFiles.get(fullPath);
			if (remote?.sha === sha) {
				continue;
			}
			if (remote) {
				updatedCount++;
			}
			uploads.push({ fullPath, bytes: file.bytes });
		}
		let addedCount = uploads.length - updatedCount;

		// What went away
		let deletions = [];
		if (isFullSync && config.prune) {
			let previous = await this._readPreviousFileList(client, remoteFiles, prefix);
			for (let relPath of previous) {
				if (files.has(relPath)) {
					continue;
				}
				let fullPath = prefix + relPath;
				if (remoteFiles.has(fullPath)) {
					deletions.push(fullPath);
				}
			}
		}

		if (!uploads.length && !deletions.length) {
			return { status: 'up-to-date', added: 0, updated: 0, deleted: 0, commit: null };
		}

		progress?.changeHeadline(ZoteroGitHubSync.getString('progress.uploading', String(uploads.length)));
		let blobs = await ZoteroGitHubSync.Utils.pMap(
			uploads,
			async (upload) => ({
				path: upload.fullPath,
				sha: await client.createBlob(ZoteroGitHubSync.Utils.toBase64(upload.bytes)),
			}),
			this.BLOB_CONCURRENCY
		);

		progress?.changeHeadline(ZoteroGitHubSync.getString('progress.committing'));
		let entries = [
			...blobs.map(blob => ({ path: blob.path, mode: '100644', type: 'blob', sha: blob.sha })),
			...deletions.map(path => ({ path, mode: '100644', type: 'blob', sha: null })),
		];

		let treeSha = baseTreeSha;
		for (let i = 0; i < entries.length; i += this.TREE_CHUNK_SIZE) {
			let chunk = entries.slice(i, i + this.TREE_CHUNK_SIZE);
			treeSha = await client.createTree(chunk, treeSha);
		}

		let message = this._commitMessage({
			config,
			trigger,
			added: addedCount,
			updated: updatedCount,
			deleted: deletions.length,
		});
		let commitSha = await client.createCommit({
			message,
			tree: treeSha,
			parents: head ? [head] : [],
			author: { name: config.authorName, email: config.authorEmail },
		});

		if (head) {
			await client.updateRef(config.branch, commitSha);
		}
		else {
			await client.createRef(config.branch, commitSha);
		}

		return {
			status: 'committed',
			added: addedCount,
			updated: updatedCount,
			deleted: deletions.length,
			commit: commitSha,
		};
	},


	async _ensureRepo(client, config) {
		let repo = await client.getRepo();
		if (repo) {
			return repo;
		}
		if (!config.autoCreateRepo) {
			throw new ZoteroGitHubSync.GitHubError(
				`Repository ${config.owner}/${config.repo} was not found, and automatic `
				+ 'creation is turned off.',
				{ status: 404 }
			);
		}
		ZoteroGitHubSync.log(`Creating ${config.owner}/${config.repo}`);
		return client.createRepo({ isPrivate: config.repoPrivate });
	},


	/**
	 * @return {Promise<String|null>} Head commit of the target branch, creating
	 * 		the branch from the default branch if it doesn't exist yet
	 */
	async _resolveHead(client, config) {
		let head = await client.getBranchHead(config.branch);
		if (head) {
			return head;
		}
		let repo = await client.getRepo();
		if (repo?.default_branch && repo.default_branch !== config.branch) {
			let defaultHead = await client.getBranchHead(repo.default_branch);
			if (defaultHead) {
				ZoteroGitHubSync.log(`Creating branch ${config.branch} from ${repo.default_branch}`);
				await client.createRef(config.branch, defaultHead);
				return defaultHead;
			}
		}
		// Empty repository: the first commit will have no parent
		return null;
	},


	/**
	 * @return {Promise<String[]>} Repository-relative paths written by the last
	 * 		full sync, or [] if this repository has never been synced
	 */
	async _readPreviousFileList(client, remoteFiles, prefix) {
		let entry = remoteFiles.get(prefix + this.FILE_LIST_PATH);
		if (!entry) {
			return [];
		}
		try {
			let bytes = await client.getBlobBytes(entry.sha);
			let parsed = JSON.parse(ZoteroGitHubSync.Utils.textDecoder.decode(bytes));
			return Array.isArray(parsed) ? parsed.filter(p => typeof p === 'string') : [];
		}
		catch (e) {
			// Without a readable list we can't tell our files from anyone else's,
			// so skip pruning rather than guess
			ZoteroGitHubSync.logError(e);
			return [];
		}
	},


	_commitMessage({ config, trigger, added, updated, deleted }) {
		let changes = [
			added ? `${added} added` : null,
			updated ? `${updated} updated` : null,
			deleted ? `${deleted} removed` : null,
		].filter(Boolean).join(', ') || 'no changes';

		return (config.commitMessage || 'Zotero sync: {changes} ({date})')
			.replace(/\{changes\}/g, changes)
			.replace(/\{added\}/g, String(added))
			.replace(/\{updated\}/g, String(updated))
			.replace(/\{deleted\}/g, String(deleted))
			.replace(/\{trigger\}/g, trigger)
			.replace(/\{date\}/g, ZoteroGitHubSync.Utils.isoDate());
	},


	// -- Import ------------------------------------------------------------

	/**
	 * @param {Object} [options]
	 * @param {Boolean} [options.confirm=true] - Ask before touching the library
	 * @return {Promise<Object>}
	 */
	async pull({ confirm = true } = {}) {
		if (this._running) {
			this._showError(new Error(ZoteroGitHubSync.getString('error.running')));
			return { status: 'busy' };
		}
		let config = ZoteroGitHubSync.Prefs.getConfig();
		let token = await ZoteroGitHubSync.Prefs.getToken();
		if (!config.owner || !config.repo || !token) {
			this._showError(new Error(ZoteroGitHubSync.getString('error.notConfigured')));
			return { status: 'not-configured' };
		}

		if (confirm) {
			let win = Zotero.getMainWindow();
			let accepted = Services.prompt.confirm(
				win,
				ZoteroGitHubSync.getString('confirm.pullTitle'),
				ZoteroGitHubSync.getString('confirm.pullBody', `${config.owner}/${config.repo}`)
			);
			if (!accepted) {
				return { status: 'cancelled' };
			}
		}

		this._running = true;
		this._setStatus('syncing');
		this._suppressChangeTrigger = true;
		let progress = this._openProgress();
		progress?.changeHeadline(ZoteroGitHubSync.getString('progress.importing'));

		try {
			let result = await ZoteroGitHubSync.Importer.run({
				config,
				token,
				onProgress: msg => progress?.addDescription(msg),
			});
			this._setStatus('idle');
			if (progress) {
				progress.changeHeadline(ZoteroGitHubSync.getString(
					'progress.imported',
					String(result.created),
					String(result.updated)
				));
				progress.startCloseTimer(5000);
			}
			return result;
		}
		catch (e) {
			ZoteroGitHubSync.logError(e);
			this._setStatus('error');
			progress?.close();
			this._showError(e);
			return { status: 'error', error: e.message || String(e) };
		}
		finally {
			this._running = false;
			this._suppressChangeTrigger = false;
		}
	},


	// -- Feedback ----------------------------------------------------------

	_openProgress() {
		try {
			let progress = new Zotero.ProgressWindow({ closeOnClick: true });
			progress.changeHeadline(ZoteroGitHubSync.getString('progress.headline'));
			progress.show();
			return progress;
		}
		catch (e) {
			ZoteroGitHubSync.logError(e);
			return null;
		}
	},


	/**
	 * @param {Error} error
	 * @param {Object} [options]
	 * @param {Boolean} [options.silent] - Use a passive notification instead of a dialog
	 */
	_showError(error, { silent = false } = {}) {
		let message = error?.message || String(error);
		try {
			if (silent) {
				let progress = new Zotero.ProgressWindow({ closeOnClick: true });
				progress.changeHeadline(ZoteroGitHubSync.getString('progress.failed'));
				progress.addDescription(message);
				progress.show();
				progress.startCloseTimer(8000);
				return;
			}
			Zotero.alert(Zotero.getMainWindow(), ZoteroGitHubSync.getString('progress.headline'), message);
		}
		catch (e) {
			ZoteroGitHubSync.logError(e);
		}
	},
};
