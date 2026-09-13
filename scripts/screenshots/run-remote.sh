#!/usr/bin/env bash
# DEVELOPMENT ONLY. Runs on the machine with Zotero: creates a throwaway profile
# and data directory under ~/zgs-demo, installs the plugin and the screenshot
# scenario addon, runs Zotero headless until the scenario writes DONE, and
# leaves the PNGs in ~/zgs-demo/shots. Never touches the real profile.
set -euo pipefail
D="$HOME/zgs-demo"
ZOTERO_APP=/usr/lib/zotero
systemctl --user stop zgs-demo 2>/dev/null || true
rm -rf "$D/profile" "$D/data" "$D/shots"
mkdir -p "$D/profile/extensions" "$D/data" "$D/shots"
cat > "$D/profile/user.js" <<PREFS
user_pref("extensions.zotero.dataDir", "$D/data");
user_pref("extensions.zotero.useDataDir", true);
user_pref("extensions.zotero.httpServer.enabled", false);
user_pref("extensions.zotero.sync.autoSync", false);
user_pref("extensions.zotero.sync.reminder.setUp.enabled", false);
user_pref("extensions.zotero.sync.reminder.autoSync.enabled", false);
user_pref("extensions.zotero.firstRun2", false);
user_pref("extensions.zotero.firstRunGuidance", false);
user_pref("extensions.zotero.integration.autoInstall", false);
user_pref("extensions.zotero.automaticScraperUpdates", false);
user_pref("app.update.enabled", false);
user_pref("intl.locale.requested", "en-US");
user_pref("datareporting.policy.dataSubmissionEnabled", false);
PREFS
cp "$D/zotero-github-sync.xpi" "$D/profile/extensions/zotero-github-sync@situkangsayur.github.io.xpi"
cp "$D/zgs-screenshots.xpi" "$D/profile/extensions/zgs-screenshots@situkangsayur.github.io.xpi"

start() {
	systemd-run --user --unit=zgs-demo --collect \
		--setenv=MOZ_HEADLESS=1 --setenv=MOZ_HEADLESS_WIDTH=1440 --setenv=MOZ_HEADLESS_HEIGHT=900 \
		--setenv=XDG_RUNTIME_DIR=/run/user/1000 --setenv=ZGS_SHOTS_DIR="$1" \
		bash -c "exec $ZOTERO_APP/zotero-bin -app $ZOTERO_APP/app/application.ini -no-remote -profile '$D/profile' -ZoteroDebugText > '$D/debug.log' 2>&1"
}
stop() {
	systemctl --user stop zgs-demo 2>/dev/null || true
	for i in $(seq 1 30); do systemctl --user is-active --quiet zgs-demo || return 0; sleep 1; done
}

# First run registers the addons (disabled, as sideloads are)
start ""
for i in $(seq 1 60); do grep -q zgs-screenshots "$D/profile/extensions.json" 2>/dev/null && break; sleep 1; done
sleep 5; stop
sed -i 's/"active":false/"active":true/g; s/"userDisabled":true/"userDisabled":false/g; s/"seen":false/"seen":true/g' "$D/profile/extensions.json"

# Second run takes the screenshots
start "$D/shots"
for i in $(seq 1 240); do [ -f "$D/shots/DONE" ] && break; sleep 1; done
sleep 3; stop
cat "$D/shots/DONE" 2>/dev/null || { echo "no DONE marker"; grep -n 'ZGS screenshots\|GitHub Sync\]' "$D/debug.log" | tail -20; exit 1; }
grep -n 'ZGS screenshots' "$D/debug.log" | tail -20
ls -la "$D/shots"
