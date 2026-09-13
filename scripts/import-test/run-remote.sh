#!/usr/bin/env bash
# DEVELOPMENT ONLY. Runs on the machine with Zotero. Creates ~/zgs-import-test
# with an empty profile and data directory, installs the plugin and the import
# test addon, and starts a headless Zotero that runs Import from GitHub and
# writes ~/zgs-import-test/out/{report.json,DONE}. Returns once the import is
# running; poll for DONE. Never touches the real profile.
#
# Needs: ~/zgs-import-test/zotero-github-sync.xpi, ~/zgs-import-test/zgs-import-test.xpi,
# and the token in $ZGS_TOKEN_FILE (default ~/.config/zotero-github-sync/token).
set -euo pipefail
T="$HOME/zgs-import-test"
ZOTERO_APP=/usr/lib/zotero
: "${ZGS_OWNER:?}" "${ZGS_REPO:?}"
TOKEN_FILE="${ZGS_TOKEN_FILE:-$HOME/.config/zotero-github-sync/token}"

systemctl --user stop zgs-import-test 2>/dev/null || true
rm -rf "$T/profile" "$T/data" "$T/out"
mkdir -p "$T/profile/extensions" "$T/data" "$T/out"
cat > "$T/profile/user.js" <<PREFS
user_pref("extensions.zotero.dataDir", "$T/data");
user_pref("extensions.zotero.useDataDir", true);
user_pref("extensions.zotero.httpServer.enabled", false);
user_pref("extensions.zotero.sync.autoSync", false);
user_pref("extensions.zotero.sync.reminder.setUp.enabled", false);
user_pref("extensions.zotero.sync.reminder.autoSync.enabled", false);
user_pref("extensions.zotero.firstRun2", false);
user_pref("extensions.zotero.integration.autoInstall", false);
user_pref("extensions.zotero.automaticScraperUpdates", false);
user_pref("app.update.enabled", false);
PREFS
cp "$T/zotero-github-sync.xpi" "$T/profile/extensions/zotero-github-sync@situkangsayur.github.io.xpi"
cp "$T/zgs-import-test.xpi" "$T/profile/extensions/zgs-import-test@situkangsayur.github.io.xpi"

start() {
	systemd-run --user --unit=zgs-import-test --collect \
		--setenv=MOZ_HEADLESS=1 --setenv=XDG_RUNTIME_DIR=/run/user/1000 \
		--setenv=ZGS_IMPORT_TEST_DIR="$1" --setenv=ZGS_TOKEN_FILE="$TOKEN_FILE" \
		--setenv=ZGS_OWNER="$ZGS_OWNER" --setenv=ZGS_REPO="$ZGS_REPO" \
		--setenv=ZGS_BRANCH="${ZGS_BRANCH:-main}" --setenv=ZGS_BASE_PATH="${ZGS_BASE_PATH:-}" \
		bash -c "exec $ZOTERO_APP/zotero-bin -app $ZOTERO_APP/app/application.ini -no-remote -profile '$T/profile' -ZoteroDebugText > '$T/debug.log' 2>&1"
}
stop() {
	systemctl --user stop zgs-import-test 2>/dev/null || true
	for i in $(seq 1 30); do systemctl --user is-active --quiet zgs-import-test || return 0; sleep 1; done
}

start ""
for i in $(seq 1 60); do grep -q zgs-import-test "$T/profile/extensions.json" 2>/dev/null && break; sleep 1; done
sleep 5; stop
sed -i 's/"active":false/"active":true/g; s/"userDisabled":true/"userDisabled":false/g; s/"seen":false/"seen":true/g' "$T/profile/extensions.json"
start "$T/out"
echo "import test started"
