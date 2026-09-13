/* Zotero GitHub Sync -- bootstrap entry point
 *
 * Zotero loads this file into a per-plugin sandbox and calls the hooks below
 * (see Zotero.Plugins in chrome/content/zotero/xpcom/plugins.js). Everything
 * else lives in src/, loaded into this same sandbox by loadSubScript() so the
 * modules share one scope and the `Zotero` global.
 */

// Set by src/core.js once loaded
var ZoteroGitHubSync;

var SOURCE_FILES = [
	'src/core.js',
	'src/utils.js',
	'src/files.js',
	'src/prefs.js',
	'src/github.js',
	'src/planner.js',
	'src/state.js',
	'src/exporter.js',
	'src/importer.js',
	'src/sync.js',
	'src/review.js',
	'src/ui.js',
];


function install() {}


async function startup({ id, version, rootURI }, reason) {
	await Zotero.initializationPromise;
	
	if (ZoteroGitHubSync?.initialized) {
		return;
	}
	
	for (let file of SOURCE_FILES) {
		Services.scriptloader.loadSubScript(rootURI + file);
	}
	
	await ZoteroGitHubSync.init({ id, version, rootURI });
	
	// onMainWindowLoad() only fires for windows opened after we start up, so
	// decorate the ones that are already open
	for (let win of Zotero.getMainWindows()) {
		if (win.ZoteroPane) {
			ZoteroGitHubSync.UI.addToWindow(win);
		}
	}
}


function onMainWindowLoad({ window }) {
	ZoteroGitHubSync?.UI.addToWindow(window);
}


function onMainWindowUnload({ window }) {
	ZoteroGitHubSync?.UI.removeFromWindow(window);
}


async function shutdown({ id, version, rootURI }, reason) {
	if (reason === APP_SHUTDOWN) {
		return;
	}
	if (ZoteroGitHubSync) {
		await ZoteroGitHubSync.shutdown();
		ZoteroGitHubSync = undefined;
	}
}


function uninstall() {}
