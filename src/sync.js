/* Zotero GitHub Sync -- orchestration and scheduling
 *
 * One sync is: export the library to files, compare their Git blob hashes with
 * what the branch already contains, and upload only what changed.
 *
 * GitHub allows about 80 content-creating requests a minute, so uploads are
 * batched. Text files (item JSON, Markdown, LFS pointers) go up inside tree
 * requests, hundreds per request. Attachment files each need a blob request,
 * paced below the limit, and are committed in checkpoints: a first sync of a
 * large library that is cancelled or fails keeps everything already committed,
 * and the next sync carries on from there.
 *
 * Deletions are driven by `.zotero-sync/files.json`, a sorted list of the paths
 * this plugin wrote last time. Pruning only ever touches paths on that list, so
 * pointing the plugin at a repository root can never delete files that belong to
 * something else. The list and the deletions land in the final commit only.
 */

ZoteroGitHubSync.Sync = {
	FILE_LIST_PATH: '.zotero-sync/files.json',
	BLOB_CONCURRENCY: 3,
	STARTUP_DELAY_MS: 60 * 1000,

	// Tree requests carrying inline text: stay well inside request size limits
	TREE_MAX_ENTRIES: 300,
	TREE_MAX_BYTES: 3 * 1024 * 1024,
	// Text files larger than this go up as blobs instead of inline
	INLINE_MAX_BYTES: 1024 * 1024,
	// Blobs at or above this size upload one at a time
	LARGE_BLOB_BYTES: 8 * 1024 * 1024,
	// Commit a checkpoint once this much has been uploaded since the last one
	CHECKPOINT_BYTES: 100 * 1024 * 1024,
	CHECKPOINT_FILES: 150,
	CHECKPOINT_MS: 5 * 60 * 1000,

	status: 'idle',
	lastResult: null,
	progress: null,

	_running: false,
	_cancel: null,
	_intervalTimer: null,
	_changeTimer: null,
	_startupTimer: null,
	_notifierID: null,
	_zoteroSyncNotifierID: null,
	_suppressChangeTrigger: false,
	_progressWindow: null,
	// Shared by every sync, since GitHub's limit is per account, not per sync
	_limiter: null,


	// -- Lifecycle ---------------------------------------------------------

	init() {
		this._limiter = new ZoteroGitHubSync.RateLimiter([{ ms: 60 * 1000, max: 70 }]);
		ZoteroGitHubSync.Prefs.observe(
			['intervalEnabled', 'intervalMinutes', 'syncOnChange', 'changeDelayMinutes'],
			() => this.updateSchedule()
		);
		this.updateSchedule();

		// Zotero announces the end of its own sync; follow it with ours if asked
		this._zoteroSyncNotifierID = Zotero.Notifier.registerObserver(
			{
				notify: (event, type) => {
					if (type !== 'sync' || event !== 'finish') {
						return;
					}
					if (!ZoteroGitHubSync.Prefs.getConfig().syncAfterZoteroSync || this._running) {
						return;
					}
					this.syncNow({ trigger: 'zotero-sync', silent: true }).catch(e => ZoteroGitHubSync.logError(e));
				},
			},
			['sync'],
			'zotero-github-sync-after-zotero-sync'
		);

		if (ZoteroGitHubSync.Prefs.getConfig().syncOnStartup) {
			this._startupTimer = setTimeout(() => {
				this._startupTimer = null;
				this.syncNow({ trigger: 'startup', silent: true }).catch(e => ZoteroGitHubSync.logError(e));
			}, this.STARTUP_DELAY_MS);
		}
	},


	shutdown() {
		this.cancel();
		this._clearTimer('_intervalTimer', true);
		this._clearTimer('_changeTimer');
		this._clearTimer('_startupTimer');
		for (let name of ['_notifierID', '_zoteroSyncNotifierID']) {
			if (this[name]) {
				Zotero.Notifier.unregisterObserver(this[name]);
				this[name] = null;
			}
		}
		this._progressWindow?.close();
		this._progressWindow = null;
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
				['item', 'collection', 'collection-item', 'item-tag', 'search', 'setting'],
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
		if (!['add', 'modify', 'delete', 'trash', 'remove'].includes(event) || !ids?.length) {
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


	// -- Status and progress -----------------------------------------------

	get isRunning() {
		return this._running;
	},


	_setStatus(status) {
		this.status = status;
		this._notifyUI();
	},


	/**
	 * @param {Object} update - Merged into `this.progress`: {
	 * 		phase: collecting | hashing | uploading-lfs | uploading | committing | importing,
	 * 		done, total (files), bytesDone, bytesTotal, waitUntil (ms epoch or null)
	 * 	}
	 */
	_updateProgress(update) {
		this.progress = { ...(this.progress || {}), waitUntil: null, ...update };
		this._notifyUI();
	},


	_notifyUI() {
		try {
			ZoteroGitHubSync.UI.onStatusChange(this.status, this.progress);
		}
		catch (e) {
			ZoteroGitHubSync.logError(e);
		}
		this._renderProgressWindow();
	},


	/**
	 * @return {Number|null} 0-100, or null while there's nothing to measure yet
	 */
	percent(progress = this.progress) {
		if (!progress) {
			return null;
		}
		if (progress.bytesTotal) {
			return Math.min(100, Math.floor((progress.bytesDone / progress.bytesTotal) * 100));
		}
		if (progress.total) {
			return Math.min(100, Math.floor((progress.done / progress.total) * 100));
		}
		return null;
	},


	/**
	 * @return {String} One line describing what the sync is doing right now
	 */
	describeProgress(progress = this.progress) {
		if (!progress) {
			return '';
		}
		let Utils = ZoteroGitHubSync.Utils;
		let get = (key, ...args) => ZoteroGitHubSync.getString(key, ...args);
		let line;
		switch (progress.phase) {
			case 'hashing':
				line = get('progress.hashing', String(progress.done || 0), String(progress.total || 0));
				break;
			case 'uploading-lfs':
				line = get('progress.uploadingLFSCount', String(progress.done || 0), String(progress.total || 0));
				break;
			case 'uploading':
				line = get(
					'progress.uploadingCount',
					String(progress.done || 0),
					String(progress.total || 0),
					Utils.formatSize(progress.bytesDone || 0),
					Utils.formatSize(progress.bytesTotal || 0)
				);
				break;
			case 'committing':
				line = get('progress.committing');
				break;
			case 'importing':
				line = progress.message || get('progress.importing');
				break;
			default:
				line = progress.message || get('progress.collecting');
		}
		let percent = this.percent(progress);
		if (percent !== null && ['uploading', 'uploading-lfs', 'hashing'].includes(progress.phase)) {
			line += ` — ${percent}%`;
		}
		if (progress.waitUntil && progress.waitUntil > Date.now()) {
			let time = new Date(progress.waitUntil).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
			line += `\n${get('progress.waitingRateLimit', time)}`;
		}
		return line;
	},


	/**
	 * Stop the running sync at the next safe point. Files already committed stay
	 * committed.
	 */
	cancel() {
		if (this._cancel && !this._cancel.cancelled) {
			ZoteroGitHubSync.log('Cancelling sync');
			this._cancel.cancel();
			this._updateProgress({ message: ZoteroGitHubSync.getString('progress.cancelling') });
		}
	},


	// -- Sync --------------------------------------------------------------

	/**
	 * @param {Object} [options]
	 * @param {String} [options.trigger='manual'] - manual | button | interval | change | startup | zotero-sync
	 * @param {Zotero.Item[]} [options.items] - Sync only these items
	 * @param {Boolean} [options.silent] - Don't open a progress window
	 * @return {Promise<Object>} { status, added, updated, deleted, commit, warnings }
	 */
	async syncNow({ trigger = 'manual', items = null, silent = false } = {}) {
		if (this._running) {
			if (!silent) {
				// Already visible on the toolbar button; reopen the window rather
				// than raising an alert
				this._openProgressWindow();
			}
			return { status: 'busy' };
		}

		let config = ZoteroGitHubSync.Prefs.getConfig();
		let token = await ZoteroGitHubSync.Prefs.getToken();
		if (!config.owner || !config.repo || !token) {
			if (!silent) {
				this._notify(ZoteroGitHubSync.getString('error.notConfigured'), { error: true });
			}
			return { status: 'not-configured' };
		}
		if (items && !items.length) {
			if (!silent) {
				this._notify(ZoteroGitHubSync.getString('error.noItems'), { error: true });
			}
			return { status: 'no-items' };
		}

		this._running = true;
		this._cancel = new ZoteroGitHubSync.CancelToken();
		this.progress = null;
		this._setStatus('syncing');
		this._updateProgress({ phase: 'collecting' });
		if (!silent) {
			this._openProgressWindow();
		}

		try {
			let result = await this._runSyncWithRetry({ config, token, items, trigger });
			ZoteroGitHubSync.Prefs.set('lastSync', ZoteroGitHubSync.Utils.isoDate());
			ZoteroGitHubSync.Prefs.set('lastError', '');
			ZoteroGitHubSync.Prefs.set('lastWarnings', this._formatWarnings(result.warnings));
			if (result.warnings?.length) {
				result.warnings.forEach(w => ZoteroGitHubSync.warn(w));
			}
			if (result.commit) {
				ZoteroGitHubSync.Prefs.set('lastCommit', result.commit);
			}
			this.lastResult = result;
			this.progress = null;
			this._setStatus('idle');

			let summary = result.status === 'up-to-date'
				? ZoteroGitHubSync.getString('progress.upToDate')
				: ZoteroGitHubSync.getString(
					'progress.done',
					String(result.added + result.updated + result.deleted),
					`${config.owner}/${config.repo}`
				);
			if (result.warnings?.length) {
				summary += `\n${ZoteroGitHubSync.getString('progress.warnings', String(result.warnings.length))}`;
			}
			this._finishProgressWindow(summary);
			return result;
		}
		catch (e) {
			this.progress = null;
			if (e instanceof ZoteroGitHubSync.CancelledError) {
				ZoteroGitHubSync.log('Sync cancelled');
				this._setStatus('idle');
				this._finishProgressWindow(ZoteroGitHubSync.getString('progress.cancelled'));
				return { status: 'cancelled' };
			}
			ZoteroGitHubSync.logError(e);
			ZoteroGitHubSync.Prefs.set('lastError', e.message || String(e));
			this._setStatus('error');
			this._progressWindow?.close();
			this._progressWindow = null;
			// Never a modal alert: a dialog the window manager draws badly can
			// lock the whole application. The toolbar button turns red too.
			this._notify(e.message || String(e), { error: true });
			return { status: 'error', error: e.message || String(e) };
		}
		finally {
			this._running = false;
			this._cancel = null;
		}
	},


	/**
	 * If the branch moved while we were building a commit -- another machine
	 * synced, or someone pushed -- GitHub refuses the non-fast-forward ref
	 * update. Redoing the sync against the new head is the correct response, and
	 * it is cheap: everything already committed is skipped.
	 */
	async _runSyncWithRetry(options) {
		try {
			return await this._runSync(options);
		}
		catch (e) {
			if (!e.branchMoved) {
				throw e;
			}
			ZoteroGitHubSync.log('Branch moved during sync; retrying against the new head');
			return this._runSync(options);
		}
	},


	async _runSync({ config, token, items, trigger }) {
		let prefix = config.basePath ? `${config.basePath}/` : '';
		let Files = ZoteroGitHubSync.Files;
		let Utils = ZoteroGitHubSync.Utils;
		let cancel = this._cancel;

		let { files, keepPrefixes, warnings } = await ZoteroGitHubSync.Exporter.build({
			config,
			items,
			onProgress: message => this._updateProgress({ phase: 'collecting', message }),
		});
		cancel.throwIfCancelled();

		let client = new ZoteroGitHubSync.GitHub({
			token,
			apiURL: config.apiURL,
			owner: config.owner,
			repo: config.repo,
			limiter: this._limiter,
			cancel,
			onWait: waitUntil => this._updateProgress({ waitUntil }),
		});

		await this._ensureRepo(client, config);

		this._updateProgress({ phase: 'collecting', message: ZoteroGitHubSync.getString('progress.comparing') });
		let head = await this._resolveHead(client, config);
		let branchExists = !!head;
		let baseTreeSha = null;
		let remoteFiles = new Map();
		if (head) {
			let commit = await client.getCommit(head);
			baseTreeSha = commit.tree.sha;
			remoteFiles = await client.listTree(baseTreeSha);
		}

		// Attachments whose files exist in the library but not on this computer:
		// whatever an earlier sync uploaded for them stays, untouched
		let kept = new Set();
		if (keepPrefixes.length) {
			for (let fullPath of remoteFiles.keys()) {
				if (!fullPath.startsWith(prefix)) {
					continue;
				}
				let relPath = fullPath.slice(prefix.length);
				if (!files.has(relPath) && keepPrefixes.some(p => relPath.startsWith(p))) {
					kept.add(relPath);
				}
			}
		}

		// The path list is what makes pruning safe, so it is only written (and
		// only trusted) on a full sync. It goes in the final commit, after
		// everything it lists.
		let isFullSync = !items;
		let fileList = null;
		if (isFullSync) {
			let managed = [...new Set([...files.keys(), ...kept])].sort();
			fileList = {
				fullPath: prefix + this.FILE_LIST_PATH,
				bytes: Utils.encode(ZoteroGitHubSync.Exporter.stableStringify(managed) + '\n'),
			};
		}

		// What changed. Attachment files are hashed from disk, or taken from the
		// hash cache when their size and modification time haven't moved.
		let texts = [];
		let blobs = [];
		let lfsObjects = [];
		let reused = [];
		let updatedCount = 0;
		let sourceCount = [...files.values()].filter(f => f.source).length;
		let hashed = 0;
		let remoteShas = new Set([...remoteFiles.values()].map(entry => entry.sha));

		this._updateProgress({ phase: 'hashing', done: 0, total: sourceCount, bytesDone: 0, bytesTotal: 0 });
		await Files.loadCache();
		try {
			let check = async (fullPath, file) => {
				let sha;
				let upload = { fullPath };
				if (file.source) {
					cancel.throwIfCancelled();
					if (file.lfs) {
						let oid = await Files.cachedHash(file.source, 'lfs');
						upload.bytes = Utils.encode(Utils.lfsPointer(oid, file.source.size));
						upload.lfs = { oid, size: file.source.size, path: file.source.path };
						sha = await Utils.gitBlobSha(upload.bytes);
					}
					else {
						sha = await Files.cachedHash(file.source, 'git');
						upload.source = file.source;
					}
					hashed++;
					if (hashed % 10 === 0 || hashed === sourceCount) {
						this._updateProgress({ phase: 'hashing', done: hashed, total: sourceCount });
					}
				}
				else {
					upload.bytes = file.bytes;
					sha = await Utils.gitBlobSha(file.bytes);
				}
				upload.sha = sha;

				let remote = remoteFiles.get(fullPath);
				if (remote?.sha === sha) {
					return;
				}
				if (remote) {
					updatedCount++;
				}
				if (remoteShas.has(sha)) {
					// Same content already in the repository under another path
					// (a renamed note, a moved attachment): no need to send it again
					reused.push({ path: fullPath, sha });
					return;
				}
				if (upload.lfs) {
					lfsObjects.push(upload.lfs);
				}
				if (upload.bytes && upload.bytes.length <= this.INLINE_MAX_BYTES) {
					texts.push(upload);
				}
				else {
					blobs.push(upload);
				}
			};
			for (let [relPath, file] of files) {
				await check(prefix + relPath, file);
			}
			if (fileList) {
				// Checked like any file, but held back for the final commit
				let before = texts.length + blobs.length + reused.length;
				await check(fileList.fullPath, fileList);
				let changed = texts.length + blobs.length + reused.length > before;
				fileList.changed = changed;
				if (changed) {
					texts = texts.filter(t => t.fullPath !== fileList.fullPath);
					blobs = blobs.filter(b => b.fullPath !== fileList.fullPath);
					reused = reused.filter(r => r.path !== fileList.fullPath);
					fileList.sha = await Utils.gitBlobSha(fileList.bytes);
				}
			}
			if (isFullSync) {
				Files.retainCache(new Set(
					[...files.values()].filter(f => f.source).map(f => f.source.path)
				));
			}
		}
		finally {
			await Files.saveCache();
		}

		// What went away
		let deletions = [];
		if (isFullSync && config.prune) {
			let previous = await this._readPreviousFileList(client, remoteFiles, prefix);
			for (let relPath of previous) {
				if (files.has(relPath) || kept.has(relPath)) {
					continue;
				}
				let fullPath = prefix + relPath;
				if (remoteFiles.has(fullPath)) {
					deletions.push(fullPath);
				}
			}
		}

		let changedFiles = texts.length + blobs.length + reused.length + (fileList?.changed ? 1 : 0);
		if (!changedFiles && !deletions.length) {
			return { status: 'up-to-date', added: 0, updated: 0, deleted: 0, commit: null, warnings };
		}
		let addedCount = texts.length + blobs.length + reused.length - updatedCount;

		// LFS objects go up before any pointer is committed, so the branch never
		// references a file LFS doesn't have
		if (lfsObjects.length) {
			this._updateProgress({ phase: 'uploading-lfs', done: 0, total: lfsObjects.length, bytesDone: 0, bytesTotal: 0 });
			let lfs = await this._lfsClient(client, config, token);
			await lfs.uploadAll(lfsObjects, {
				ref: `refs/heads/${config.branch}`,
				cancel,
				onProgress: (done, total) => this._updateProgress({ phase: 'uploading-lfs', done, total }),
			});
		}

		// -- Upload and commit in checkpoints --------------------------------

		let size = u => (u.source ? u.source.size : u.bytes.length);
		let totalFiles = texts.length + blobs.length + reused.length;
		let totalBytes = [...texts, ...blobs].reduce((sum, u) => sum + size(u), 0);
		let doneFiles = 0;
		let doneBytes = 0;
		let showUpload = () => this._updateProgress({
			phase: 'uploading',
			done: doneFiles,
			total: totalFiles,
			bytesDone: doneBytes,
			bytesTotal: totalBytes,
		});
		showUpload();

		let treeSha = baseTreeSha;
		let pending = [];
		let pendingBytes = 0;
		let lastCheckpoint = Date.now();
		let commitSha = null;
		let checkpoints = 0;

		// Build trees from pending entries, commit, and move the branch
		let commit = async (message) => {
			if (!pending.length) {
				return;
			}
			this._updateProgress({ phase: 'committing' });
			for (let chunk of this._chunkEntries(pending)) {
				treeSha = await client.createTree(chunk, treeSha);
			}
			commitSha = await client.createCommit({
				message,
				tree: treeSha,
				parents: head ? [head] : [],
				author: { name: config.authorName, email: config.authorEmail },
			});
			try {
				if (branchExists) {
					await client.updateRef(config.branch, commitSha);
				}
				else {
					await client.createRef(config.branch, commitSha);
					branchExists = true;
				}
			}
			catch (e) {
				// Only a refused ref update means someone else pushed in the
				// meantime; any other 409/422 is a real error
				if (e instanceof ZoteroGitHubSync.GitHubError && (e.status === 422 || e.status === 409)) {
					e.branchMoved = true;
				}
				throw e;
			}
			head = commitSha;
			pending = [];
			pendingBytes = 0;
			lastCheckpoint = Date.now();
			showUpload();
		};
		let checkpointMessage = () => {
			checkpoints++;
			return `Zotero sync: checkpoint ${checkpoints} (${doneFiles}/${totalFiles} files, `
				+ `${Utils.formatSize(doneBytes)}/${Utils.formatSize(totalBytes)})`;
		};

		// Text first: the whole library's metadata and notes become visible on
		// GitHub within a minute, before any PDF has gone up
		for (let upload of texts) {
			pending.push({
				path: upload.fullPath,
				mode: '100644',
				type: 'blob',
				content: Utils.textDecoder.decode(upload.bytes),
				size: upload.bytes.length,
			});
		}
		for (let entry of reused) {
			pending.push({ path: entry.path, mode: '100644', type: 'blob', sha: entry.sha });
		}
		doneFiles += texts.length + reused.length;
		doneBytes += texts.reduce((sum, u) => sum + size(u), 0);
		if (blobs.length && pending.length > this.TREE_MAX_ENTRIES) {
			await commit(checkpointMessage());
		}
		else {
			showUpload();
		}

		// Then files, paced, in checkpoints
		let uploadBlob = async (upload) => {
			cancel.throwIfCancelled();
			let bytes = upload.bytes;
			if (upload.source) {
				bytes = await IOUtils.read(upload.source.path);
				if (bytes.length !== upload.source.size) {
					throw new Error(`${upload.source.path} changed during sync; sync again`);
				}
			}
			let sha = await client.createBlob(Utils.toBase64(bytes));
			bytes = null;
			// GitHub hashes what it received; a mismatch means the local hash,
			// the cache or the transfer is wrong, and committing would be worse
			if (sha !== upload.sha) {
				throw new Error(`Upload of ${upload.fullPath} arrived corrupted (expected ${upload.sha}, got ${sha})`);
			}
			pending.push({ path: upload.fullPath, mode: '100644', type: 'blob', sha });
			pendingBytes += size(upload);
			doneFiles++;
			doneBytes += size(upload);
			showUpload();
		};
		let dueForCheckpoint = () => pendingBytes >= this.CHECKPOINT_BYTES
			|| pending.length >= this.CHECKPOINT_FILES
			|| (pending.length && Date.now() - lastCheckpoint >= this.CHECKPOINT_MS);

		let small = blobs.filter(u => size(u) < this.LARGE_BLOB_BYTES);
		let large = blobs.filter(u => size(u) >= this.LARGE_BLOB_BYTES);
		for (let i = 0; i < small.length; i += this.CHECKPOINT_FILES) {
			await Utils.pMap(small.slice(i, i + this.CHECKPOINT_FILES), uploadBlob, this.BLOB_CONCURRENCY);
			if (dueForCheckpoint() && (i + this.CHECKPOINT_FILES < small.length || large.length)) {
				await commit(checkpointMessage());
			}
		}
		for (let upload of large) {
			await uploadBlob(upload);
			if (dueForCheckpoint() && upload !== large[large.length - 1]) {
				await commit(checkpointMessage());
			}
		}

		// Final commit: whatever is left, the file list, and the deletions
		cancel.throwIfCancelled();
		if (fileList?.changed) {
			pending.push({
				path: fileList.fullPath,
				mode: '100644',
				type: 'blob',
				content: Utils.textDecoder.decode(fileList.bytes),
				size: fileList.bytes.length,
			});
		}
		for (let path of deletions) {
			pending.push({ path, mode: '100644', type: 'blob', sha: null });
		}
		await commit(this._commitMessage({
			config,
			trigger,
			added: addedCount,
			updated: updatedCount,
			deleted: deletions.length,
		}));

		return {
			status: 'committed',
			added: addedCount,
			updated: updatedCount,
			deleted: deletions.length,
			commit: commitSha,
			checkpoints,
			warnings,
		};
	},


	/**
	 * Split tree entries into requests that respect both an entry count and a
	 * payload size, so a few large JSON files can't make one request huge.
	 */
	_chunkEntries(entries) {
		let chunks = [];
		let current = [];
		let bytes = 0;
		for (let { size = 0, ...entry } of entries) {
			if (current.length && (current.length >= this.TREE_MAX_ENTRIES || bytes + size > this.TREE_MAX_BYTES)) {
				chunks.push(current);
				current = [];
				bytes = 0;
			}
			current.push(entry);
			bytes += size;
		}
		if (current.length) {
			chunks.push(current);
		}
		return chunks;
	},


	async _lfsClient(client, config, token) {
		// LFS authenticates with Basic auth: any username works with a personal
		// access token, but the account's own login is the documented choice
		let user = await client.getAuthenticatedUser();
		return new ZoteroGitHubSync.GitLFS({
			url: ZoteroGitHubSync.Prefs.getLFSURL(config),
			username: user.login,
			token,
		});
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
		try {
			return await client.createRepo({ isPrivate: config.repoPrivate });
		}
		catch (e) {
			// GitHub answers 404 both for a repository that doesn't exist and for
			// one the token can't see. When creating it is refused too, the second
			// case is far more likely -- say so instead of echoing the 403.
			if (e instanceof ZoteroGitHubSync.GitHubError && (e.status === 403 || e.status === 404 || e.status === 422)) {
				throw new ZoteroGitHubSync.GitHubError(
					`This token cannot see ${config.owner}/${config.repo}. If the repository exists, `
					+ 'edit the token on GitHub: under Repository access choose this repository, and '
					+ 'under Permissions set Contents to Read and write. '
					+ `(Creating the repository instead was refused: ${e.message})`,
					{ status: e.status, url: e.url, body: e.body }
				);
			}
			throw e;
		}
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
		if (repo && await client.isEmpty()) {
			// A repository with no commits: the Git Data API won't accept a single
			// blob until one exists, so make it through the Contents API. The file
			// is one the sync rewrites anyway.
			let prefix = config.basePath ? `${config.basePath}/` : '';
			ZoteroGitHubSync.log(`${config.owner}/${config.repo} is empty; creating an initial commit`);
			let sha = await client.createInitialCommit({
				path: `${prefix}${this.FILE_LIST_PATH.replace(/files\.json$/, 'manifest.json')}`,
				text: '{}\n',
				message: 'Initialize repository for Zotero GitHub Sync',
			});
			if (repo.default_branch && repo.default_branch !== config.branch) {
				await client.createRef(config.branch, sha);
			}
			return sha;
		}
		// A branch that exists nowhere yet in a repository that has commits:
		// the first commit will have no parent
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


	/**
	 * @param {String[]} [warnings]
	 * @return {String} Newline-separated, capped so the preference stays small
	 */
	_formatWarnings(warnings) {
		const MAX = 20;
		if (!warnings?.length) {
			return '';
		}
		let lines = warnings.slice(0, MAX);
		if (warnings.length > MAX) {
			lines.push(`…and ${warnings.length - MAX} more (see Help → Debug Output Logging)`);
		}
		return lines.join('\n');
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
			this._openProgressWindow();
			return { status: 'busy' };
		}
		let config = ZoteroGitHubSync.Prefs.getConfig();
		let token = await ZoteroGitHubSync.Prefs.getToken();
		if (!config.owner || !config.repo || !token) {
			this._notify(ZoteroGitHubSync.getString('error.notConfigured'), { error: true });
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
		this._cancel = new ZoteroGitHubSync.CancelToken();
		this._suppressChangeTrigger = true;
		this.progress = null;
		this._setStatus('syncing');
		this._updateProgress({ phase: 'importing', message: ZoteroGitHubSync.getString('progress.importing') });
		this._openProgressWindow();

		try {
			let result = await ZoteroGitHubSync.Importer.run({
				config,
				token,
				cancel: this._cancel,
				onProgress: message => this._updateProgress({ phase: 'importing', message }),
			});
			ZoteroGitHubSync.Prefs.set('lastWarnings', this._formatWarnings(result.failures));
			this.progress = null;
			this._setStatus('idle');
			let summary = ZoteroGitHubSync.getString(
				'progress.imported',
				String(result.created),
				String(result.updated),
				String(result.files)
			);
			if (result.failures.length) {
				summary += `\n${ZoteroGitHubSync.getString('progress.warnings', String(result.failures.length))}`;
			}
			this._finishProgressWindow(summary);
			return result;
		}
		catch (e) {
			this.progress = null;
			if (e instanceof ZoteroGitHubSync.CancelledError) {
				this._setStatus('idle');
				this._finishProgressWindow(ZoteroGitHubSync.getString('progress.cancelled'));
				return { status: 'cancelled' };
			}
			ZoteroGitHubSync.logError(e);
			ZoteroGitHubSync.Prefs.set('lastError', e.message || String(e));
			this._setStatus('error');
			this._progressWindow?.close();
			this._progressWindow = null;
			this._notify(e.message || String(e), { error: true });
			return { status: 'error', error: e.message || String(e) };
		}
		finally {
			this._running = false;
			this._cancel = null;
			this._suppressChangeTrigger = false;
		}
	},


	// -- Feedback ----------------------------------------------------------
	//
	// Nothing here is modal. A dialog that the window manager draws at the wrong
	// size can leave Zotero unusable, and progress is always visible on the
	// toolbar button anyway.

	_openProgressWindow() {
		if (this._progressWindow) {
			return;
		}
		try {
			let win = new Zotero.ProgressWindow({ closeOnClick: false });
			win.changeHeadline(ZoteroGitHubSync.getString('progress.headline'));
			let line = new win.ItemProgress(`${ZoteroGitHubSync.rootURI}content/icons/github-20.svg`, '');
			win.show();
			this._progressWindow = win;
			this._progressLine = line;
			this._renderProgressWindow();
		}
		catch (e) {
			ZoteroGitHubSync.logError(e);
		}
	},


	_renderProgressWindow() {
		if (!this._progressWindow || !this._progressLine || !this.progress) {
			return;
		}
		try {
			this._progressLine.setText(this.describeProgress());
			let percent = this.percent();
			if (percent !== null) {
				this._progressLine.setProgress(percent);
			}
		}
		catch (e) {
			// The window was closed by the user
			this._progressWindow = null;
			this._progressLine = null;
		}
	},


	_finishProgressWindow(summary) {
		let win = this._progressWindow;
		this._progressWindow = null;
		this._progressLine = null;
		if (!win) {
			return;
		}
		try {
			win.close();
		}
		catch (e) {}
		this._notify(summary);
	},


	/**
	 * A passive notification in the corner of the window.
	 *
	 * @param {String} message
	 * @param {Object} [options]
	 * @param {Boolean} [options.error]
	 */
	_notify(message, { error = false } = {}) {
		try {
			let win = new Zotero.ProgressWindow({ closeOnClick: true });
			win.changeHeadline(ZoteroGitHubSync.getString(error ? 'progress.failed' : 'progress.headline'));
			for (let line of String(message).split('\n')) {
				win.addDescription(line);
			}
			win.show();
			win.startCloseTimer(error ? 15000 : 6000);
		}
		catch (e) {
			ZoteroGitHubSync.logError(e);
		}
	},
};
