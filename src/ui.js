/* Zotero GitHub Sync -- menus, toolbar button and status feedback
 *
 * Everything added to a window is recorded so removeFromWindow() can take it all
 * back out again when the plugin is disabled or upgraded, which Zotero requires
 * of bootstrapped plugins.
 */

ZoteroGitHubSync.UI = {
	// window -> Element[] we created
	_added: new WeakMap(),
	_windows: new Set(),


	addToWindow(win) {
		if (this._added.has(win)) {
			return;
		}
		let elements = [];
		this._added.set(win, elements);
		this._windows.add(win);

		try {
			this._addToolbarButton(win, elements);
			this._addToolsMenu(win, elements);
			this._addItemContextMenu(win, elements);
			this._addCollectionContextMenu(win, elements);
		}
		catch (e) {
			ZoteroGitHubSync.logError(e);
		}
		this.onStatusChange(ZoteroGitHubSync.Sync.status);
	},


	removeFromWindow(win) {
		let elements = this._added.get(win);
		if (elements) {
			for (let element of elements) {
				element.remove();
			}
			this._added.delete(win);
		}
		this._windows.delete(win);
	},


	/**
	 * Reflect sync state on every open window's toolbar button.
	 *
	 * @param {String} status - idle | syncing | error
	 */
	onStatusChange(status) {
		for (let win of this._windows) {
			let button = win.document?.getElementById('zotero-github-sync-button');
			if (!button) {
				continue;
			}
			button.setAttribute('tooltiptext', ZoteroGitHubSync.getString(
				status === 'syncing' ? 'toolbar.tooltipSyncing' : 'toolbar.tooltip'
			));
			// The main window has no stylesheet of ours, so show state inline
			button.style.opacity = status === 'syncing' ? '0.5' : '';
			button.classList.toggle('zgs-syncing', status === 'syncing');
			button.classList.toggle('zgs-error', status === 'error');
		}
	},


	// -- Builders ----------------------------------------------------------

	_addToolbarButton(win, elements) {
		let doc = win.document;
		let toolbar = doc.getElementById('zotero-items-toolbar');
		if (!toolbar) {
			return;
		}

		let button = doc.createXULElement('toolbarbutton');
		button.id = 'zotero-github-sync-button';
		button.className = 'zotero-tb-button';
		button.setAttribute('type', 'menu-button');
		button.setAttribute('tabindex', '-1');
		button.setAttribute('tooltiptext', ZoteroGitHubSync.getString('toolbar.tooltip'));
		button.style.listStyleImage = `url("${ZoteroGitHubSync.rootURI}content/icons/github-20.svg")`;
		button.addEventListener('command', (event) => {
			// The dropdown fires its own commands; only the button half syncs
			if (event.target === button) {
				ZoteroGitHubSync.Sync.syncNow({ trigger: 'button' })
					.catch(e => ZoteroGitHubSync.logError(e));
			}
		});

		let popup = doc.createXULElement('menupopup');
		for (let entry of this._menuEntries(win)) {
			popup.append(this._createMenuItem(doc, entry));
		}
		button.append(popup);

		// Sit next to the search box at the end of the item toolbar
		toolbar.append(button);
		elements.push(button);
	},


	_addToolsMenu(win, elements) {
		let doc = win.document;
		let toolsPopup = doc.getElementById('menu_ToolsPopup');
		if (!toolsPopup) {
			return;
		}

		let menu = doc.createXULElement('menu');
		menu.id = 'zotero-github-sync-tools-menu';
		menu.setAttribute('label', ZoteroGitHubSync.getString('menu.root'));

		let popup = doc.createXULElement('menupopup');
		for (let entry of this._menuEntries(win)) {
			popup.append(this._createMenuItem(doc, entry));
		}
		menu.append(popup);
		toolsPopup.append(menu);
		elements.push(menu);
	},


	_addItemContextMenu(win, elements) {
		let doc = win.document;
		let itemMenu = doc.getElementById('zotero-itemmenu');
		if (!itemMenu) {
			return;
		}

		let separator = doc.createXULElement('menuseparator');
		separator.id = 'zotero-github-sync-item-separator';

		let menuitem = doc.createXULElement('menuitem');
		menuitem.id = 'zotero-github-sync-item-menuitem';
		menuitem.setAttribute('label', ZoteroGitHubSync.getString('menu.syncSelected'));
		menuitem.addEventListener('command', () => this._syncSelectedItems(win));

		// ZoteroPane rebuilds this menu by index, so appended items survive, but
		// their visibility is ours to manage
		let onPopupShowing = () => {
			let selected = this._getSelectedItems(win);
			let visible = ZoteroGitHubSync.Prefs.hasRepoConfig() && selected.length > 0;
			separator.hidden = !visible;
			menuitem.hidden = !visible;
		};
		itemMenu.addEventListener('popupshowing', onPopupShowing);
		elements.push({
			remove: () => {
				itemMenu.removeEventListener('popupshowing', onPopupShowing);
				separator.remove();
				menuitem.remove();
			},
		});

		itemMenu.append(separator, menuitem);
	},


	_addCollectionContextMenu(win, elements) {
		let doc = win.document;
		let collectionMenu = doc.getElementById('zotero-collectionmenu');
		if (!collectionMenu) {
			return;
		}

		let menuitem = doc.createXULElement('menuitem');
		menuitem.id = 'zotero-github-sync-collection-menuitem';
		menuitem.setAttribute('label', ZoteroGitHubSync.getString('menu.syncCollection'));
		menuitem.addEventListener('command', () => this._syncSelectedCollection(win));

		let onPopupShowing = () => {
			let collection = win.ZoteroPane?.getSelectedCollection?.();
			menuitem.hidden = !(collection && ZoteroGitHubSync.Prefs.hasRepoConfig());
		};
		collectionMenu.addEventListener('popupshowing', onPopupShowing);
		elements.push({
			remove: () => {
				collectionMenu.removeEventListener('popupshowing', onPopupShowing);
				menuitem.remove();
			},
		});

		collectionMenu.append(menuitem);
	},


	/**
	 * The entries shared by the Tools menu and the toolbar dropdown.
	 */
	_menuEntries(win) {
		return [
			{
				id: 'sync-now',
				label: ZoteroGitHubSync.getString('menu.syncNow'),
				command: () => ZoteroGitHubSync.Sync.syncNow({ trigger: 'menu' })
					.catch(e => ZoteroGitHubSync.logError(e)),
			},
			{
				id: 'sync-selected',
				label: ZoteroGitHubSync.getString('menu.syncSelected'),
				command: () => this._syncSelectedItems(win),
			},
			{
				id: 'pull',
				label: ZoteroGitHubSync.getString('menu.pull'),
				command: () => ZoteroGitHubSync.Sync.pull()
					.catch(e => ZoteroGitHubSync.logError(e)),
			},
			{ id: 'separator', separator: true },
			{
				id: 'open-repo',
				label: ZoteroGitHubSync.getString('menu.openRepo'),
				command: () => {
					let url = ZoteroGitHubSync.Prefs.getRepoURL();
					if (url) {
						Zotero.launchURL(url);
					}
				},
			},
			{
				id: 'settings',
				label: ZoteroGitHubSync.getString('menu.settings'),
				command: () => this._openPreferences(),
			},
		];
	},


	_createMenuItem(doc, entry) {
		if (entry.separator) {
			return doc.createXULElement('menuseparator');
		}
		let menuitem = doc.createXULElement('menuitem');
		menuitem.setAttribute('label', entry.label);
		menuitem.addEventListener('command', entry.command);
		return menuitem;
	},


	// -- Actions -----------------------------------------------------------

	_getSelectedItems(win) {
		try {
			let items = win.ZoteroPane?.getSelectedItems?.() || [];
			// Syncing a note or attachment on its own has no meaning here; the
			// exporter writes children alongside their parent
			return items
				.map(item => (item.isTopLevelItem() ? item : item.parentItem))
				.filter((item, index, all) => item && all.indexOf(item) === index);
		}
		catch (e) {
			ZoteroGitHubSync.logError(e);
			return [];
		}
	},


	_syncSelectedItems(win) {
		let items = this._getSelectedItems(win);
		ZoteroGitHubSync.Sync.syncNow({ trigger: 'selection', items })
			.catch(e => ZoteroGitHubSync.logError(e));
	},


	async _syncSelectedCollection(win) {
		try {
			let collection = win.ZoteroPane?.getSelectedCollection?.();
			if (!collection) {
				return;
			}
			let items = collection.getChildItems(false, false) || [];
			// Include everything filed under subcollections too, which is what
			// "sync this collection" means to anyone looking at the tree
			for (let child of collection.getDescendents(false, 'collection') || []) {
				let subcollection = Zotero.Collections.get(child.id);
				if (subcollection) {
					items.push(...(subcollection.getChildItems(false, false) || []));
				}
			}
			let unique = items.filter((item, index) => items.indexOf(item) === index);
			await ZoteroGitHubSync.Sync.syncNow({ trigger: 'collection', items: unique });
		}
		catch (e) {
			ZoteroGitHubSync.logError(e);
		}
	},


	_openPreferences() {
		try {
			Zotero.Utilities.Internal.openPreferences(ZoteroGitHubSync.prefPaneID);
		}
		catch (e) {
			ZoteroGitHubSync.logError(e);
		}
	},
};
