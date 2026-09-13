/* Zotero GitHub Sync -- tutorial screenshot scenario
 *
 * DEVELOPMENT ONLY. Installed next to the real plugin in a throwaway profile
 * with its own data directory (see scripts/screenshots/run.sh). On startup it:
 *
 *   1. fills the empty library with a few well-known public papers,
 *   2. puts the plugin's UI into each state the tutorial shows,
 *   3. writes a PNG of each to $ZGS_SHOTS_DIR (plus rects.json for cropping),
 *   4. quits Zotero.
 *
 * It opens no ports and runs no code it didn't ship with.
 */

var HTML_NS = 'http://www.w3.org/1999/xhtml';
var log = msg => Zotero.debug(`[ZGS screenshots] ${msg}`);

function install() {}
function uninstall() {}
function shutdown() {}

async function startup() {
	await Zotero.initializationPromise;
	let outDir = Services.env.get('ZGS_SHOTS_DIR');
	if (!outDir) {
		log('ZGS_SHOTS_DIR not set; doing nothing');
		return;
	}
	try {
		await run(outDir);
		await IOUtils.writeUTF8(PathUtils.join(outDir, 'DONE'), 'ok\n');
	}
	catch (e) {
		Zotero.logError(e);
		await IOUtils.writeUTF8(PathUtils.join(outDir, 'DONE'), `error: ${e}\n${e.stack}\n`);
	}
	setTimeout(() => Zotero.Utilities.Internal.quit(), 1000);
}


var sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitFor(fn, { timeout = 30000, interval = 250, label = 'condition' } = {}) {
	let start = Date.now();
	while (Date.now() - start < timeout) {
		let value;
		try {
			value = await fn();
		}
		catch (e) {}
		if (value) {
			return value;
		}
		await sleep(interval);
	}
	throw new Error(`Timed out waiting for ${label}`);
}


/**
 * Draw a chrome window's content to a PNG file.
 */
async function capture(win, path) {
	let doc = win.document;
	let width = win.innerWidth;
	let height = win.innerHeight;
	let canvas = doc.createElementNS(HTML_NS, 'canvas');
	let scale = 1;
	canvas.width = width * scale;
	canvas.height = height * scale;
	let ctx = canvas.getContext('2d');
	ctx.scale(scale, scale);
	// DRAW_VIEW | USE_WIDGET_LAYERS: include child browsers, such as the
	// Plugins manager page, not just the window's own chrome
	ctx.drawWindow(win, 0, 0, width, height, 'rgb(255,255,255)', 0x04 | 0x08);
	let blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
	let bytes = new Uint8Array(await blob.arrayBuffer());
	await IOUtils.write(path, bytes);
	log(`wrote ${path} (${width}x${height})`);
}


function rectOf(win, selector) {
	let el = win.document.querySelector(selector);
	if (!el) {
		return null;
	}
	let r = el.getBoundingClientRect();
	return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) };
}


var MINIMAL_PDF = `%PDF-1.4
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj
4 0 obj<</Length 58>>stream
BT /F1 24 Tf 72 700 Td (Attention Is All You Need) Tj ET
endstream
endobj
5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj
trailer<</Root 1 0 R>>
%%EOF
`;


