/* Zotero GitHub Sync -- small helpers with no Zotero or GitHub knowledge */

ZoteroGitHubSync.Utils = {
	textEncoder: new TextEncoder(),
	textDecoder: new TextDecoder(),


	/**
	 * @param {String} str
	 * @return {Uint8Array}
	 */
	encode(str) {
		return this.textEncoder.encode(str);
	},


	/**
	 * Git's object ID for a blob: sha1("blob <byteLength>\0" + bytes).
	 *
	 * Computing this locally is what lets us upload only the files that actually
	 * changed instead of re-pushing the whole library on every sync.
	 *
	 * @param {Uint8Array} bytes
	 * @return {Promise<String>} 40-character hex digest
	 */
	async gitBlobSha(bytes) {
		let header = this.encode(`blob ${bytes.length}\0`);
		let buf = new Uint8Array(header.length + bytes.length);
		buf.set(header, 0);
		buf.set(bytes, header.length);
		let digest = await crypto.subtle.digest('SHA-1', buf);
		return Array.from(new Uint8Array(digest))
			.map(b => b.toString(16).padStart(2, '0'))
			.join('');
	},


	/**
	 * @param {Uint8Array} bytes
	 * @return {String} Base64, as the GitHub blob API wants it
	 */
	toBase64(bytes) {
		// btoa() takes a binary string, and String.fromCharCode() blows the
		// argument limit on large files, so build it in chunks. Blocks are a
		// multiple of three bytes, so each encodes without padding and a 50 MB
		// file never needs one 50 MB binary string alongside its base64.
		const BLOCK = 3 * 1024 * 1024;
		const CHUNK = 0x8000;
		let out = [];
		for (let start = 0; start < bytes.length; start += BLOCK) {
			let block = bytes.subarray(start, Math.min(start + BLOCK, bytes.length));
			let parts = [];
			for (let i = 0; i < block.length; i += CHUNK) {
				parts.push(String.fromCharCode.apply(null, block.subarray(i, i + CHUNK)));
			}
			out.push(btoa(parts.join('')));
		}
		return out.join('');
	},


	/**
	 * @param {String} base64
	 * @return {Uint8Array}
	 */
	fromBase64(base64) {
		let binary = atob(base64.replace(/\s/g, ''));
		let bytes = new Uint8Array(binary.length);
		for (let i = 0; i < binary.length; i++) {
			bytes[i] = binary.charCodeAt(i);
		}
		return bytes;
	},


	/**
	 * Two-character directory for a Zotero key. GitHub recommends no more than
	 * 3,000 entries per directory; Zotero keys draw on 32 characters, so this
	 * spreads a library over at most 1,024 directories.
	 *
	 * @param {String} key
	 * @return {String}
	 */
	shard(key) {
		return String(key).slice(0, 2);
	},


	/**
	 * Directory for a Markdown note: the first letter of its title, so the notes
	 * folder stays browsable by hand.
	 *
	 * @param {String} filename
	 * @return {String} A-Z, "0-9" or "other"
	 */
	letterShard(filename) {
		let first = String(filename || '').normalize('NFD').charAt(0).toUpperCase();
		if (/[A-Z]/.test(first)) {
			return first;
		}
		if (/[0-9]/.test(first)) {
			return '0-9';
		}
		return 'other';
	},


	/**
	 * @param {String} oid - SHA-256 hex
	 * @param {Number} size
	 * @return {String} A Git LFS pointer file
	 */
	lfsPointer(oid, size) {
		return `version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\nsize ${size}\n`;
	},


	/**
	 * @param {String} text
	 * @return {{oid: String, size: Number}|null}
	 */
	parseLFSPointer(text) {
		let str = String(text || '');
		if (str.length > 512 || !str.startsWith('version https://git-lfs.github.com/spec/')) {
			return null;
		}
		let oid = str.match(/^oid sha256:([0-9a-f]{64})$/m);
		let size = str.match(/^size (\d+)$/m);
		return oid && size ? { oid: oid[1], size: Number(size[1]) } : null;
	},


	/**
	 * Make a string safe to use as a single path segment in a Git repository
	 * (and on Windows, which is stricter than Git).
	 *
	 * @param {String} str
	 * @param {Number} [maxLength=80]
	 * @return {String}
	 */
	sanitizeSegment(str, maxLength = 80) {
		let out = String(str ?? '')
			// eslint-disable-next-line no-control-regex
			.replace(/[\x00-\x1f\x7f]/g, '')
			// Illegal on Windows, plus path separators
			.replace(/[/\\:*?"<>|]/g, '-')
			.replace(/\s+/g, ' ')
			.replace(/^[.\s]+|[.\s]+$/g, '')
			.trim();
		if (out.length > maxLength) {
			out = out.slice(0, maxLength).trim();
		}
		return out || 'untitled';
	},


	/**
	 * Normalize a user-supplied repository subdirectory: no leading/trailing
	 * slashes, no "..", no empty segments.
	 *
	 * @param {String} path
	 * @return {String} Possibly empty, meaning the repository root
	 */
	normalizeBasePath(path) {
		return String(path ?? '')
			.split('/')
			.map(s => s.trim())
			.filter(s => s && s !== '.' && s !== '..')
			.join('/');
	},


	/**
	 * Quote a scalar for a YAML front-matter value.
	 *
	 * @param {*} value
	 * @return {String}
	 */
	yamlString(value) {
		let str = value === undefined || value === null ? '' : String(value);
		return '"' + str.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, ' ') + '"';
	},


	/**
	 * Build a YAML front-matter block. Array values become YAML lists; empty
	 * values are dropped so the block stays readable.
	 *
	 * @param {Object} fields
	 * @return {String}
	 */
	yamlFrontMatter(fields) {
		let lines = ['---'];
		for (let [key, value] of Object.entries(fields)) {
			if (value === undefined || value === null || value === '') {
				continue;
			}
			if (Array.isArray(value)) {
				if (!value.length) {
					continue;
				}
				lines.push(`${key}:`);
				for (let entry of value) {
					lines.push(`  - ${this.yamlString(entry)}`);
				}
			}
			else if (typeof value === 'boolean' || typeof value === 'number') {
				lines.push(`${key}: ${value}`);
			}
			else {
				lines.push(`${key}: ${this.yamlString(value)}`);
			}
		}
		lines.push('---', '');
		return lines.join('\n');
	},


	/**
	 * Convert the HTML Zotero stores for notes into Markdown.
	 *
	 * Deliberately small: it handles the tags the Zotero note editor actually
	 * produces and falls back to the text content of anything else, so a note
	 * never disappears just because it used an unexpected element.
	 *
	 * @param {String} html
	 * @param {Object} [options]
	 * @param {Function} [options.resolveImage] - (attachmentKey) => relative link
	 * 		or null, for images Zotero embeds in notes
	 * @return {String}
	 */
	htmlToMarkdown(html, { resolveImage = null } = {}) {
		if (!html) {
			return '';
		}
		let doc;
		try {
			doc = new DOMParser().parseFromString(`<div>${html}</div>`, 'text/html');
		}
		catch (e) {
			return String(html).replace(/<[^>]+>/g, '');
		}
		// Gecko wraps a fragment in html/body; be tolerant of parsers that don't
		let root = doc.body?.childNodes?.length ? doc.body : (doc.documentElement || doc.body);
		if (!root) {
			return String(html).replace(/<[^>]+>/g, '');
		}
		let out = this._nodeToMarkdown(root, { listStack: [], resolveImage });
		return out
			.replace(/[ \t]+\n/g, '\n')
			.replace(/\n{3,}/g, '\n\n')
			.trim();
	},


	_nodeToMarkdown(node, ctx) {
		const TEXT_NODE = 3;
		const ELEMENT_NODE = 1;

		if (node.nodeType === TEXT_NODE) {
			// Collapse the whitespace HTML would have collapsed anyway, and keep
			// Markdown's special characters from being read as markup
			return node.nodeValue.replace(/\s+/g, ' ').replace(/([\\`*_[\]])/g, '\\$1');
		}
		if (node.nodeType !== ELEMENT_NODE) {
			return '';
		}

		let children = () => Array.from(node.childNodes)
			.map(child => this._nodeToMarkdown(child, ctx))
			.join('');
		let tag = node.nodeName.toLowerCase();

		switch (tag) {
			case 'br':
				return '  \n';
			case 'hr':
				return '\n\n---\n\n';
			case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6':
				return `\n\n${'#'.repeat(Number(tag[1]))} ${children().trim()}\n\n`;
			case 'p': case 'div':
				return `\n\n${children().trim()}\n\n`;
			case 'strong': case 'b': {
				let inner = children().trim();
				return inner ? `**${inner}**` : '';
			}
			case 'em': case 'i': {
				let inner = children().trim();
				return inner ? `*${inner}*` : '';
			}
			case 'del': case 's': case 'strike': {
				let inner = children().trim();
				return inner ? `~~${inner}~~` : '';
			}
			case 'code':
				return `\`${node.textContent}\``;
			case 'pre':
				return `\n\n\`\`\`\n${node.textContent.replace(/\n+$/, '')}\n\`\`\`\n\n`;
			case 'blockquote':
				return '\n\n' + children().trim().split('\n').map(l => `> ${l}`).join('\n') + '\n\n';
			case 'a': {
				let href = node.getAttribute('href');
				let inner = children().trim();
				return href ? `[${inner || href}](${href})` : inner;
			}
			case 'img': {
				let src = node.getAttribute('src') || '';
				let alt = node.getAttribute('alt') || 'image';
				// Zotero 7 notes point at an embedded-image attachment by key; link
				// to the file the exporter wrote for it when there is one
				let attachmentKey = node.getAttribute('data-attachment-key');
				let link = attachmentKey && ctx.resolveImage ? ctx.resolveImage(attachmentKey) : null;
				if (link) {
					return `![${alt}](${link})`;
				}
				// A full base64 data: URI would make the Markdown unreadable
				return src.startsWith('data:') || !src ? '`[embedded image]`' : `![${alt}](${src})`;
			}
			case 'ul': case 'ol': {
				ctx.listStack.push({ type: tag, index: 0 });
				// Only the <li> children matter; the whitespace between them would
				// otherwise indent every marker by a space
				let inner = Array.from(node.children)
					.map(child => this._nodeToMarkdown(child, ctx))
					.join('');
				ctx.listStack.pop();
				return `\n\n${inner.replace(/\n+$/, '')}\n\n`;
			}
			case 'li': {
				let list = ctx.listStack[ctx.listStack.length - 1];
				let depth = Math.max(0, ctx.listStack.length - 1);
				let marker = '-';
				if (list) {
					list.index++;
					marker = list.type === 'ol' ? `${list.index}.` : '-';
				}
				let indent = '  '.repeat(depth);
				// Blank lines inside a list item break the list in Markdown
				let inner = children()
					.replace(/\n{2,}/g, '\n')
					.trim()
					.split('\n')
					.join(`\n${indent}  `);
				return `${indent}${marker} ${inner}\n`;
			}
			case 'table': case 'tbody': case 'thead':
				return `\n\n${children()}\n\n`;
			case 'tr':
				return `| ${Array.from(node.children).map(c => this._nodeToMarkdown(c, ctx).trim()).join(' | ')} |\n`;
			case 'td': case 'th':
				return children().trim();
			case 'script': case 'style':
				return '';
			default:
				return children();
		}
	},


	/**
	 * Run an async function over a list with bounded concurrency, preserving
	 * result order. GitHub throttles aggressively, so blob uploads must not all
	 * be fired at once.
	 *
	 * @param {Array} items
	 * @param {Function} fn - async (item, index) => result
	 * @param {Number} [concurrency=4]
	 * @return {Promise<Array>}
	 */
	async pMap(items, fn, concurrency = 4) {
		let results = new Array(items.length);
		let next = 0;
		let failed = false;
		let workers = [];
		let workerCount = Math.max(1, Math.min(concurrency, items.length));
		for (let i = 0; i < workerCount; i++) {
			workers.push((async () => {
				// Once one call fails the whole map fails, so stop starting new ones
				while (!failed) {
					let index = next++;
					if (index >= items.length) {
						return;
					}
					try {
						results[index] = await fn(items[index], index);
					}
					catch (e) {
						failed = true;
						throw e;
					}
				}
			})());
		}
		await Promise.all(workers);
		return results;
	},


	/**
	 * @param {Date|String} [date]
	 * @return {String} ISO-8601 with seconds, no milliseconds
	 */
	isoDate(date) {
		let d = date ? new Date(date) : new Date();
		if (isNaN(d.getTime())) {
			return '';
		}
		return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
	},


	/**
	 * @param {Number} bytes
	 * @return {String}
	 */
	formatSize(bytes) {
		const UNITS = ['B', 'KB', 'MB', 'GB'];
		let value = bytes;
		let unit = 0;
		while (value >= 1024 && unit < UNITS.length - 1) {
			value /= 1024;
			unit++;
		}
		return `${value.toFixed(unit === 0 ? 0 : 1)} ${UNITS[unit]}`;
	},
};


/**
 * Thrown when the user cancels a sync. Not an error worth reporting as one.
 */
ZoteroGitHubSync.CancelledError = class CancelledError extends Error {
	constructor(message = 'Sync cancelled') {
		super(message);
		this.name = 'CancelledError';
	}
};


/**
 * A cancellation flag that long waits can listen to, so pressing Cancel during
 * a one-minute rate-limit pause takes effect immediately rather than after it.
 */
ZoteroGitHubSync.CancelToken = class CancelToken {
	constructor() {
		this.cancelled = false;
		this._listeners = new Set();
	}


	cancel() {
		if (this.cancelled) {
			return;
		}
		this.cancelled = true;
		for (let listener of this._listeners) {
			listener();
		}
		this._listeners.clear();
	}


	throwIfCancelled() {
		if (this.cancelled) {
			throw new ZoteroGitHubSync.CancelledError();
		}
	}


	/**
	 * @param {Number} ms
	 * @return {Promise<void>} Rejects with CancelledError if cancelled first
	 */
	sleep(ms) {
		this.throwIfCancelled();
		return new Promise((resolve, reject) => {
			let onCancel = () => {
				clearTimeout(timer);
				reject(new ZoteroGitHubSync.CancelledError());
			};
			let timer = setTimeout(() => {
				this._listeners.delete(onCancel);
				resolve();
			}, ms);
			this._listeners.add(onCancel);
		});
	}
};


/**
 * Sliding-window limiter for GitHub's secondary rate limits. GitHub allows 80
 * content-creating requests a minute; staying under that is far cheaper than
 * hitting the limit and sitting out the penalty.
 */
ZoteroGitHubSync.RateLimiter = class RateLimiter {
	/**
	 * @param {Object[]} windows - [{ ms, max }]
	 */
	constructor(windows) {
		this.windows = windows;
		this._stamps = [];
		this._longest = Math.max(...windows.map(w => w.ms));
	}


	/**
	 * Wait until a request is allowed, then record it.
	 *
	 * @param {Object} [options]
	 * @param {ZoteroGitHubSync.CancelToken} [options.cancel]
	 * @param {Function} [options.onWait] - Called with the time waiting ends
	 */
	async acquire({ cancel = null, onWait = null } = {}) {
		while (true) {
			let now = Date.now();
			while (this._stamps.length && now - this._stamps[0] >= this._longest) {
				this._stamps.shift();
			}
			let waitMs = 0;
			for (let { ms, max } of this.windows) {
				let inWindow = this._stamps.filter(t => now - t < ms);
				if (inWindow.length >= max) {
					waitMs = Math.max(waitMs, inWindow[0] + ms - now + 25);
				}
			}
			if (!waitMs) {
				this._stamps.push(now);
				return;
			}
			onWait?.(now + waitMs);
			if (cancel) {
				await cancel.sleep(waitMs);
			}
			else {
				await new Promise(resolve => setTimeout(resolve, waitMs));
			}
		}
	}
};
