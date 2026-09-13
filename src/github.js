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
	constructor({ token, apiURL, owner, repo, limiter = null, cancel = null, onWait = null }) {
		this.token = token;
		this.apiURL = (apiURL || 'https://api.github.com').replace(/\/+$/, '');
		this.owner = owner;
		this.repo = repo;
		this.rateLimitRemaining = null;
		// Paces requests that create content (POST/PUT/PATCH)
		this.limiter = limiter;
		this.cancel = cancel;
		// Called with the time a rate-limit wait ends, so the UI can say so
		this.onWait = onWait;
	}


	static RATE_LIMIT_RETRIES = 6;
	static MAX_RATE_LIMIT_WAIT = 15 * 60 * 1000;


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
	 * @param {String} [options.rawBody] - Already-serialized JSON, for payloads
	 * 		too large to run through JSON.stringify() a second time
	 * @param {Boolean} [options.raw] - Ask for raw content and return it as text
	 * @param {Number[]} [options.allowStatus] - Statuses to return instead of throwing
	 * @param {Number} [options.timeout] - Milliseconds
	 * @param {Number} [options.retries=2] - Retries left for rate limiting / 5xx
	 * @return {Promise<Object>} { status, data, xhr }
	 */
	async request(method, path, options = {}) {
		let {
			body, rawBody, raw = false, allowStatus = [], timeout = 120000,
			retries = 2, rateLimitRetries = GitHubClient.RATE_LIMIT_RETRIES,
		} = options;
		this.cancel?.throwIfCancelled();
		if (method !== 'GET' && this.limiter) {
			await this.limiter.acquire({ cancel: this.cancel, onWait: this.onWait });
		}
		let url = /^https?:\/\//.test(path) ? path : this.apiURL + path;
		let headers = {
			Accept: raw ? 'application/vnd.github.raw+json' : 'application/vnd.github+json',
			'X-GitHub-Api-Version': '2022-11-28',
			Authorization: `Bearer ${this.token}`,
		};
		let payload;
		if (rawBody !== undefined) {
			payload = rawBody;
		}
		else if (body !== undefined) {
			payload = JSON.stringify(body);
		}
		if (payload !== undefined) {
			headers['Content-Type'] = 'application/json';
		}

		let xhr;
		try {
			xhr = await Zotero.HTTP.request(method, url, {
				headers,
				body: payload,
				successCodes: false,
				timeout,
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
		let ok = status >= 200 && status < 300;
		if (raw && ok) {
			data = text;
		}
		else if (text) {
			try {
				data = JSON.parse(text);
			}
			catch (e) {
				data = { raw: text };
			}
		}

		if (ok || allowStatus.includes(status)) {
			return { status, data, xhr };
		}

		// Rate limits are waited out, with backoff, rather than failing a sync
		// that may already have uploaded hundreds of files
		let attempt = GitHubClient.RATE_LIMIT_RETRIES - rateLimitRetries;
		let retryAfter = this._retryDelay(xhr, status, data, attempt);
		if (retryAfter !== null && rateLimitRetries > 0) {
			ZoteroGitHubSync.log(`Rate limited by GitHub; retrying in ${Math.round(retryAfter / 1000)}s`);
			this.onWait?.(Date.now() + retryAfter);
			await this._sleep(retryAfter);
			return this.request(method, path, { ...options, rateLimitRetries: rateLimitRetries - 1 });
		}
		if (status >= 500 && retries > 0) {
			await this._sleep(2000 * (3 - retries));
			return this.request(method, path, { ...options, retries: retries - 1 });
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
	_retryDelay(xhr, status, data, attempt) {
		if (status !== 403 && status !== 429) {
			return null;
		}
		let cap = ms => Math.min(GitHubClient.MAX_RATE_LIMIT_WAIT, Math.max(1000, ms));
		let retryAfter = xhr.getResponseHeader('retry-after');
		if (retryAfter) {
			return cap((Number(retryAfter) || 60) * 1000);
		}
		let remaining = xhr.getResponseHeader('x-ratelimit-remaining');
		let reset = xhr.getResponseHeader('x-ratelimit-reset');
		if (remaining === '0' && reset) {
			return cap(Number(reset) * 1000 - Date.now() + 1000);
		}
		// A secondary rate limit without headers: GitHub asks for at least a
		// minute, with exponential backoff if it keeps happening. A 403 that
		// isn't about rate limits (a missing permission) is not retried.
		if (status === 429 || /rate limit/i.test(data?.message || '')) {
			return cap(60 * 1000 * 2 ** attempt);
		}
		return null;
	}


	_sleep(ms) {
		return this.cancel ? this.cancel.sleep(ms) : Zotero.Promise.delay(ms);
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


	/**
	 * @return {Promise<Boolean>} Whether the repository has no commits at all.
	 * 		The repository's `size` field can't tell: it lags and rounds to KB.
	 */
	async isEmpty() {
		let { status } = await this.request('GET', `${this.repoPath}/commits?per_page=1`, {
			allowStatus: [409],
		});
		return status === 409;
	}


	/**
	 * The Git Data API refuses to work on a repository with no commits at all
	 * ("409 Git Repository is empty"), but the Contents API can create a file
	 * there, and with it the first commit and the default branch.
	 *
	 * @param {Object} options
	 * @param {String} options.path
	 * @param {String} options.text
	 * @param {String} options.message
	 * @return {Promise<String>} SHA of the commit created
	 */
	async createInitialCommit({ path, text, message }) {
		let encodedPath = String(path).split('/').map(encodeURIComponent).join('/');
		let { data } = await this.request('PUT', `${this.repoPath}/contents/${encodedPath}`, {
			body: {
				message,
				content: ZoteroGitHubSync.Utils.toBase64(ZoteroGitHubSync.Utils.encode(text)),
			},
		});
		return data.commit.sha;
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
		// Base64 never needs escaping in JSON, so build the body directly rather
		// than letting JSON.stringify() copy a large payload once more
		let rawBody = `{"encoding":"base64","content":"${base64Content}"}`;
		// Allow roughly 10 KB/s on top of the usual timeout before giving up
		let timeout = 120000 + Math.ceil(base64Content.length / 10000) * 1000;
		let { data } = await this.request('POST', `${this.repoPath}/git/blobs`, { rawBody, timeout });
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
	 * @param {String} sha
	 * @return {Promise<String>} The blob decoded as UTF-8
	 */
	async getBlobText(sha) {
		let { data } = await this.request('GET', `${this.repoPath}/git/blobs/${sha}`, { raw: true });
		return data || '';
	}


	/**
	 * Stream a blob to disk. GitHub serves blobs up to 100 MB this way.
	 *
	 * @param {String} sha
	 * @param {String} path
	 * @return {Promise<Number>} Bytes written
	 */
	async downloadBlob(sha, path) {
		return ZoteroGitHubSync.Files.downloadToFile(`${this.apiURL}${this.repoPath}/git/blobs/${sha}`, {
			path,
			headers: {
				Accept: 'application/vnd.github.raw+json',
				'X-GitHub-Api-Version': '2022-11-28',
				Authorization: `Bearer ${this.token}`,
			},
		});
	}


	/**
	 * @param {Object[]} entries - { path, mode, type, sha } (sha null deletes), or
	 * 		{ path, mode, type, content } to create a text blob in the same request
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


/**
 * Git LFS over its HTTP batch API: https://github.com/git-lfs/git-lfs/blob/main/docs/api/batch.md
 *
 * Git itself never sees large attachments. The plugin uploads the file to LFS
 * storage and commits a small pointer in its place, which is exactly what the
 * git-lfs client would have done, so a normal `git clone` with LFS installed
 * checks out the real file.
 */
ZoteroGitHubSync.GitLFS = class GitLFS {
	static BATCH_SIZE = 100;


	/**
	 * @param {Object} options
	 * @param {String} options.url - e.g. https://github.com/owner/repo.git/info/lfs
	 * @param {String} options.username - Paired with the token for Basic auth
	 * @param {String} options.token
	 */
	constructor({ url, username, token }) {
		this.url = url.replace(/\/+$/, '');
		this.authorization = 'Basic ' + btoa(`${username}:${token}`);
	}


	/**
	 * @param {'upload'|'download'} operation
	 * @param {Object[]} objects - { oid, size }
	 * @param {String} [ref] - e.g. refs/heads/main
	 * @return {Promise<Object[]>} The batch response's objects
	 */
	async batch(operation, objects, ref) {
		let body = {
			operation,
			transfers: ['basic'],
			objects: objects.map(o => ({ oid: o.oid, size: o.size })),
			hash_algo: 'sha256',
		};
		if (ref) {
			body.ref = { name: ref };
		}
		let response;
		try {
			response = await fetch(`${this.url}/objects/batch`, {
				method: 'POST',
				headers: {
					Accept: 'application/vnd.git-lfs+json',
					'Content-Type': 'application/vnd.git-lfs+json',
					Authorization: this.authorization,
				},
				body: JSON.stringify(body),
			});
		}
		catch (e) {
			throw new Error(`Network error contacting Git LFS: ${e.message || e}`);
		}
		let data = null;
		try {
			data = await response.json();
		}
		catch (e) {}
		if (!response.ok) {
			throw new ZoteroGitHubSync.GitHubError(this._errorMessage(response.status, data), {
				status: response.status,
				url: this.url,
				body: data,
			});
		}
		return data?.objects || [];
	}


	_errorMessage(status, data) {
		let detail = data?.message ? ` ${data.message}` : '';
		switch (status) {
			case 401:
			case 403:
				return `Git LFS denied access (${status}).${detail} The token needs Contents: Read and write.`;
			case 404:
				return `Git LFS endpoint not found (404).${detail}`;
			case 413:
				return `Git LFS rejected the file as too large (413).${detail}`;
			case 422:
				return `Git LFS rejected the request (422).${detail}`;
			case 507:
				return `Git LFS storage quota exceeded (507).${detail} Check the account's Git LFS billing.`;
			case 509:
				return `Git LFS bandwidth quota exceeded (509).${detail}`;
			default:
				return `Git LFS request failed (${status}).${detail}`;
		}
	}


	_objectError(object) {
		let error = object.error;
		return new Error(
			`Git LFS refused ${object.oid.slice(0, 12)}… (${error.code}): ${error.message || 'no reason given'}`
		);
	}


	/**
	 * Upload files LFS doesn't already have. Objects the server already stores
	 * come back without an upload action and cost nothing.
	 *
	 * @param {Object[]} objects - { oid, size, path }
	 * @param {Object} [options]
	 * @param {String} [options.ref]
	 * @param {Function} [options.onProgress] - (done, total)
	 * @return {Promise<Number>} Objects actually uploaded
	 */
	async uploadAll(objects, { ref, cancel = null, onProgress = () => {} } = {}) {
		let byOid = new Map(objects.map(o => [o.oid, o]));
		let unique = [...byOid.values()];
		let uploaded = 0;
		let done = 0;

		for (let i = 0; i < unique.length; i += GitLFS.BATCH_SIZE) {
			let chunk = unique.slice(i, i + GitLFS.BATCH_SIZE);
			let results = await this.batch('upload', chunk, ref);
			for (let result of results) {
				if (result.error) {
					throw this._objectError(result);
				}
				cancel?.throwIfCancelled();
				let local = byOid.get(result.oid);
				let upload = result.actions?.upload;
				if (local && upload) {
					let response = await ZoteroGitHubSync.Files.uploadFile(upload.href, {
						method: 'PUT',
						path: local.path,
						headers: { 'Content-Type': 'application/octet-stream', ...(upload.header || {}) },
					});
					if (!response.ok) {
						throw new Error(`Git LFS upload of ${PathUtils.filename(local.path)} failed (${response.status})`);
					}
					let verify = result.actions?.verify;
					if (verify) {
						let verified = await fetch(verify.href, {
							method: 'POST',
							headers: {
								Accept: 'application/vnd.git-lfs+json',
								'Content-Type': 'application/vnd.git-lfs+json',
								...(verify.header || {}),
							},
							body: JSON.stringify({ oid: local.oid, size: local.size }),
						});
						if (!verified.ok) {
							throw new Error(`Git LFS could not verify ${PathUtils.filename(local.path)} (${verified.status})`);
						}
					}
					uploaded++;
				}
				done++;
				onProgress(done, unique.length);
			}
		}
		return uploaded;
	}


	/**
	 * @param {Object[]} objects - { oid, size, path } where path is the destination
	 * @param {Object} [options]
	 * @param {String} [options.ref]
	 * @return {Promise<Object[]>} The objects that failed, with an `error` message
	 */
	async downloadAll(objects, { ref } = {}) {
		let failed = [];
		let byOid = new Map();
		for (let object of objects) {
			if (!byOid.has(object.oid)) {
				byOid.set(object.oid, []);
			}
			byOid.get(object.oid).push(object);
		}
		let unique = [...byOid.values()].map(list => list[0]);

		for (let i = 0; i < unique.length; i += GitLFS.BATCH_SIZE) {
			let chunk = unique.slice(i, i + GitLFS.BATCH_SIZE);
			let results = await this.batch('download', chunk, ref);
			for (let result of results) {
				let targets = byOid.get(result.oid) || [];
				let download = result.actions?.download;
				if (result.error || !download) {
					let message = result.error ? this._objectError(result).message : 'no download action';
					failed.push(...targets.map(t => ({ ...t, error: message })));
					continue;
				}
				for (let target of targets) {
					try {
						await ZoteroGitHubSync.Files.downloadToFile(download.href, {
							path: target.path,
							headers: download.header || {},
						});
					}
					catch (e) {
						failed.push({ ...target, error: e.message || String(e) });
					}
				}
			}
		}
		return failed;
	}
};