async function createSampleLibrary() {
	let libraryID = Zotero.Libraries.userLibraryID;
	if ((await Zotero.Items.getAll(libraryID, true)).length) {
		return;
	}
	let makeCollection = async (name, parentKey) => {
		let c = new Zotero.Collection();
		c.libraryID = libraryID;
		c.name = name;
		if (parentKey) {
			c.parentKey = parentKey;
		}
		await c.saveTx();
		return c;
	};
	let papers = await makeCollection('Papers');
	let nlp = await makeCollection('NLP', papers.key);
	let vision = await makeCollection('Computer Vision', papers.key);
	let books = await makeCollection('Books');

	let samples = [
		{
			type: 'conferencePaper', collection: nlp,
			title: 'Attention Is All You Need', date: '2017',
			creators: [['Ashish', 'Vaswani'], ['Noam', 'Shazeer'], ['Niki', 'Parmar']],
			fields: { proceedingsTitle: 'Advances in Neural Information Processing Systems', DOI: '10.48550/arXiv.1706.03762', url: 'https://arxiv.org/abs/1706.03762' },
			tags: ['transformers', 'attention'], pdf: true, note: '<h1>Reading notes</h1><p>Self-attention replaces recurrence entirely.</p>',
		},
		{
			type: 'journalArticle', collection: nlp,
			title: 'BERT: Pre-training of Deep Bidirectional Transformers for Language Understanding', date: '2019',
			creators: [['Jacob', 'Devlin'], ['Ming-Wei', 'Chang']],
			fields: { publicationTitle: 'NAACL-HLT', DOI: '10.18653/v1/N19-1423' }, tags: ['transformers'],
		},
		{
			type: 'conferencePaper', collection: vision,
			title: 'Deep Residual Learning for Image Recognition', date: '2016',
			creators: [['Kaiming', 'He'], ['Xiangyu', 'Zhang'], ['Shaoqing', 'Ren'], ['Jian', 'Sun']],
			fields: { proceedingsTitle: 'IEEE Conference on Computer Vision and Pattern Recognition', DOI: '10.1109/CVPR.2016.90' }, tags: ['CNN', 'vision'],
		},
		{
			type: 'journalArticle', collection: vision,
			title: 'ImageNet Classification with Deep Convolutional Neural Networks', date: '2017',
			creators: [['Alex', 'Krizhevsky'], ['Ilya', 'Sutskever'], ['Geoffrey E.', 'Hinton']],
			fields: { publicationTitle: 'Communications of the ACM', volume: '60', pages: '84-90', DOI: '10.1145/3065386' }, tags: ['CNN', 'ImageNet'],
		},
		{
			type: 'book', collection: books,
			title: 'Deep Learning', date: '2016',
			creators: [['Ian', 'Goodfellow'], ['Yoshua', 'Bengio'], ['Aaron', 'Courville']],
			fields: { publisher: 'MIT Press', ISBN: '9780262035613' }, tags: ['textbook'],
		},
	];

	let tmpDir = PathUtils.join(Zotero.getTempDirectory().path, 'zgs-screenshots');
	await IOUtils.makeDirectory(tmpDir, { ignoreExisting: true });

	for (let sample of samples) {
		let item = new Zotero.Item(sample.type);
		item.libraryID = libraryID;
		item.setField('title', sample.title);
		item.setField('date', sample.date);
		for (let [field, value] of Object.entries(sample.fields || {})) {
			item.setField(field, value);
		}
		item.setCreators(sample.creators.map(([firstName, lastName]) => ({ firstName, lastName, creatorType: 'author' })));
		for (let tag of sample.tags || []) {
			item.addTag(tag);
		}
		item.setCollections([sample.collection.id]);
		await item.saveTx();

		if (sample.note) {
			let note = new Zotero.Item('note');
			note.libraryID = libraryID;
			note.parentID = item.id;
			note.setNote(sample.note);
			await note.saveTx();
		}
		if (sample.pdf) {
			let path = PathUtils.join(tmpDir, 'vaswani-2017.pdf');
			await IOUtils.writeUTF8(path, MINIMAL_PDF);
			let attachment = await Zotero.Attachments.importFromFile({ file: path, parentItemID: item.id, title: 'Full Text PDF' });
			try {
				await Zotero.Annotations.saveFromJSON(attachment, {
					key: Zotero.DataObjectUtilities.generateKey(),
					type: 'highlight',
					text: 'Attention Is All You Need',
					comment: 'The thesis of the paper',
					color: '#ffd400',
					pageLabel: '1',
					sortIndex: '00000|000700|00072',
					position: { pageIndex: 0, rects: [[72, 700, 360, 724]] },
				});
			}
			catch (e) {
				log(`annotation skipped: ${e}`);
			}
		}
	}
}


