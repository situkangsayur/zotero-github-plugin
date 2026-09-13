/* Zotero GitHub Sync -- two-computer sync test
 *
 * DEVELOPMENT ONLY. Two throwaway profiles, A and B, take turns syncing the same
 * throwaway repository (see scripts/conflict-test/run-remote.sh). Each Zotero
 * launch runs one step, named by ZGS_STEP, then writes ZGS_OUT/<step>.json and
 * quits. The review panel is replaced by a scripted chooser, so the decisions a
 * person would click are made the same way every run.
 *
 * Steps, in order:
 *   A1  A creates a small library and syncs into the empty repository
 *   B1  B starts empty and syncs: everything arrives as incoming, accepted
 *   A2  A retitles BERT, trashes Deep Learning, adds Mask R-CNN, syncs
 *   B2  B, still behind, retitles BERT differently and adds a note to
 *       Attention, then runs a background sync: its own safe change must go
 *       up, nothing of A's may be deleted or overwritten
 *   B3  B syncs with a review: BERT takes GitHub's version, Mask R-CNN is
 *       imported, Deep Learning (deleted on GitHub) is not uploaded again
 *   A3  A syncs with a review and accepts B's note
 */

var log = msg => Zotero.debug(`[ZGS two-computer test] ${msg}`);
var sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function install() {}
function uninstall() {}
function shutdown() {}

