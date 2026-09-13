/* Zotero GitHub Sync -- import test
 *
 * DEVELOPMENT ONLY. Installed next to the real plugin in a throwaway profile
 * with an empty data directory (see scripts/import-test/run-remote.sh). When
 * ZGS_IMPORT_TEST_DIR is set it:
 *
 *   1. reads a token from ZGS_TOKEN_FILE and the repository from ZGS_OWNER,
 *      ZGS_REPO, ZGS_BRANCH and ZGS_BASE_PATH,
 *   2. runs Import from GitHub exactly as the menu item does, minus the prompt,
 *   3. writes report.json with what the library holds afterwards,
 *   4. quits Zotero.
 *
 * The token is read from a file, never logged, and stays in this profile.
 */

var log = msg => Zotero.debug(`[ZGS import test] ${msg}`);

function install() {}
function uninstall() {}
function shutdown() {}

var sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function startup() {
	await Zotero.initializationPromise;
	let outDir = Services.env.get('ZGS_IMPORT_TEST_DIR');
	if (!outDir) {
		return;
	}
	let marker = PathUtils.join(outDir, 'DONE');
	try {
		let report = await run();
		await IOUtils.writeJSON(PathUtils.join(outDir, 'report.json'), report);
		await IOUtils.writeUTF8(marker, `${report.result?.status}\n`);
	}
	catch (e) {
		Zotero.logError(e);
		await IOUtils.writeUTF8(marker, `error: ${e}\n${e.stack}\n`);
	}
	setTimeout(() => Zotero.Utilities.Internal.quit(), 2000);
}


async function run() {
	let env = name => Services.env.get(name);
	let plugin;
	for (let i = 0; i < 120 && !plugin; i++) {
		plugin = Zotero.GitHubSync?.initialized ? Zotero.GitHubSync : null;
		if (!plugin) {
			await sleep(500);
		}
	}
	if (!plugin) {
		throw new Error('GitHub Sync plugin did not start');
	}

	let token = (await IOUtils.readUTF8(env('ZGS_TOKEN_FILE'))).trim();
	plugin.Prefs.set('owner', env('ZGS_OWNER'));
	plugin.Prefs.set('repo', env('ZGS_REPO'));
	plugin.Prefs.set('branch', env('ZGS_BRANCH') || 'main');
	plugin.Prefs.set('basePath', env('ZGS_BASE_PATH') || '');
	await plugin.Prefs.setToken(token);
	token = null;

	let started = Date.now();
	let ticker = setInterval(() => {
		let p = plugin.Sync.progress;
		log(`${Math.round((Date.now() - started) / 1000)}s: ${p ? plugin.Sync.describeProgress(p) : '(no progress)'}`);
	}, 20000);
	let result;
	try {
		result = await plugin.Sync.pull({ confirm: false });
	}
	finally {
		clearInterval(ticker);
	}
	let seconds = Math.round((Date.now() - started) / 1000);
	log(`import finished in ${seconds}s: ${JSON.stringify(result)}`);

	let libraryID = Zotero.Libraries.userLibraryID;
	let items = (await Zotero.Items.getAll(libraryID, false, false)).filter(i => !i.deleted);
	let counts = {};
	let bump = key => { counts[key] = (counts[key] || 0) + 1; };
	let attachments = { file: 0, fileOnDisk: 0, missingOnDisk: [], linkedURL: 0, linkedFile: 0 };
	for (let item of items) {
		bump(item.isTopLevelItem() ? 'topLevel' : 'child');
		bump(`type:${item.itemType}`);
		if (item.isAttachment()) {
			if (!item.isFileAttachment()) {
				attachments.linkedURL++;
				continue;
			}
			if (item.isLinkedFileAttachment()) {
				attachments.linkedFile++;
			}
			attachments.file++;
			let path = await item.getFilePathAsync();
			if (path && await IOUtils.exists(path)) {
				attachments.fileOnDisk++;
			}
			else {
				attachments.missingOnDisk.push(item.key);
			}
		}
	}
	return {
		result,
		seconds,
		counts,
		attachments,
		collections: Zotero.Collections.getByLibrary(libraryID, true).length,
		searches: (await Zotero.Searches.getAll(libraryID)).length,
		tagColors: (Zotero.SyncedSettings.get(libraryID, 'tagColors') || []).length,
		lastWarnings: plugin.Prefs.get('lastWarnings'),
		lastError: plugin.Prefs.get('lastError'),
		dataDir: Zotero.DataDirectory.dir,
	};
}