async function run(outDir) {
	await IOUtils.makeDirectory(outDir, { ignoreExisting: true });
	let rects = {};

	let win = await waitFor(() => Zotero.getMainWindows().find(w => w.ZoteroPane?.itemsView), { label: 'main window' });
	win.resizeTo(1280, 760);
	await createSampleLibrary();

	let plugin = await waitFor(() => Zotero.GitHubSync?.initialized && Zotero.GitHubSync, { label: 'GitHub Sync plugin' });
	let prefs = plugin.Prefs;
	prefs.set('owner', 'your-github-username');
	prefs.set('repo', 'zotero-library');
	prefs.set('basePath', '');

	// Library view: select the NLP collection and the paper with the PDF
	await win.ZoteroPane.collectionsView.selectByID('L' + Zotero.Libraries.userLibraryID);
	await sleep(1500);
	let attention = (await Zotero.Items.getAll(Zotero.Libraries.userLibraryID, true))
		.find(i => i.getField('title') === 'Attention Is All You Need');
	if (attention) {
		await win.ZoteroPane.selectItem(attention.id);
	}
	await sleep(2500);

	let button = await waitFor(() => win.document.getElementById('zotero-github-sync-button'), { label: 'toolbar button' });

	// 1. Idle
	plugin.Sync._setStatus('idle');
	await sleep(500);
	rects.button = rectOf(win, '#zotero-github-sync-button');
	rects.zoteroSync = rectOf(win, '#zotero-tb-sync');
	await capture(win, PathUtils.join(outDir, '01-main-window.png'));

	// 2. Syncing, with the progress window. Representative numbers: the real
	// sync is not running, only its display.
	plugin.Sync._running = true;
	plugin.Sync._setStatus('syncing');
	plugin.Sync._updateProgress({
		phase: 'uploading', done: 1840, total: 3685, bytesDone: 291 * 1024 * 1024, bytesTotal: 663 * 1024 * 1024,
	});
	plugin.Sync._openProgressWindow();
	await sleep(1500);
	rects.buttonSyncing = rectOf(win, '#zotero-github-sync-button');
	await capture(win, PathUtils.join(outDir, '02-syncing-main.png'));
	let progressWin = Services.wm.getMostRecentWindow('alert:alert') || [...Services.wm.getEnumerator(null)].find(w => /progressWindow/.test(w.location?.href));
	if (progressWin) {
		await capture(progressWin, PathUtils.join(outDir, '03-progress-window.png'));
	}
	plugin.Sync._progressWindow?.close();
	plugin.Sync._progressWindow = null;
	plugin.Sync._running = false;

	// 3. Error
	prefs.set('lastError', 'GitHub rejected the token (401). Check that it is valid and not expired.');
	plugin.Sync.progress = null;
	plugin.Sync._setStatus('error');
	await sleep(500);
	rects.buttonError = rectOf(win, '#zotero-github-sync-button');
	await capture(win, PathUtils.join(outDir, '04-error-main.png'));
	prefs.set('lastError', '');
	plugin.Sync._setStatus('idle');

	// 3a. Changes waiting for a review
	plugin.Sync.pendingReview = 3;
	plugin.Sync._setStatus('attention');
	await sleep(500);
	await capture(win, PathUtils.join(outDir, '04b-attention-main.png'));
	plugin.Sync.pendingReview = 0;
	plugin.Sync._setStatus('idle');

	// 3b. Review panel, with representative rows (nothing is synced)
	let reviewPromise = plugin.Review.ask({
		repo: 'your-github-username/zotero-library',
		counts: { add: 3, update: 2, delete: 1 },
		incoming: [
			{ path: 'my-library/items/7Q/7QK2M4PA.json', title: 'Deep Residual Learning for Image Recognition', detail: 'changed on GitHub' },
			{ path: 'my-library/items/9X/9XRT2LBN.json', title: 'Mask R-CNN', detail: 'only on GitHub' },
			{ path: 'my-library/attachments/9X/9XRT2LBN/he-2017.pdf', title: 'Mask R-CNN — he-2017.pdf', detail: 'only on GitHub' },
		],
		conflicts: [
			{ path: 'my-library/items/AB/ABCD1234.json', title: 'Attention Is All You Need', detail: 'modified in Zotero 2026-09-12 08:14:02 · on GitHub 2026-09-13 06:40:11', options: ['local', 'server'], choice: 'server' },
			{ path: 'my-library/attachments/WX/WXYZ5678/vaswani-2017.pdf', title: 'Attention Is All You Need — vaswani-2017.pdf', detail: 'the file differs', options: ['local', 'server', 'both'], choice: 'both' },
		],
		overwrite: [
			{ path: 'my-library/notes/D/Deep Learning (QWER5678).md', title: 'Deep Learning (Markdown note)', detail: 'edited on GitHub' },
		],
		restore: [],
		server: [
			{ path: 'my-library/items/BE/BERT0001.json', title: 'BERT: Pre-training of Deep Bidirectional Transformers for Language Understanding', action: 'update' },
			{ path: 'my-library/items/IM/IMGNET01.json', title: 'ImageNet Classification with Deep Convolutional Neural Networks', action: 'update' },
			{ path: 'my-library/items/OL/OLDITEM1.json', title: 'Learning Representations by Back-propagating Errors', action: 'delete' },
		],
	});
	await sleep(1500);
	await capture(win, PathUtils.join(outDir, '07-review-panel.png'));
	plugin.Review.close();
	await reviewPromise;

	// 4. Settings pane, section by section
	Zotero.Utilities.Internal.openPreferences(plugin.prefPaneID);
	let prefWin = await waitFor(() => {
		let w = Services.wm.getMostRecentWindow('zotero:pref');
		return w?.document.getElementById('zotero-github-sync-prefpane') && w;
	}, { label: 'preferences pane', timeout: 45000 });
	prefWin.resizeTo(1100, 820);
	await sleep(2500);
	let pane = prefWin.document.getElementById('zotero-github-sync-prefpane');
	let groups = [...pane.querySelectorAll('groupbox')];
	let scroller = prefWin.document.getElementById('prefs-content') || pane.closest('[scrollable], .main-content') || prefWin.document.scrollingElement;
	// The first four groups cover everything; later ones scroll no further
	for (let i = 0; i < Math.min(groups.length, 4); i++) {
		groups[i].scrollIntoView({ block: 'start' });
		await sleep(700);
		let r = groups[i].getBoundingClientRect();
		rects[`pref-${i}`] = { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) };
		await capture(prefWin, PathUtils.join(outDir, `05-settings-${i + 1}.png`));
	}
	log(`scroller: ${scroller?.id || scroller?.localName}`);
	prefWin.close();

	// 5. Plugins manager (Tools -> Plugins)
	try {
		let before = new Set([...Services.wm.getEnumerator(null)]);
		let menuitem = win.document.getElementById('menu_addons') || win.document.querySelector('[command="cmd_zotero_addons"], #menu_ToolsPopup menuitem[oncommand*="ddons"]');
		if (menuitem) {
			menuitem.doCommand();
		}
		else {
			win.ZoteroStandalone.openAddonsWindow();
		}
		let addonsWin = await waitFor(() => [...Services.wm.getEnumerator(null)].find(w => !before.has(w) && w.document.readyState === 'complete'), { label: 'plugins window', timeout: 20000 });
		log(`plugins window: ${addonsWin.location.href}`);
		addonsWin.resizeTo(1000, 640);
		await sleep(4000);
		await capture(addonsWin, PathUtils.join(outDir, '06-plugins-manager.png'));
		addonsWin.close();
	}
	catch (e) {
		log(`plugins manager skipped: ${e}`);
	}

	await IOUtils.writeJSON(PathUtils.join(outDir, 'rects.json'), rects);
}
