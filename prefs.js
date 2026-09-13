/* Default preferences for Zotero GitHub Sync.
 *
 * Loaded by Zotero.Plugins on startup. Values here are *default* branch values;
 * anything the user changes is stored on the user branch. The auth token is NOT
 * stored here -- it lives in the Firefox login manager (see src/prefs.js).
 */

// -- Repository ------------------------------------------------------------
pref("extensions.zotero-github-sync.apiURL", "https://api.github.com");
pref("extensions.zotero-github-sync.owner", "");
pref("extensions.zotero-github-sync.repo", "");
pref("extensions.zotero-github-sync.branch", "main");
pref("extensions.zotero-github-sync.basePath", "zotero");
pref("extensions.zotero-github-sync.autoCreateRepo", true);
pref("extensions.zotero-github-sync.repoPrivate", true);

// -- What gets exported ----------------------------------------------------
pref("extensions.zotero-github-sync.includeGroupLibraries", true);
pref("extensions.zotero-github-sync.exportJSON", true);
pref("extensions.zotero-github-sync.exportMarkdown", true);
pref("extensions.zotero-github-sync.exportBibTeX", false);
pref("extensions.zotero-github-sync.exportIndex", true);
pref("extensions.zotero-github-sync.includeNotes", true);
pref("extensions.zotero-github-sync.includeAttachments", true);
// Linked files live outside the Zotero data directory, but they are still the
// user's documents
pref("extensions.zotero-github-sync.includeLinkedFiles", true);
// 0 means no limit of our own; GitHub's 100 MB cap still applies without LFS
pref("extensions.zotero-github-sync.maxAttachmentMB", 0);
// Files above the threshold go to Git LFS instead of Git
pref("extensions.zotero-github-sync.lfsEnabled", true);
pref("extensions.zotero-github-sync.lfsThresholdMB", 50);
// Empty means derive it from the API URL and repository
pref("extensions.zotero-github-sync.lfsURL", "");
pref("extensions.zotero-github-sync.prune", true);

// -- Triggers --------------------------------------------------------------
// Periodic sync
pref("extensions.zotero-github-sync.intervalEnabled", false);
pref("extensions.zotero-github-sync.intervalMinutes", 60);
// Sync a while after the library changes
pref("extensions.zotero-github-sync.syncOnChange", false);
pref("extensions.zotero-github-sync.changeDelayMinutes", 5);
// Sync once, shortly after Zotero starts
pref("extensions.zotero-github-sync.syncOnStartup", false);
// Sync to GitHub whenever Zotero's own sync (the toolbar sync button) finishes
pref("extensions.zotero-github-sync.syncAfterZoteroSync", false);

// -- Commits ---------------------------------------------------------------
pref("extensions.zotero-github-sync.commitMessage", "Zotero sync: {changes} ({date})");
pref("extensions.zotero-github-sync.authorName", "");
pref("extensions.zotero-github-sync.authorEmail", "");

// -- State (written by the plugin, not meant to be edited) -----------------
pref("extensions.zotero-github-sync.lastSync", "");
pref("extensions.zotero-github-sync.lastCommit", "");
pref("extensions.zotero-github-sync.lastError", "");
pref("extensions.zotero-github-sync.lastWarnings", "");
