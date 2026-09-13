/* Zotero GitHub Sync -- the review panel shown before a sync decides for you
 *
 * Drawn inside Zotero's main window as an overlay rather than a separate
 * window: some window managers tile or truncate dialogs, and a modal dialog
 * that can't be dismissed locks the whole application. Escape or Cancel closes
 * it without changing anything.
 */

ZoteroGitHubSync.Review = {
	HTML_NS: 'http://www.w3.org/1999/xhtml',

	_open: null,


	/**
	 * @param {Object} review - From Sync._prepareReview(): {
	 * 		repo, counts: { add, update, delete },
	 * 		incoming: [{ path, title, detail }],
	 * 		conflicts: [{ path, title, detail, options: ['local', 'server', 'both'], choice }],
	 * 		overwrite: [{ path, title, detail }],
	 * 		restore: [{ path, title, detail }],
	 * 		server: [{ path, title, detail, action: 'update'|'delete' }],
	 * 	}
	 * @return {Promise<Object|null>} Decisions for Sync, or null if cancelled
	 */
	ask(review) {
		let win = Zotero.getMainWindow();
		if (!win) {
			return Promise.resolve(null);
		}
		this._open?.cancel();
		return new Promise((resolve) => {
			let panel = this._build(win, review, resolve);
			this._open = panel;
		});
	},


	close() {
		this._open?.cancel();
	},


	_build(win, review, resolve) {
		let doc = win.document;
		let get = (key, ...args) => ZoteroGitHubSync.getString(key, ...args);
		let h = (tag, props = {}, ...children) => {
			let el = doc.createElementNS(this.HTML_NS, tag);
			for (let [key, value] of Object.entries(props)) {
				if (key === 'class') {
					el.className = value;
				}
				else if (key === 'text') {
					el.textContent = value;
				}
				else if (key.startsWith('on')) {
					el.addEventListener(key.slice(2), value);
				}
				else if (value !== false && value !== undefined && value !== null) {
					el.setAttribute(key, value === true ? '' : value);
				}
			}
			for (let child of children.flat()) {
				if (child !== null && child !== undefined) {
					el.append(child);
				}
			}
			return el;
		};

		// State the panel edits; turned into decisions on confirm
		let checks = { incoming: new Map(), overwrite: new Map(), restore: new Map(), server: new Map() };
		let choices = new Map();
		let settled = false;

		let overlay = h('div', { id: 'zotero-github-sync-review', class: 'zgs-review-overlay', role: 'dialog', 'aria-modal': 'true' });
		let finish = (value) => {
			if (settled) {
				return;
			}
			settled = true;
			win.removeEventListener('keydown', onKey, true);
			overlay.remove();
			if (this._open?.overlay === overlay) {
				this._open = null;
			}
			resolve(value);
		};
		let onKey = (event) => {
			if (event.key === 'Escape') {
				event.preventDefault();
				event.stopPropagation();
				finish(null);
			}
		};

		let summary = h('div', { class: 'zgs-review-summary' });
		let updateSummary = () => {
			let imports = [...checks.incoming.values()].filter(Boolean).length
				+ [...choices.values()].filter(c => c !== 'local').length;
			let excluded = [...checks.server.values()].filter(v => !v).length
				+ [...checks.overwrite.values()].filter(v => !v).length;
			summary.textContent = get('review.summary', String(imports), String(excluded));
		};

		let rowTitle = row => h('div', { class: 'zgs-review-text' },
			h('div', { class: 'zgs-review-title', text: row.title || row.path }),
			h('div', { class: 'zgs-review-detail', text: [row.detail, row.path].filter(Boolean).join(' · ') }));

		let checkSection = (id, rows, { heading, description, label, defaultValue = true, rowDetail = null }) => {
			if (!rows.length) {
				return null;
			}
			let boxes = [];
			let list = h('div', { class: 'zgs-review-list' });
			for (let row of rows) {
				checks[id].set(row.path, defaultValue);
				let box = h('input', { type: 'checkbox', 'aria-label': label, onchange: (e) => {
					checks[id].set(row.path, e.target.checked);
					updateSummary();
				} });
				box.checked = defaultValue;
				boxes.push([box, row.path]);
				list.append(h('label', { class: 'zgs-review-row' }, box, rowTitle(rowDetail ? { ...row, detail: rowDetail(row) } : row)));
			}
			let setAll = (value) => {
				for (let [box, path] of boxes) {
					box.checked = value;
					checks[id].set(path, value);
				}
				updateSummary();
			};
			return h('section', { class: 'zgs-review-section' },
				h('div', { class: 'zgs-review-section-head' },
					h('h2', { text: `${heading} (${rows.length})` }),
					h('span', { class: 'zgs-review-bulk' },
						h('button', { type: 'button', text: get('review.all'), onclick: () => setAll(true) }),
						h('button', { type: 'button', text: get('review.none'), onclick: () => setAll(false) }))),
				h('p', { class: 'zgs-review-description', text: description }),
				list);
		};

		let conflictSection = () => {
			let rows = review.conflicts;
			if (!rows.length) {
				return null;
			}
			let list = h('div', { class: 'zgs-review-list' });
			rows.forEach((row) => {
				choices.set(row.path, row.choice);
				// A segmented control rather than radio buttons, which Zotero's
				// main-window styles render without a visible checked state
				let buttons = row.options.map(option => h('button', {
					type: 'button',
					class: 'zgs-review-segment',
					'data-option': option,
					'aria-pressed': String(option === row.choice),
					text: get(`review.choice.${option}`),
					onclick: () => {
						choices.set(row.path, option);
						for (let button of buttons) {
							button.setAttribute('aria-pressed', String(button.dataset.option === option));
						}
						updateSummary();
					},
				}));
				let options = h('div', { class: 'zgs-review-segments', role: 'group' }, buttons);
				list.append(h('div', { class: 'zgs-review-row zgs-review-conflict' },
					rowTitle(row),
					h('div', { class: 'zgs-review-choices' }, options)));
			});
			return h('section', { class: 'zgs-review-section' },
				h('div', { class: 'zgs-review-section-head' }, h('h2', { text: `${get('review.conflicts')} (${rows.length})` })),
				h('p', { class: 'zgs-review-description', text: get('review.conflictsHelp') }),
				list);
		};

		let sections = [
			checkSection('incoming', review.incoming, {
				heading: get('review.incoming'),
				description: get('review.incomingHelp'),
				label: get('review.import'),
			}),
			conflictSection(),
			checkSection('restore', review.restore, {
				heading: get('review.restore'),
				description: get('review.restoreHelp'),
				label: get('review.uploadAgain'),
			}),
			checkSection('overwrite', review.overwrite, {
				heading: get('review.overwrite'),
				description: get('review.overwriteHelp'),
				label: get('review.overwriteLabel'),
			}),
			checkSection('server', review.server, {
				heading: get('review.server'),
				description: get('review.serverHelp'),
				label: get('review.apply'),
				rowDetail: row => get(row.action === 'delete' ? 'review.willDelete' : 'review.willReplace'),
			}),
		].filter(Boolean);

		if (!sections.length) {
			sections.push(h('p', { class: 'zgs-review-empty', text: get('review.nothing') }));
		}

		let counts = review.counts;
		let card = h('div', { class: 'zgs-review-card' },
			h('header', { class: 'zgs-review-header' },
				h('h1', { text: get('review.heading', review.repo) }),
				h('p', { text: get('review.counts', String(counts.add), String(counts.update), String(counts.delete)) })),
			h('div', { class: 'zgs-review-body' }, sections),
			h('footer', { class: 'zgs-review-footer' },
				summary,
				h('button', { type: 'button', class: 'zgs-review-cancel', text: get('review.cancel'), onclick: () => finish(null) }),
				h('button', { type: 'button', class: 'zgs-review-confirm', text: get('review.confirm'), onclick: () => finish(this._decisions(review, checks, choices)) })));

		overlay.append(card);
		overlay.addEventListener('click', (event) => {
			if (event.target === overlay) {
				finish(null);
			}
		});
		win.addEventListener('keydown', onKey, true);
		(doc.getElementById('main-window') || doc.documentElement).append(overlay);
		updateSummary();
		card.querySelector('.zgs-review-confirm')?.focus();

		return { overlay, cancel: () => finish(null) };
	},


	/**
	 * Turn what the panel shows into what the sync does.
	 */
	_decisions(review, checks, choices) {
		let decisions = { importPaths: new Set(), pushPaths: new Set(), keepBoth: new Set(), excluded: new Set() };
		for (let [path, accepted] of checks.incoming) {
			if (accepted) {
				decisions.importPaths.add(path);
			}
		}
		for (let [path, choice] of choices) {
			if (choice === 'local') {
				decisions.pushPaths.add(path);
			}
			else if (choice === 'server') {
				// Imported, then exported again: for a library file that means the
				// repository's collections are merged in, then the union is pushed
				decisions.importPaths.add(path);
			}
			else if (choice === 'both') {
				decisions.importPaths.add(path);
				decisions.keepBoth.add(path);
				decisions.pushPaths.add(path);
			}
		}
		for (let id of ['overwrite', 'restore']) {
			for (let [path, accepted] of checks[id]) {
				if (accepted) {
					decisions.pushPaths.add(path);
				}
				else {
					decisions.excluded.add(path);
				}
			}
		}
		for (let [path, accepted] of checks.server) {
			if (!accepted) {
				decisions.excluded.add(path);
			}
		}
		return decisions;
	},
};
