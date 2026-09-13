/* Zotero GitHub Sync -- deciding what a sync should do with each file
 *
 * A three-way comparison, the way Git itself decides a merge. For every
 * repository path we know up to three blob SHAs:
 *
 *   local   what exporting this library produces now
 *   remote  what the branch holds now
 *   base    what both sides held after this computer's last successful sync
 *
 * Only the base can tell "changed in Zotero" from "changed on GitHub", so it is
 * what makes it safe to push, to import, and above all to delete. Without a
 * base (a computer syncing this repository for the first time) nothing is ever
 * deleted and nothing that differs is overwritten without a decision.
 *
 * Pure logic: no Zotero, no network, so it can be tested under Node.
 */

ZoteroGitHubSync.Planner = {
	/**
	 * Paths the importer can read back into Zotero. Everything else the plugin
	 * writes (Markdown, indexes, manifests) is derived from the library and is
	 * simply regenerated.
	 *
	 * @param {String} relPath - Relative to the base path
	 * @return {null|Object} { kind: 'item'|'file'|'library', key?, library }
	 */
	importable(relPath) {
		let item = relPath.match(/^([^/]+)\/items\/(?:[A-Z0-9]{2}\/)?([A-Z0-9]{8})\.json$/);
		if (item) {
			return { kind: 'item', key: item[2], library: item[1] };
		}
		let file = relPath.match(/^([^/]+)\/(?:attachments|attachments-lfs)\/(?:[A-Z0-9]{2}\/)?([A-Z0-9]{8})\/(.+)$/);
		if (file && !file[3].endsWith('.gitattributes')) {
			return { kind: 'file', key: file[2], library: file[1], name: file[3] };
		}
		let library = relPath.match(/^([^/]+)\/(collections|searches|settings)\.json$/);
		if (library) {
			return { kind: 'library', name: library[2], library: library[1] };
		}
		return null;
	},


	/**
	 * @param {Object} options
	 * @param {Map<String, String>} options.local - relPath -> SHA the export produces
	 * @param {Map<String, String>} options.remote - relPath -> SHA on the branch
	 * @param {Map<String, String>|null} options.base - relPath -> SHA at the last sync,
	 * 		or null when this computer has never synced this repository
	 * @param {Set<String>} [options.kept] - Paths whose files exist in the library but
	 * 		not on this computer; left exactly as they are
	 * @param {Boolean} [options.fullSync=true] - A partial sync never deletes and
	 * 		ignores paths it didn't export
	 * @param {Set<String>} [options.managed] - Paths the plugin is allowed to touch
	 * 		on the server (from files.json); deletions are limited to these
	 * @return {Object} Arrays of relPaths by action: {
	 * 		push, delete, incoming, conflicts, overwrite, restore, diverged, unchanged
	 * 	}
	 */
	plan({ local, remote, base, kept = new Set(), fullSync = true, managed = null }) {
		let plan = {
			// Local change, server untouched since the last sync: upload
			push: [],
			// Gone from this library since the last sync, untouched on the server
			delete: [],
			// Changed or added on the server, untouched here: can be imported
			incoming: [],
			// Importable and changed on both sides
			conflicts: [],
			// Derived file edited on the server; the sync would overwrite the edit
			overwrite: [],
			// Deleted on the server but still in this library
			restore: [],
			// No base, both sides have it and they differ: resolved by comparing
			// dates where possible, otherwise treated as a conflict
			diverged: [],
			unchanged: [],
		};

		let paths = fullSync
			? new Set([...local.keys(), ...remote.keys(), ...(base ? base.keys() : [])])
			: new Set(local.keys());

		for (let path of paths) {
			if (kept.has(path)) {
				plan.unchanged.push(path);
				continue;
			}
			let l = local.get(path);
			let r = remote.get(path);
			let b = base ? base.get(path) : undefined;
			let importable = !!this.importable(path);

			if (l === r) {
				plan.unchanged.push(path);
				continue;
			}

			// Not in this library's export
			if (l === undefined) {
				if (r === undefined) {
					plan.unchanged.push(path);
				}
				else if (b !== undefined && r === b) {
					// We had it at the last sync and it's gone here now
					if (!managed || managed.has(path)) {
						plan.delete.push(path);
					}
					else {
						plan.unchanged.push(path);
					}
				}
				else if (importable) {
					// Added or changed on the server
					plan.incoming.push(path);
				}
				else {
					// A derived file we don't produce (another computer's item,
					// say): not ours to delete without a base that says so
					plan.unchanged.push(path);
				}
				continue;
			}

			// Exported here, absent on the server
			if (r === undefined) {
				if (b !== undefined && l === b) {
					plan.restore.push(path);
				}
				else if (b !== undefined && importable) {
					// Deleted there, changed here
					plan.restore.push(path);
				}
				else {
					plan.push.push(path);
				}
				continue;
			}

			// Both sides have it and they differ
			if (b === undefined) {
				if (importable) {
					plan.diverged.push(path);
				}
				else {
					// Regenerated output with no history to protect
					plan.push.push(path);
				}
			}
			else if (r === b) {
				plan.push.push(path);
			}
			else if (l === b) {
				if (importable) {
					plan.incoming.push(path);
				}
				else {
					plan.overwrite.push(path);
				}
			}
			else if (importable) {
				plan.conflicts.push(path);
			}
			else {
				plan.overwrite.push(path);
			}
		}

		for (let list of Object.values(plan)) {
			list.sort();
		}
		return plan;
	},


	/**
	 * @return {Boolean} Whether the plan contains anything a person should decide
	 */
	needsReview(plan) {
		return !!(plan.incoming.length || plan.conflicts.length || plan.overwrite.length
			|| plan.restore.length || plan.diverged.length);
	},


	/**
	 * The base to store after a sync.
	 *
	 * A path is recorded as synced only when both sides now hold the same SHA.
	 * Paths the sync left undecided keep whatever base they had, so the same
	 * question comes back next time instead of silently turning into a push or a
	 * delete.
	 *
	 * @param {Object} options
	 * @param {Map<String, String>} options.local - What the library exports now
	 * @param {Map<String, String>} options.remote - The branch after the sync
	 * @param {Map<String, String>|null} options.base - The previous base
	 * @param {Set<String>} options.undecided - Paths skipped or excluded this time
	 * @param {Set<String>} [options.kept]
	 * @return {Map<String, String>}
	 */
	nextBase({ local, remote, base, undecided, kept = new Set() }) {
		let next = new Map();
		let paths = new Set([...local.keys(), ...remote.keys(), ...(base ? base.keys() : [])]);
		for (let path of paths) {
			if (undecided.has(path) || kept.has(path)) {
				if (base?.has(path)) {
					next.set(path, base.get(path));
				}
				else if (kept.has(path) && remote.has(path)) {
					next.set(path, remote.get(path));
				}
				continue;
			}
			let l = local.get(path);
			let r = remote.get(path);
			if (l !== undefined && l === r) {
				next.set(path, l);
			}
		}
		return next;
	},
};
