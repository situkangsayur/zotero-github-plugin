/* Zotero GitHub Sync -- preference pane controller
 *
 * Loaded into a sandbox whose prototype is the preferences window. Inline
 * handlers in preferences.xhtml are compiled against the window itself, so the
 * controller is attached to `window` rather than declared with `var`.
 *
 * Fields carrying a `preference` attribute are wired up by Zotero; everything
 * here is for the parts it can't do: the token (which isn't a preference) and
 * the action buttons.
 */

window.ZoteroGitHubSyncPrefs = {
	_statusTimer: null,


	get plugin() {
		return Zotero.GitHubSync;
	},


	async init() {
		this._tokenStatus = document.getElementById('zgs-token-status');
		this._status = document.getElementById('zgs-status');
		this._tokenInput = document.getElementById('zgs-token');

		this._tokenInput.addEventListener('keydown', (event) => {
			if (event.key === 'Enter') {
				this.saveToken();
			}
		});

		await this.refreshTokenStatus();
		this.refreshStatus();
		// The status block shows the result of syncs started from anywhere, so
		// keep it current while the pane is open
		this._statusTimer = setInterval(() => this.refreshStatus(), 1000);
	},


	uninit() {
		if (this._statusTimer) {
			clearInterval(this._statusTimer);
			this._statusTimer = null;
		}
	},


	// -- Token -------------------------------------------------------------

	async saveToken() {
		let token = this._tokenInput.value.trim();
		if (!token) {
			this._setTokenStatus('Enter a token first.', 'error');
			return;
		}
		try {
			await this.plugin.Prefs.setToken(token);
			// Don't leave the secret sitting in the field
			this._tokenInput.value = '';
			await this.refreshTokenStatus();
			this._setTokenStatus('Token saved. Use "Test connection" to check it.', 'ok');
		}
		catch (e) {
			Zotero.logError(e);
			this._setTokenStatus(`Could not save the token: ${e.message || e}`, 'error');
		}
	},


	async clearToken() {
		try {
			await this.plugin.Prefs.setToken('');
			this._tokenInput.value = '';
			this._setTokenStatus('Token removed.', '');
		}
		catch (e) {
			Zotero.logError(e);
			this._setTokenStatus(`Could not remove the token: ${e.message || e}`, 'error');
		}
	},


	async refreshTokenStatus() {
		let token = await this.plugin.Prefs.getToken();
		this._setTokenStatus(token ? 'A token is saved.' : 'No token saved yet.', '');
	},


	async testConnection() {
		let config = this.plugin.Prefs.getConfig();
		let token = await this.plugin.Prefs.getToken();
		if (!token) {
			this._setTokenStatus('Save a token first.', 'error');
			return;
		}
		if (!config.owner || !config.repo) {
			this._setTokenStatus('Fill in the owner and repository first.', 'error');
			return;
		}

		this._setTokenStatus('Checking…', '');
		try {
			let client = new this.plugin.GitHub({
				token,
				apiURL: config.apiURL,
				owner: config.owner,
				repo: config.repo,
			});
			let user = await client.getAuthenticatedUser();
			let repo = await client.getRepo();

			if (!repo) {
				this._setTokenStatus(
					`Signed in as ${user.login}, but ${config.owner}/${config.repo} is not visible to this token. `
					+ 'If the repository already exists, the token was not given access to it: on GitHub, '
					+ 'edit the token, choose the repository under Repository access, and set Contents to '
					+ 'Read and write. '
					+ (config.autoCreateRepo
						? 'If it does not exist, the first sync will try to create it (that needs Administration: Read and write).'
						: 'Automatic creation is turned off.'),
					'error'
				);
				return;
			}
			if (!repo.permissions?.push) {
				this._setTokenStatus(
					`Signed in as ${user.login}, but the token cannot write to `
					+ `${repo.full_name}. Grant it Contents: Read and write.`,
					'error'
				);
				return;
			}
			this._setTokenStatus(
				`Signed in as ${user.login}. Write access to ${repo.full_name} `
				+ `(${repo.private ? 'private' : 'public'}), default branch ${repo.default_branch}.`,
				'ok'
			);
		}
		catch (e) {
			Zotero.logError(e);
			this._setTokenStatus(e.message || String(e), 'error');
		}
	},


	// -- Actions -----------------------------------------------------------

	syncNow() {
		this.plugin.Sync.syncNow({ trigger: 'preferences' })
			.then(() => this.refreshStatus())
			.catch(e => Zotero.logError(e));
	},


	pull() {
		this.plugin.Sync.pull()
			.then(() => this.refreshStatus())
			.catch(e => Zotero.logError(e));
	},


	cancel() {
		this.plugin.Sync.cancel();
		this.refreshStatus();
	},


	openRepo() {
		let url = this.plugin.Prefs.getRepoURL();
		if (url) {
			Zotero.launchURL(url);
		}
	},


	// -- Status ------------------------------------------------------------

	refreshStatus() {
		let prefs = this.plugin.Prefs;
		let lastSync = prefs.get('lastSync');
		let lastCommit = prefs.get('lastCommit');
		let lastError = prefs.get('lastError');
		let lastWarnings = prefs.get('lastWarnings');

		let lines = [];
		let sync = this.plugin.Sync;
		let running = sync.isRunning;
		if (running) {
			lines.push(`Syncing: ${sync.describeProgress() || '…'}`, '');
		}
		document.getElementById('zgs-cancel').hidden = !running;
		document.getElementById('zgs-sync-now').disabled = running;
		document.getElementById('zgs-pull').disabled = running;
		lines.push(lastSync ? `Last sync: ${lastSync}` : 'Never synced.');
		if (lastCommit) {
			lines.push(`Last commit: ${lastCommit.slice(0, 10)}`);
		}
		if (lastError) {
			lines.push(`Last error: ${lastError}`);
		}
		if (lastWarnings) {
			lines.push('Skipped or not restored:', ...lastWarnings.split('\n').map(line => `  ${line}`));
		}

		this._status.textContent = lines.join('\n');
		this._status.classList.toggle('zgs-error', !!lastError);
	},


	_setTokenStatus(message, kind) {
		this._tokenStatus.textContent = message;
		this._tokenStatus.classList.toggle('zgs-error', kind === 'error');
		this._tokenStatus.classList.toggle('zgs-ok', kind === 'ok');
	},
};
