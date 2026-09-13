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
			'menu.review': 'Review Changes and Sync…',
			'toolbar.attention': '%S change(s) on GitHub need your review — click to review',
			'review.preparing': 'Preparing the review…',
			'review.importing': 'Importing %S accepted change(s)…',
			'review.pendingWarning': '%S change(s) on GitHub were left for review and not overwritten',
			'review.pendingSummary': '%S change(s) need review: click the GitHub button',
			'review.heading': 'Review sync with %S',
			'review.counts': 'This sync adds %S file(s), replaces %S and deletes %S on GitHub.',
			'review.summary': '%S change(s) will be imported into Zotero · %S file(s) excluded',
			'review.all': 'All',
			'review.none': 'None',
			'review.cancel': 'Cancel',
			'review.confirm': 'Sync',
			'review.nothing': 'Nothing needs a decision. Sync uploads your changes.',
			'review.incoming': 'Changes on GitHub',
			'review.incomingHelp': 'Changed or added on GitHub, or by another computer, and not changed here. Ticked items are imported into Zotero before syncing; unticked ones stay as they are and are asked about again next time.',
			'review.import': 'Import into Zotero',
			'review.conflicts': 'Changed in both places',
			'review.conflictsHelp': 'Choose which version to keep. "Keep both" adds the GitHub file as a second attachment.',
			'review.choice.local': 'Zotero',
			'review.choice.server': 'GitHub',
			'review.choice.both': 'Keep both',
			'review.restore': 'Deleted on GitHub, still in Zotero',
			'review.restoreHelp': 'Ticked files are uploaded again. Nothing is deleted from your library; to accept the deletion, delete the item in Zotero and sync.',
			'review.uploadAgain': 'Upload again',
			'review.overwrite': 'Edited on GitHub, generated by the plugin',
			'review.overwriteHelp': 'These files are regenerated from your library on every sync; edits made on GitHub are replaced. Untick to leave them alone this time.',
			'review.overwriteLabel': 'Replace',
			'review.server': 'Files this sync replaces or deletes on GitHub',
			'review.serverHelp': 'Your changes in Zotero. Untick a file to exclude it from this sync.',
			'review.apply': 'Include in this sync',
			'review.willReplace': 'will be replaced',
			'review.willDelete': 'will be deleted',
			'review.changedOnServer': 'changed on GitHub',
			'review.addedOnServer': 'only on GitHub',
			'review.editedOnServer': 'edited on GitHub',
			'review.deletedOnServer': 'deleted on GitHub',
			'review.dates': 'modified in Zotero %S · on GitHub %S',
			'review.fileDiffers': 'the file differs',
			'review.libraryDiffers': '"GitHub" merges its entries into Zotero',
			'review.markdown': 'Markdown note',
			'review.library.collections': 'Collections',
			'review.library.searches': 'Saved searches',
			'review.library.settings': 'Tag colors',
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
			'menu.review': 'Tinjau Perubahan dan Sinkronkan…',
			'toolbar.attention': '%S perubahan di GitHub perlu ditinjau — klik untuk meninjau',
			'review.preparing': 'Menyiapkan tinjauan…',
			'review.importing': 'Mengimpor %S perubahan yang diterima…',
			'review.pendingWarning': '%S perubahan di GitHub dibiarkan untuk ditinjau dan tidak ditimpa',
			'review.pendingSummary': '%S perubahan perlu ditinjau: klik tombol GitHub',
			'review.heading': 'Tinjau sinkronisasi dengan %S',
			'review.counts': 'Sinkronisasi ini menambah %S berkas, mengganti %S dan menghapus %S di GitHub.',
			'review.summary': '%S perubahan akan diimpor ke Zotero · %S berkas dikecualikan',
			'review.all': 'Semua',
			'review.none': 'Tidak ada',
			'review.cancel': 'Batal',
			'review.confirm': 'Sinkronkan',
			'review.nothing': 'Tidak ada yang perlu diputuskan. Sinkronisasi akan mengunggah perubahan Anda.',
			'review.incoming': 'Perubahan di GitHub',
			'review.incomingHelp': 'Diubah atau ditambahkan di GitHub, atau oleh komputer lain, dan tidak diubah di sini. Yang dicentang diimpor ke Zotero sebelum sinkron; yang tidak dicentang dibiarkan dan ditanyakan lagi lain kali.',
			'review.import': 'Impor ke Zotero',
			'review.conflicts': 'Berubah di kedua tempat',
			'review.conflictsHelp': 'Pilih versi yang disimpan. "Simpan keduanya" menambahkan berkas dari GitHub sebagai lampiran kedua.',
			'review.choice.local': 'Zotero',
			'review.choice.server': 'GitHub',
			'review.choice.both': 'Simpan keduanya',
			'review.restore': 'Dihapus di GitHub, masih ada di Zotero',
			'review.restoreHelp': 'Berkas yang dicentang diunggah lagi. Tidak ada yang dihapus dari pustaka Anda; untuk menerima penghapusan, hapus item itu di Zotero lalu sinkronkan.',
			'review.uploadAgain': 'Unggah lagi',
			'review.overwrite': 'Diedit di GitHub, dibuat oleh plugin',
			'review.overwriteHelp': 'Berkas ini dibuat ulang dari pustaka setiap sinkron; editan di GitHub akan diganti. Hilangkan centang untuk membiarkannya kali ini.',
			'review.overwriteLabel': 'Ganti',
			'review.server': 'Berkas yang diganti atau dihapus di GitHub oleh sinkron ini',
			'review.serverHelp': 'Perubahan Anda di Zotero. Hilangkan centang untuk mengecualikan berkas dari sinkron ini.',
			'review.apply': 'Ikutkan di sinkron ini',
			'review.willReplace': 'akan diganti',
			'review.willDelete': 'akan dihapus',
			'review.changedOnServer': 'diubah di GitHub',
			'review.addedOnServer': 'hanya ada di GitHub',
			'review.editedOnServer': 'diedit di GitHub',
			'review.deletedOnServer': 'dihapus di GitHub',
			'review.dates': 'diubah di Zotero %S · di GitHub %S',
			'review.fileDiffers': 'isi berkas berbeda',
			'review.libraryDiffers': '"GitHub" menggabungkan isinya ke Zotero',
			'review.markdown': 'catatan Markdown',
			'review.library.collections': 'Koleksi',
			'review.library.searches': 'Saved search',
			'review.library.settings': 'Warna tag',
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
