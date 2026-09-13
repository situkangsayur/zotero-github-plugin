/* Zotero GitHub Sync -- what this computer last synced, per repository
 *
 * The base of the three-way comparison in planner.js: for every path, the blob
 * SHA that Zotero and the repository both held after this computer's last
 * successful sync. Kept in the profile directory, one file per repository,
 * branch and base path, because it describes this computer's view and must not
 * travel with the library.
 */

ZoteroGitHubSync.State = {
	VERSION: 1,


	_id(config) {
		let key = [config.apiURL, config.owner, config.repo, config.branch, config.basePath].join('\n');
		// FNV-1a, enough to keep distinct configurations in distinct files
		let hash = 0x811c9dc5;
		for (let i = 0; i < key.length; i++) {
			hash ^= key.charCodeAt(i);
			hash = Math.imul(hash, 0x01000193) >>> 0;
		}
		let safe = s => ZoteroGitHubSync.Utils.sanitizeSegment(s || '-', 40).replace(/\s+/g, '_');
		return `${safe(config.owner)}__${safe(config.repo)}__${safe(config.branch)}__${hash.toString(16).padStart(8, '0')}`;
	},


	path(config) {
		return PathUtils.join(Zotero.Profile.dir, 'zotero-github-sync', 'state', `${this._id(config)}.json`);
	},


	/**
	 * @return {Promise<{commit: String, base: Map<String, String>}|null>}
	 */
	async load(config) {
		let path = this.path(config);
		try {
			if (!await IOUtils.exists(path)) {
				return null;
			}
			let data = await IOUtils.readJSON(path);
			if (data?.version !== this.VERSION || !data.files) {
				return null;
			}
			return { commit: data.commit || null, base: new Map(Object.entries(data.files)) };
		}
		catch (e) {
			// Without a base the planner falls back to its cautious mode: no
			// deletions, nothing overwritten without a decision
			ZoteroGitHubSync.logError(e);
			return null;
		}
	},


	/**
	 * @param {Object} config
	 * @param {Object} state - { commit, base: Map }
	 */
	async save(config, { commit, base }) {
		let path = this.path(config);
		await IOUtils.makeDirectory(PathUtils.parent(path), { ignoreExisting: true });
		let files = {};
		for (let key of [...base.keys()].sort()) {
			files[key] = base.get(key);
		}
		await IOUtils.writeJSON(path, { version: this.VERSION, commit, files }, { tmpPath: `${path}.tmp` });
	},
};