async function startup() {
	await Zotero.initializationPromise;
	let step = Services.env.get('ZGS_STEP');
	let outDir = Services.env.get('ZGS_OUT');
	if (!step || !outDir) {
		return;
	}
	let report = { step };
	try {
		await run(step, report);
		report.ok = true;
	}
	catch (e) {
		Zotero.logError(e);
		report.ok = false;
		report.error = `${e}\n${e.stack}`;
	}
	await IOUtils.writeJSON(PathUtils.join(outDir, `${step}.json`), report);
	await IOUtils.writeUTF8(PathUtils.join(outDir, `${step}.done`), report.ok ? 'ok\n' : 'error\n');
	setTimeout(() => Zotero.Utilities.Internal.quit(), 2000);
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


function libraryID() {
	return Zotero.Libraries.userLibraryID;
}

async function items() {
	return (await Zotero.Items.getAll(libraryID(), true, false)).filter(i => !i.deleted && i.isTopLevelItem() && !i.isAnnotation());
}

async function byTitle(prefix) {
	return (await items()).find(i => (i.getField('title') || '').startsWith(prefix));
}

async function addItem(type, title, fields = {}) {
	let item = new Zotero.Item(type);
	item.libraryID = libraryID();
	item.setField('title', title);
	for (let [field, value] of Object.entries(fields)) {
		item.setField(field, value);
	}
	await item.saveTx();
	return item;
}


async function createLibrary() {
	let attention = await addItem('conferencePaper', 'Attention Is All You Need', { date: '2017' });
	await addItem('journalArticle', 'BERT: Pre-training of Deep Bidirectional Transformers', { date: '2019' });
	await addItem('conferencePaper', 'Deep Residual Learning for Image Recognition', { date: '2016' });
	await addItem('journalArticle', 'ImageNet Classification with Deep Convolutional Neural Networks', { date: '2017' });
	await addItem('book', 'Deep Learning', { date: '2016' });

	let dir = PathUtils.join(Zotero.getTempDirectory().path, 'zgs-two-computer');
	await IOUtils.makeDirectory(dir, { ignoreExisting: true });
	let path = PathUtils.join(dir, 'vaswani-2017.pdf');
	await IOUtils.writeUTF8(path, MINIMAL_PDF);
	let attachment = await Zotero.Attachments.importFromFile({ file: path, parentItemID: attention.id, title: 'Full Text PDF' });
	await Zotero.Annotations.saveFromJSON(attachment, {
		key: Zotero.DataObjectUtilities.generateKey(),
		type: 'highlight',
		text: 'Attention Is All You Need',
		comment: 'Thesis',
		color: '#ffd400',
		pageLabel: '1',
		sortIndex: '00000|000700|00072',
		position: { pageIndex: 0, rects: [[72, 700, 360, 724]] },
	});
}


/**
 * Stand in for the review panel. `script` picks, per row, what a person would.
 */
function scriptReview(plugin, report, script = {}) {
	plugin.Review.ask = async (review) => {
		report.review = {
			incoming: review.incoming.map(r => r.title),
			conflicts: review.conflicts.map(r => ({ title: r.title, options: r.options, default: r.choice })),
			overwrite: review.overwrite.map(r => r.title),
			restore: review.restore.map(r => r.title),
			server: review.server.map(r => `${r.action}: ${r.title}`),
			counts: review.counts,
		};
		let checks = { incoming: new Map(), overwrite: new Map(), restore: new Map(), server: new Map() };
		let choices = new Map();
		for (let row of review.incoming) {
			checks.incoming.set(row.path, script.accept ? script.accept(row) : true);
		}
		for (let row of review.conflicts) {
			choices.set(row.path, script.choose ? script.choose(row) : row.choice);
		}
		for (let row of review.overwrite) {
			checks.overwrite.set(row.path, true);
		}
		for (let row of review.restore) {
			checks.restore.set(row.path, script.restore ? script.restore(row) : true);
		}
		for (let row of review.server) {
			checks.server.set(row.path, true);
		}
		return plugin.Review._decisions(review, checks, choices);
	};
}


async function snapshot(plugin, config, token) {
	let lib = [];
	for (let item of await items()) {
		lib.push({
			title: item.getField('title'),
			key: item.key,
			notes: item.isRegularItem() ? item.getNotes(false).length : 0,
			attachments: item.isRegularItem() ? item.getAttachments(false).length : 0,
		});
	}
	lib.sort((a, b) => (a.title < b.title ? -1 : 1));

	let client = new plugin.GitHub({ token, apiURL: config.apiURL, owner: config.owner, repo: config.repo });
	let head = await client.getBranchHead(config.branch);
	let repo = { head, items: [], files: [] };
	if (head) {
		let tree = await client.listTree((await client.getCommit(head)).tree.sha);
		let prefix = config.basePath ? `${config.basePath}/` : '';
		for (let [path, entry] of tree) {
			if (prefix && !path.startsWith(prefix)) {
				continue;
			}
			let item = path.match(/\/items\/[A-Z0-9]{2}\/([A-Z0-9]{8})\.json$/);
			if (item) {
				let record = JSON.parse(await client.getBlobText(entry.sha));
				repo.items.push({
					title: record.zotero.title,
					key: item[1],
					children: (record.children || []).map(c => c.itemType).sort(),
				});
			}
			else if (/\/attachments(-lfs)?\//.test(path)) {
				repo.files.push(path.replace(/^.*\/attachments/, 'attachments'));
			}
		}
		repo.items.sort((a, b) => (a.title < b.title ? -1 : 1));
	}
	let state = await plugin.State.load(config);
	return { library: lib, repo, basePaths: state ? state.base.size : 0 };
}


async function run(step, report) {
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
	await Zotero.Libraries.userLibrary.waitForDataLoad('item');

	let env = name => Services.env.get(name);
	let token = (await IOUtils.readUTF8(env('ZGS_TOKEN_FILE'))).trim();
	plugin.Prefs.set('owner', env('ZGS_OWNER'));
	plugin.Prefs.set('repo', env('ZGS_REPO'));
	plugin.Prefs.set('branch', 'main');
	plugin.Prefs.set('basePath', env('ZGS_BASE_PATH') || '');
	plugin.Prefs.set('autoCreateRepo', false);
	plugin.Prefs.set('includeGroupLibraries', false);
	await plugin.Prefs.setToken(token);
	let config = plugin.Prefs.getConfig();

	let sync = async (options) => {
		let result = await plugin.Sync.syncNow({ trigger: `test-${step}`, ...options });
		report.result = result;
		log(`${step}: ${JSON.stringify(result)}`);
		if (result.status === 'error') {
			throw new Error(result.error);
		}
		return result;
	};

	switch (step) {
		case 'A1':
			await createLibrary();
			await sync({});
			break;

		case 'B1':
			scriptReview(plugin, report);
			await sync({});
			break;

		case 'A2': {
			let bert = await byTitle('BERT');
			bert.setField('title', 'BERT: Pre-training of Deep Bidirectional Transformers (A revised)');
			await bert.saveTx();
			let book = await byTitle('Deep Learning');
			book.deleted = true;
			await book.saveTx();
			await addItem('conferencePaper', 'Mask R-CNN', { date: '2017' });
			scriptReview(plugin, report);
			await sync({});
			break;
		}

		case 'B2': {
			let bert = await byTitle('BERT');
			bert.setField('title', 'BERT: Pre-training of Deep Bidirectional Transformers (B edit)');
			await bert.saveTx();
			let attention = await byTitle('Attention');
			let note = new Zotero.Item('note');
			note.libraryID = libraryID();
			note.parentID = attention.id;
			note.setNote('<p>Note written on computer B</p>');
			await note.saveTx();
			plugin.Review.ask = async () => {
				throw new Error('A background sync must not open the review');
			};
			await sync({ silent: true });
			break;
		}

		case 'B3':
			scriptReview(plugin, report, {
				choose: row => (row.title.startsWith('BERT') ? 'server' : row.choice),
				restore: () => false,
			});
			await sync({});
			break;

		case 'A3':
			scriptReview(plugin, report);
			await sync({});
			break;

		default:
			throw new Error(`Unknown step ${step}`);
	}

	report.after = await snapshot(plugin, config, token);
}
