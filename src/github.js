/* Zotero GitHub Sync -- GitHub REST client
 *
 * Only the pieces the plugin needs: repository lookup/creation and the Git Data
 * API (blobs, trees, commits, refs). We use the Git Data API rather than the
 * Contents API because it turns a sync of N changed files into a handful of
 * requests and one atomic commit, instead of N commits and N rate-limit hits.
 */

ZoteroGitHubSync.GitHubError = class GitHubError extends Error {
	constructor(message, { status = 0, url = '', body = null, rateLimited = false } = {}) {
		super(message);
		this.name = 'GitHubError';
		this.status = status;
		this.url = url;
		this.body = body;
		this.rateLimited = rateLimited;
	}
};


ZoteroGitHubSync.GitHub = class GitHubClient {
	/**
	 * @param {Object} options
	 * @param {String} options.token - Personal access token
	 * @param {String} options.apiURL - e.g. https://api.github.com
	 * @param {String} options.owner
	 * @param {String} options.repo
	 */
	constructor({ token, apiURL, owner, repo }) {
		this.token = token;
		this.apiURL = (apiURL || 'https://api.github.com').replace(/\/+$/, '');
		this.owner = owner;
		this.repo = repo;
		this.rateLimitRemaining = null;
	}


	get repoPath() {
		return `/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}`;
	}


	/**
	 * Branch names may contain slashes ("release/2024"), which must survive
	 * encoding as path separators rather than becoming %2F.
	 *
	 * @param {String} branch
	 * @return {String}
	 */
	_encodeBranch(branch) {
		return String(branch).split('/').map(encodeURIComponent).join('/');
	}


	/**
	 * @param {String} method
	 * @param {String} path - Absolute URL or a path relative to the API root
	 * @param {Object} [options]
	 * @param {Object} [options.body] - Serialized as JSON
	 * @param {Number[]} [options.allowStatus] - Statuses to return instead of throwing
	 * @param {Number} [options.retries=2] - Retries left for rate limiting / 5xx
	 * @return {Promise<Object>} { status, data, headers }
	 */
	async request(method, path, { body, allowStatus = [], retries = 2 } = {}) {
		let url = /^https?:\/\//.test(path) ? path : this.apiURL + path;
		let headers = {
			Accept: 'application/vnd.github+json',
			'X-GitHub-Api-Version': '2022-11-28',
			Authorization: `Bearer ${this.token}`,
		};
		if (body !== undefined) {
			headers['Content-Type'] = 'application/json';
		}

		let xhr;
		try {
			xhr = await Zotero.HTTP.request(method, url, {
				headers,
				body: body === undefined ? undefined : JSON.stringify(body),
				successCodes: false,
				timeout: 120000,
				// Blob uploads are base64 payloads and tokens travel in headers;
				// keep both out of the debug log
				logBodyLength: 0,
			});
		}
		catch (e) {
			throw new ZoteroGitHubSync.GitHubError(
				`Network error contacting GitHub: ${e.message || e}`,
				{ url }
			);
		}

		let status = xhr.status;
		let remaining = xhr.getResponseHeader('x-ratelimit-remaining');
		if (remaining !== null) {
			this.rateLimitRemaining = Number(remaining);
		}

		let data = null;
		let text = xhr.responseText;
		if (text) {
			try {
				data = JSON.parse(text);
			}
			catch (e) {
				data = { raw: text };
			}
		}

		if (status >= 200 && status < 300) {
			return { status, data, xhr };
		}
		if (allowStatus.includes(status)) {
			return { status, data, xhr };
		}

		// Primary rate limit (403 with no remaining quota) and secondary rate
		// limit (403/429 with Retry-After) are both worth waiting out once
		let retryAfter = this._retryDelay(xhr, status);
		if (retryAfter !== null && retries > 0) {
			ZoteroGitHubSync.log(`Rate limited by GitHub; retrying in ${Math.round(retryAfter / 1000)}s`);
			await Zotero.Promise.delay(retryAfter);
			return this.request(method, path, { body, allowStatus, retries: retries - 1 });
		}
		if (status >= 500 && retries > 0) {
			await Zotero.Promise.delay(2000);
			return this.request(method, path, { body, allowStatus, retries: retries - 1 });
		}

		throw new ZoteroGitHubSync.GitHubError(this._errorMessage(status, data), {
			status,
			url,
			body: data,
			rateLimited: retryAfter !== null,
		});
	}


	/**
	 * @return {Number|null} Milliseconds to wait, or null if this isn't a rate limit
	 */
	_retryDelay(xhr, status) {
		const MAX_WAIT = 90 * 1000;
		if (status !== 403 && status !== 429) {
			return null;
		}
		let retryAfter = xhr.getResponseHeader('retry-after');
		if (retryAfter) {
			return Math.min(MAX_WAIT, (Number(retryAfter) || 60) * 1000);
		}
		let remaining = xhr.getResponseHeader('x-ratelimit-remaining');
		let reset = xhr.getResponseHeader('x-ratelimit-reset');
		if (remaining === '0' && reset) {
			let wait = Number(reset) * 1000 - Date.now();
			return wait > 0 && wait <= MAX_WAIT ? wait : null;
		}
		return null;
	}


	_errorMessage(status, data) {
		let detail = data?.message || '';
		if (data?.errors?.length) {
			detail += ': ' + data.errors
				.map(e => e.message || `${e.field || ''} ${e.code || ''}`.trim())
				.join('; ');
		}
		switch (status) {
			case 401:
				return 'GitHub rejected the token (401). Check that it is valid and not expired.';
			case 403:
				return `GitHub denied the request (403). ${detail || 'The token may lack the "repo"/Contents scope.'}`;
			case 404:
				return `Not found (404). ${detail || 'Check the owner, repository and branch, and that the token can see them.'}`;
			case 409:
				return `Conflict (409). ${detail || 'The repository may be empty or the branch moved.'}`;
			case 422:
				return `GitHub rejected the data (422). ${detail}`;
			default:
				return `GitHub request failed (${status}). ${detail}`;
		}
	}


	// -- Account and repository -------------------------------------------

	async getAuthenticatedUser() {
		let { data } = await this.request('GET', '/user');
		return data;
	}


	/**
	 * @return {Promise<Object|null>} Repository object, or null if it doesn't exist
	 */
	async getRepo() {
		let { status, data } = await this.request('GET', this.repoPath, { allowStatus: [404] });
		return status === 404 ? null : data;
	}


	/**
	 * Create the repository under the configured owner. If the owner isn't the
	 * authenticated user it is treated as an organization.
	 *
	 * @param {Object} options
	 * @param {Boolean} options.isPrivate
	 * @param {String} [options.description]
	 * @return {Promise<Object>}
	 */
	async createRepo({ isPrivate, description }) {
		let user = await this.getAuthenticatedUser();
		let path = user.login.toLowerCase() === this.owner.toLowerCase()
			? '/user/repos'
			: `/orgs/${encodeURIComponent(this.owner)}/repos`;
		let { data } = await this.request('POST', path, {
			body: {
				name: this.repo,
				private: !!isPrivate,
				description: description || 'Zotero library synced by Zotero GitHub Sync',
				auto_init: true,
			},
		});
		return data;
	}


	// -- Git data ----------------------------------------------------------

	/**
	 * @param {String} branch
	 * @return {Promise<String|null>} Commit SHA the branch points at, or null
	 */
	async getBranchHead(branch) {
		let { status, data } = await this.request(
			'GET',
			`${this.repoPath}/git/ref/heads/${this._encodeBranch(branch)}`,
			{ allowStatus: [404, 409] }
		);
		if (status === 404 || status === 409) {
			return null;
		}
		return data.object.sha;
	}


	async createRef(branch, sha) {
		await this.request('POST', `${this.repoPath}/git/refs`, {
			body: { ref: `refs/heads/${branch}`, sha },
		});
	}


	async updateRef(branch, sha, force = false) {
		await this.request(
			'PATCH',
			`${this.repoPath}/git/refs/heads/${this._encodeBranch(branch)}`,
			{ body: { sha, force } }
		);
	}


	async getCommit(sha) {
		let { data } = await this.request('GET', `${this.repoPath}/git/commits/${sha}`);
		return data;
	}


	/**
	 * List every blob in a tree as a Map of path -> { sha, mode, size }.
	 *
	 * The recursive endpoint truncates very large trees, in which case we walk
	 * the directories ourselves so the diff stays correct.
	 *
	 * @param {String} treeSha
	 * @return {Promise<Map<String, Object>>}
	 */
	async listTree(treeSha) {
		let files = new Map();
		let { data } = await this.request(
			'GET',
			`${this.repoPath}/git/trees/${treeSha}?recursive=1`
		);
		if (!data.truncated) {
			for (let entry of data.tree) {
				if (entry.type === 'blob') {
					files.set(entry.path, { sha: entry.sha, mode: entry.mode, size: entry.size });
				}
			}
			return files;
		}

		ZoteroGitHubSync.log('Tree listing was truncated; walking directories');
		let queue = [{ sha: treeSha, prefix: '' }];
		while (queue.length) {
			let { sha, prefix } = queue.shift();
			let { data: subtree } = await this.request('GET', `${this.repoPath}/git/trees/${sha}`);
			for (let entry of subtree.tree) {
				let path = prefix ? `${prefix}/${entry.path}` : entry.path;
				if (entry.type === 'blob') {
					files.set(path, { sha: entry.sha, mode: entry.mode, size: entry.size });
				}
				else if (entry.type === 'tree') {
					queue.push({ sha: entry.sha, prefix: path });
				}
			}
		}
		return files;
	}


	/**
	 * @param {String} base64Content
	 * @return {Promise<String>} Blob SHA
	 */
	async createBlob(base64Content) {
		let { data } = await this.request('POST', `${this.repoPath}/git/blobs`, {
			body: { content: base64Content, encoding: 'base64' },
		});
		return data.sha;
	}


	/**
	 * @param {String} sha
	 * @return {Promise<Uint8Array>}
	 */
	async getBlobBytes(sha) {
		let { data } = await this.request('GET', `${this.repoPath}/git/blobs/${sha}`);
		if (data.encoding === 'base64') {
			return ZoteroGitHubSync.Utils.fromBase64(data.content);
		}
		return ZoteroGitHubSync.Utils.encode(data.content || '');
	}


	/**
	 * @param {Object[]} entries - { path, mode, type, sha } (sha null deletes)
	 * @param {String} [baseTree]
	 * @return {Promise<String>} Tree SHA
	 */
	async createTree(entries, baseTree) {
		let body = { tree: entries };
		if (baseTree) {
			body.base_tree = baseTree;
		}
		let { data } = await this.request('POST', `${this.repoPath}/git/trees`, { body });
		return data.sha;
	}


	/**
	 * @param {Object} options
	 * @param {String} options.message
	 * @param {String} options.tree
	 * @param {String[]} options.parents
	 * @param {Object} [options.author] - { name, email }
	 * @return {Promise<String>} Commit SHA
	 */
	async createCommit({ message, tree, parents, author }) {
		let body = { message, tree, parents };
		if (author?.name && author?.email) {
			body.author = { name: author.name, email: author.email, date: new Date().toISOString() };
		}
		let { data } = await this.request('POST', `${this.repoPath}/git/commits`, { body });
		return data.sha;
	}
};
