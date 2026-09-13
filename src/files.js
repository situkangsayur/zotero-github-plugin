/* Zotero GitHub Sync -- attachment files on disk
 *
 * Attachment files are the one part of a library too large to hold in memory
 * all at once, so nothing here reads a whole file unless it is about to be
 * uploaded. Change detection runs off a hash cache keyed on path, size and
 * modification time: an unchanged PDF is never read again after its first sync.
 */

ZoteroGitHubSync.Files = {
	READ_CHUNK_BYTES: 4 * 1024 * 1024,
	CACHE_VERSION: 1,

	// Zotero keeps its full-text cache and reader state next to each file. They
	// are derived, rewritten constantly, and restored by Zotero on its own.
	IGNORED_PREFIX: '.zotero-',

	_cache: null,
	_cacheDirty: false,


	// -- Hashing -----------------------------------------------------------

	/**
	 * Hash a file without loading it into memory.
	 *
	 * @param {String} path
	 * @param {'git'|'lfs'} kind - `git` gives the Git blob SHA-1, `lfs` the
	 * 		SHA-256 Git LFS uses as an object ID
	 * @return {Promise<{hash: String, size: Number}>}
	 */
	async hashFile(path, kind) {
		let { size } = await IOUtils.stat(path);
		let Ci = Components.interfaces;
		let hash = Components.classes['@mozilla.org/security/hash;1']
			.createInstance(Ci.nsICryptoHash);
		hash.init(kind === 'lfs' ? Ci.nsICryptoHash.SHA256 : Ci.nsICryptoHash.SHA1);

		if (kind !== 'lfs') {
			let header = Array.from(ZoteroGitHubSync.Utils.encode(`blob ${size}\0`));
			hash.update(header, header.length);
		}

		let offset = 0;
		while (offset < size) {
			let chunk = await IOUtils.read(path, {
				offset,
				maxBytes: Math.min(this.READ_CHUNK_BYTES, size - offset),
			});
			if (!chunk.length) {
				// The file shrank while we were reading it; the size in the
				// header is now wrong, so the hash would be too
				throw new Error(`${path} changed while it was being read`);
			}
			this._update(hash, chunk);
			offset += chunk.length;
		}

		return { hash: this._hex(hash.finish(false)), size };
	},


	_typedArrayUpdate: true,

	_update(hash, chunk) {
		if (this._typedArrayUpdate) {
			try {
				hash.update(chunk, chunk.length);
				return;
			}
			catch (e) {
				// Older XPConnect wants a plain array for octet[] arguments. The
				// hash is still correct: a failed call consumes nothing.
				ZoteroGitHubSync.log(`nsICryptoHash.update() rejected a Uint8Array; using plain arrays (${e})`);
				this._typedArrayUpdate = false;
			}
		}
		let SLICE = 256 * 1024;
		for (let i = 0; i < chunk.length; i += SLICE) {
			let part = Array.from(chunk.subarray(i, i + SLICE));
			hash.update(part, part.length);
		}
	},


	_hex(binaryString) {
		let out = '';
		for (let i = 0; i < binaryString.length; i++) {
			out += binaryString.charCodeAt(i).toString(16).padStart(2, '0');
		}
		return out;
	},


	// -- Hash cache --------------------------------------------------------

	get cachePath() {
		return PathUtils.join(Zotero.Profile.dir, 'zotero-github-sync', 'hash-cache.json');
	},


	async loadCache() {
		if (this._cache) {
			return;
		}
		this._cache = new Map();
		try {
			if (!await IOUtils.exists(this.cachePath)) {
				return;
			}
			let data = await IOUtils.readJSON(this.cachePath);
			if (data?.version === this.CACHE_VERSION && data.entries) {
				this._cache = new Map(Object.entries(data.entries));
			}
		}
		catch (e) {
			// A corrupt cache only costs rehashing
			ZoteroGitHubSync.logError(e);
		}
	},


	async saveCache() {
		if (!this._cache || !this._cacheDirty) {
			return;
		}
		try {
			await IOUtils.makeDirectory(PathUtils.parent(this.cachePath), { ignoreExisting: true });
			await IOUtils.writeJSON(
				this.cachePath,
				{ version: this.CACHE_VERSION, entries: Object.fromEntries(this._cache) },
				{ tmpPath: `${this.cachePath}.tmp` }
			);
			this._cacheDirty = false;
		}
		catch (e) {
			ZoteroGitHubSync.logError(e);
		}
	},


	/**
	 * Drop cache entries for files a full sync no longer exports, so the cache
	 * doesn't grow forever as attachments are deleted.
	 *
	 * @param {Set<String>} paths - Absolute paths still in use
	 */
	retainCache(paths) {
		if (!this._cache) {
			return;
		}
		for (let path of [...this._cache.keys()]) {
			if (!paths.has(path)) {
				this._cache.delete(path);
				this._cacheDirty = true;
			}
		}
	},


	/**
	 * @param {Object} source - { path, size, mtime }
	 * @param {'git'|'lfs'} kind
	 * @return {Promise<String>} The hash, from the cache when the file is unchanged
	 */
	async cachedHash(source, kind) {
		await this.loadCache();
		let entry = this._cache.get(source.path);
		if (entry && entry.size === source.size && entry.mtime === source.mtime && entry[kind]) {
			return entry[kind];
		}
		let { hash, size } = await this.hashFile(source.path, kind);
		if (size !== source.size) {
			throw new Error(`${source.path} changed while it was being read`);
		}
		let fresh = entry && entry.size === source.size && entry.mtime === source.mtime
			? entry
			: { size: source.size, mtime: source.mtime };
		fresh[kind] = hash;
		this._cache.set(source.path, fresh);
		this._cacheDirty = true;
		return hash;
	},


	// -- Directory listing -------------------------------------------------

	/**
	 * @param {String} path
	 * @return {Promise<{path: String, size: Number, mtime: Number}|null>}
	 */
	async statFile(path) {
		try {
			let info = await IOUtils.stat(path);
			if (info.type !== 'regular') {
				return null;
			}
			return { path, size: info.size, mtime: info.lastModified };
		}
		catch (e) {
			return null;
		}
	},


	/**
	 * Every regular file under a directory, skipping Zotero's own cache files.
	 *
	 * @param {String} dir
	 * @return {Promise<Object[]>} { relPath, path, size, mtime }, sorted by relPath
	 */
	async listDirectory(dir) {
		let out = [];
		let walk = async (current, prefix) => {
			let children;
			try {
				children = await IOUtils.getChildren(current);
			}
			catch (e) {
				return;
			}
			for (let child of children) {
				let name = PathUtils.filename(child);
				if (name.startsWith(this.IGNORED_PREFIX)) {
					continue;
				}
				let info;
				try {
					info = await IOUtils.stat(child);
				}
				catch (e) {
					continue;
				}
				let relPath = prefix ? `${prefix}/${name}` : name;
				if (info.type === 'directory') {
					await walk(child, relPath);
				}
				else if (info.type === 'regular') {
					out.push({ relPath, path: child, size: info.size, mtime: info.lastModified });
				}
			}
		};
		await walk(dir, '');
		return out.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));
	},


	// -- Transfers ---------------------------------------------------------

	/**
	 * Stream an HTTP response body to disk, writing to a temporary file first so
	 * a failed download never leaves a truncated attachment behind.
	 *
	 * @param {String} url
	 * @param {Object} options
	 * @param {Object} [options.headers]
	 * @param {String} options.path - Destination
	 * @return {Promise<Number>} Bytes written
	 */
	async downloadToFile(url, { headers = {}, path }) {
		let response;
		try {
			response = await fetch(url, { headers, redirect: 'follow' });
		}
		catch (e) {
			throw new Error(`Network error downloading ${this._displayURL(url)}: ${e.message || e}`);
		}
		if (!response.ok) {
			throw new Error(`Download failed (${response.status}) for ${this._displayURL(url)}`);
		}

		await IOUtils.makeDirectory(PathUtils.parent(path), { ignoreExisting: true });
		let tmpPath = `${path}.zgs-download`;
		await IOUtils.write(tmpPath, new Uint8Array(0));

		let written = 0;
		try {
			let reader = response.body.getReader();
			let pending = [];
			let pendingBytes = 0;
			let flush = async () => {
				if (!pendingBytes) {
					return;
				}
				let buffer = new Uint8Array(pendingBytes);
				let offset = 0;
				for (let part of pending) {
					buffer.set(part, offset);
					offset += part.length;
				}
				await IOUtils.write(tmpPath, buffer, { mode: 'append' });
				written += pendingBytes;
				pending = [];
				pendingBytes = 0;
			};
			while (true) {
				let { done, value } = await reader.read();
				if (done) {
					break;
				}
				pending.push(value);
				pendingBytes += value.length;
				if (pendingBytes >= this.READ_CHUNK_BYTES) {
					await flush();
				}
			}
			await flush();
			await IOUtils.move(tmpPath, path);
		}
		catch (e) {
			await IOUtils.remove(tmpPath, { ignoreAbsent: true });
			throw e;
		}
		return written;
	},


	/**
	 * Upload a file as a request body straight from disk.
	 *
	 * @return {Promise<Response>}
	 */
	async uploadFile(url, { method = 'PUT', headers = {}, path }) {
		let file = await File.createFromFileName(path);
		let response;
		try {
			response = await fetch(url, { method, headers, body: file });
		}
		catch (e) {
			throw new Error(`Network error uploading ${PathUtils.filename(path)}: ${e.message || e}`);
		}
		return response;
	},


	_displayURL(url) {
		// Pre-signed storage URLs carry credentials in the query string
		return String(url).replace(/\?.*$/, '');
	},
};
