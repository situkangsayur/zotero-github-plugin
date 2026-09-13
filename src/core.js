/* Zotero GitHub Sync -- namespace, lifecycle and localized strings */

var ZoteroGitHubSync = {
	id: null,
	version: null,
	rootURI: null,
	initialized: false,
	prefPaneID: null,
	
	PREF_BRANCH: 'extensions.zotero-github-sync.',
	
	
	async init({ id, version, rootURI }) {
		this.id = id;
		this.version = version;
		this.rootURI = rootURI;
		
		this.Prefs.migrate();
		this.Sync.init();
		await this.registerPrefPane();

		// The preference pane runs in the preferences window, which can't see
		// this sandbox; the Zotero global is the one thing both sides share
		Zotero.GitHubSync = this;
		
		this.initialized = true;
		this.log(`Initialized v${version}`);
	},
	
	
	async shutdown() {
		this.log('Shutting down');
		for (let win of Zotero.getMainWindows()) {
			try {
				this.UI.removeFromWindow(win);
			}
			catch (e) {
				this.logError(e);
			}
		}
		this.Sync.shutdown();
		if (this.prefPaneID) {
			try {
				Zotero.PreferencePanes.unregister(this.prefPaneID);
			}
			catch (e) {
				this.logError(e);
			}
			this.prefPaneID = null;
		}
		if (Zotero.GitHubSync === this) {
			delete Zotero.GitHubSync;
		}
		this.initialized = false;
	},
	
	
	async registerPrefPane() {
		try {
			this.prefPaneID = await Zotero.PreferencePanes.register({
				pluginID: this.id,
				src: this.rootURI + 'content/preferences.xhtml',
				scripts: [this.rootURI + 'content/preferences.js'],
				stylesheets: [this.rootURI + 'content/preferences.css'],
				image: this.rootURI + 'content/icons/github-48.svg',
				label: 'GitHub Sync',
				helpURL: 'https://github.com/situkangsayur/zotero-github-plugin#readme',
			});
		}
		catch (e) {
			this.logError(e);
		}
	},
	
	
	// -- Logging -----------------------------------------------------------
	
	log(msg) {
		Zotero.debug(`[GitHub Sync] ${msg}`);
	},
	
	warn(msg) {
		Zotero.warn(`[GitHub Sync] ${msg}`);
	},
	
	logError(e) {
		Zotero.logError(e instanceof Error ? e : new Error(`[GitHub Sync] ${e}`));
	},
	
	
	// -- Strings -----------------------------------------------------------
	
	// Kept as a plain table rather than Fluent so the plugin works unchanged on
	// every Zotero 7+ build. Add a locale by adding a key to `_strings`.
	_strings: {
		'en-US': {
			'menu.root': 'GitHub Sync',
			'menu.syncNow': 'Sync Library Now',
			'menu.syncSelected': 'Sync Selected Items to GitHub',
			'menu.syncCollection': 'Sync This Collection to GitHub',
			'menu.pull': 'Import from GitHub…',
			'menu.openRepo': 'Open Repository on GitHub',
			'menu.settings': 'GitHub Sync Settings…',
			'toolbar.tooltip': 'Sync library to GitHub',
			'toolbar.tooltipSyncing': 'Syncing to GitHub…',
			'progress.headline': 'GitHub Sync',
			'progress.collecting': 'Collecting library data…',
			'progress.comparing': 'Comparing with repository…',
			'progress.uploading': 'Uploading %S file(s)…',
			'progress.uploadingLFS': 'Uploading %S large file(s) to Git LFS…',
			'progress.uploadingCount': 'Uploading %S of %S files (%S of %S)',
			'progress.uploadingLFSCount': 'Uploading large files to Git LFS: %S of %S',
			'progress.waitingRateLimit': 'Waiting for GitHub rate limit until %S',
			'progress.cancelling': 'Cancelling…',
			'progress.cancelled': 'Sync cancelled. Files already committed stay in the repository.',
			'toolbar.lastSync': 'Last sync: %S',
			'toolbar.never': 'Not synced yet',
			'toolbar.lastError': 'Last sync failed: %S',
			'toolbar.clickToSync': 'Click to sync, right-click for more',
			'toolbar.clickForProgress': 'Click to show progress, right-click to cancel',
			'menu.cancel': 'Cancel GitHub Sync',
			'menu.showProgress': 'Show Progress',
			'progress.hashing': 'Checking attachment files: %S of %S',
			'progress.warnings': '%S file(s) skipped -- see Settings → GitHub Sync',
			'progress.restoring': 'Restoring attachment files…',
			'progress.committing': 'Creating commit…',
			'progress.done': 'Synced %S file(s) to %S',
			'progress.upToDate': 'Already up to date',
			'progress.failed': 'Sync failed',
			'progress.importing': 'Importing from GitHub…',
			'progress.imported': 'Imported %S item(s), updated %S, restored %S file(s)',
			'error.notConfigured': 'Set your GitHub token, owner and repository in Settings → GitHub Sync first.',
			'error.noItems': 'No items selected.',
			'error.running': 'A sync is already running.',
			'confirm.pullTitle': 'Import from GitHub',
			'confirm.pullBody': 'This reads items from %S and adds items missing from your library, '
				+ 'updating existing ones only when the repository copy is newer. '
				+ 'Nothing in your library is deleted. Continue?',
		},
		id: {
			'menu.root': 'GitHub Sync',
			'menu.syncNow': 'Sinkronkan Pustaka Sekarang',
			'menu.syncSelected': 'Sinkronkan Item Terpilih ke GitHub',
			'menu.syncCollection': 'Sinkronkan Koleksi Ini ke GitHub',
			'menu.pull': 'Impor dari GitHub…',
			'menu.openRepo': 'Buka Repositori di GitHub',
			'menu.settings': 'Pengaturan GitHub Sync…',
			'toolbar.tooltip': 'Sinkronkan pustaka ke GitHub',
			'toolbar.tooltipSyncing': 'Menyinkronkan ke GitHub…',
			'progress.headline': 'GitHub Sync',
			'progress.collecting': 'Mengumpulkan data pustaka…',
			'progress.comparing': 'Membandingkan dengan repositori…',
			'progress.uploading': 'Mengunggah %S berkas…',
			'progress.uploadingLFS': 'Mengunggah %S berkas besar ke Git LFS…',
			'progress.uploadingCount': 'Mengunggah %S dari %S berkas (%S dari %S)',
			'progress.uploadingLFSCount': 'Mengunggah berkas besar ke Git LFS: %S dari %S',
			'progress.waitingRateLimit': 'Menunggu batas laju GitHub sampai %S',
			'progress.cancelling': 'Membatalkan…',
			'progress.cancelled': 'Sinkronisasi dibatalkan. Berkas yang sudah di-commit tetap ada di repositori.',
			'toolbar.lastSync': 'Sinkronisasi terakhir: %S',
			'toolbar.never': 'Belum pernah disinkronkan',
			'toolbar.lastError': 'Sinkronisasi terakhir gagal: %S',
			'toolbar.clickToSync': 'Klik untuk sinkron, klik kanan untuk menu',
			'toolbar.clickForProgress': 'Klik untuk melihat progres, klik kanan untuk batal',
			'menu.cancel': 'Batalkan GitHub Sync',
			'menu.showProgress': 'Tampilkan Progres',
			'progress.hashing': 'Memeriksa berkas lampiran: %S dari %S',
			'progress.warnings': '%S berkas dilewati -- lihat Pengaturan → GitHub Sync',
			'progress.restoring': 'Memulihkan berkas lampiran…',
			'progress.committing': 'Membuat commit…',
			'progress.done': '%S berkas tersinkron ke %S',
			'progress.upToDate': 'Sudah paling baru',
			'progress.failed': 'Sinkronisasi gagal',
			'progress.importing': 'Mengimpor dari GitHub…',
			'progress.imported': '%S item diimpor, %S diperbarui, %S berkas dipulihkan',
			'error.notConfigured': 'Isi token GitHub, owner, dan repositori di Pengaturan → GitHub Sync terlebih dahulu.',
			'error.noItems': 'Tidak ada item yang dipilih.',
			'error.running': 'Sinkronisasi sedang berjalan.',
			'confirm.pullTitle': 'Impor dari GitHub',
			'confirm.pullBody': 'Ini membaca item dari %S lalu menambahkan item yang belum ada di pustaka Anda, '
				+ 'dan memperbarui item yang salinan repositorinya lebih baru. '
				+ 'Tidak ada data pustaka yang dihapus. Lanjutkan?',
		},
	},
	
	/**
	 * @param {String} key
	 * @param {...String} args - Substituted for %S placeholders, in order
	 * @return {String}
	 */
	getString(key, ...args) {
		let locale = Zotero.locale || 'en-US';
		let table = this._strings[locale]
			|| this._strings[locale.split('-')[0]]
			|| this._strings['en-US'];
		let str = table[key] ?? this._strings['en-US'][key] ?? key;
		for (let arg of args) {
			str = str.replace('%S', arg);
		}
		return str;
	},
};
