/* Zotero GitHub Sync -- preference access and token storage
 *
 * Ordinary settings live on the `extensions.zotero-github-sync.` branch (see
 * prefs.js in the plugin root for the defaults). The personal access token does
 * not: it goes into the login manager, the same place Zotero keeps its own API
 * key, so it isn't sitting in prefs.js in the profile directory in plain text.
 */

ZoteroGitHubSync.Prefs = {
	LOGIN_ORIGIN: 'chrome://zotero-github-sync',
	LOGIN_REALM: 'GitHub Personal Access Token',

	_observers: [],
	_tokenCache: null,


	// -- Plain preferences -------------------------------------------------

	get(key) {
		return Zotero.Prefs.get(ZoteroGitHubSync.PREF_BRANCH + key, true);
	},


	set(key, value) {
		return Zotero.Prefs.set(ZoteroGitHubSync.PREF_BRANCH + key, value, true);
	},


	clear(key) {
		try {
			Zotero.Prefs.clear(ZoteroGitHubSync.PREF_BRANCH + key, true);
		}
		catch (e) {
			// Clearing a pref that was never set throws; nothing to do
		}
	},


	/**
	 * @param {String[]} keys
	 * @param {Function} handler - Called with no arguments when any key changes
	 */
	observe(keys, handler) {
		for (let key of keys) {
			this._observers.push(
				Zotero.Prefs.registerObserver(ZoteroGitHubSync.PREF_BRANCH + key, handler, true)
			);
		}
	},


	unobserveAll() {
		for (let symbol of this._observers) {
			Zotero.Prefs.unregisterObserver(symbol);
		}
		this._observers = [];
	},


	/**
	 * Reserved for renaming preferences in later versions without losing the
	 * user's settings.
	 */
	migrate() {},


	// -- Derived configuration ---------------------------------------------

	/**
	 * @return {Object} Everything the sync engine needs, already normalized
	 */
	getConfig() {
		return {
			apiURL: (this.get('apiURL') || 'https://api.github.com').replace(/\/+$/, ''),
			owner: (this.get('owner') || '').trim(),
			repo: (this.get('repo') || '').trim(),
			branch: (this.get('branch') || 'main').trim(),
			basePath: ZoteroGitHubSync.Utils.normalizeBasePath(this.get('basePath')),
			autoCreateRepo: !!this.get('autoCreateRepo'),
			repoPrivate: !!this.get('repoPrivate'),

			includeGroupLibraries: !!this.get('includeGroupLibraries'),
			exportJSON: !!this.get('exportJSON'),
			exportMarkdown: !!this.get('exportMarkdown'),
			exportBibTeX: !!this.get('exportBibTeX'),
			exportIndex: !!this.get('exportIndex'),
			includeNotes: !!this.get('includeNotes'),
			includeAttachments: !!this.get('includeAttachments'),
			maxAttachmentBytes: Math.max(0, Number(this.get('maxAttachmentMB')) || 0) * 1024 * 1024,
			prune: !!this.get('prune'),

			intervalEnabled: !!this.get('intervalEnabled'),
			intervalMinutes: Math.max(5, Number(this.get('intervalMinutes')) || 60),
			syncOnChange: !!this.get('syncOnChange'),
			changeDelayMinutes: Math.max(1, Number(this.get('changeDelayMinutes')) || 5),
			syncOnStartup: !!this.get('syncOnStartup'),

			commitMessage: this.get('commitMessage') || 'Zotero sync: {changes} ({date})',
			authorName: (this.get('authorName') || '').trim(),
			authorEmail: (this.get('authorEmail') || '').trim(),
		};
	},


	/**
	 * The repository coordinates are enough to attempt a sync; the token is
	 * checked separately because reading it is async.
	 *
	 * @return {Boolean}
	 */
	hasRepoConfig() {
		let config = this.getConfig();
		return !!(config.owner && config.repo && config.branch);
	},


	/**
	 * @return {Promise<Boolean>}
	 */
	async isConfigured() {
		return this.hasRepoConfig() && !!(await this.getToken());
	},


	/**
	 * @return {String} Browser URL of the configured repository, or ''
	 */
	getRepoURL() {
		let config = this.getConfig();
		if (!config.owner || !config.repo) {
			return '';
		}
		// api.github.com -> github.com; a GitHub Enterprise API URL looks like
		// https://ghe.example.com/api/v3, whose web root is the host
		let host = 'https://github.com';
		try {
			let url = new URL(config.apiURL);
			if (url.hostname !== 'api.github.com') {
				host = `${url.protocol}//${url.host}`;
			}
		}
		catch (e) {
			ZoteroGitHubSync.logError(e);
		}
		return `${host}/${config.owner}/${config.repo}/tree/${config.branch}`;
	},


	// -- Token -------------------------------------------------------------

	/**
	 * @return {Promise<String>} The stored token, or '' if there is none
	 */
	async getToken() {
		if (this._tokenCache !== null) {
			return this._tokenCache;
		}
		let login = await this._findLogin();
		this._tokenCache = login ? login.password : '';
		return this._tokenCache;
	},


	/**
	 * @param {String} token - Pass '' to remove the stored token
	 */
	async setToken(token) {
		token = (token || '').trim();
		let existing = await this._findLogin();

		if (!token) {
			if (existing) {
				await Services.logins.removeLoginAsync(existing);
			}
			this._tokenCache = '';
			return;
		}

		let nsLoginInfo = new Components.Constructor(
			'@mozilla.org/login-manager/loginInfo;1',
			Components.interfaces.nsILoginInfo,
			'init'
		);
		let loginInfo = new nsLoginInfo(
			this.LOGIN_ORIGIN,
			null,
			this.LOGIN_REALM,
			'token',
			token,
			'',
			''
		);
		if (existing) {
			await Services.logins.modifyLoginAsync(existing, loginInfo);
		}
		else {
			await Services.logins.addLoginAsync(loginInfo);
		}
		this._tokenCache = token;
	},


	async _findLogin() {
		try {
			let logins = await Services.logins.searchLoginsAsync({
				origin: this.LOGIN_ORIGIN,
				httpRealm: this.LOGIN_REALM,
			});
			return logins.length ? logins[0] : null;
		}
		catch (e) {
			ZoteroGitHubSync.logError(e);
			return null;
		}
	},
};
