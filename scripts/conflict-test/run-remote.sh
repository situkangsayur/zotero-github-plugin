#!/usr/bin/env bash
# DEVELOPMENT ONLY. Runs on the machine with Zotero. Two throwaway profiles,
# ~/zgs-conflict/A and ~/zgs-conflict/B, take turns syncing one throwaway
# repository; each step is a separate headless Zotero launch. Reports land in
# ~/zgs-conflict/out/<step>.json.
#
# ZGS_BASE_PATH picks a folder in the repository, so the test can run again in
# a fresh folder of the same repository.
#
# Needs: ~/zgs-conflict/zotero-github-sync.xpi, ~/zgs-conflict/zgs-conflict-test.xpi,
# ZGS_OWNER and ZGS_REPO (an EMPTY repository the token can write to), and the
# token in $ZGS_TOKEN_FILE (default ~/.config/zotero-github-sync/token).
set -euo pipefail
T="$HOME/zgs-conflict"
ZOTERO_APP=/usr/lib/zotero
: "${ZGS_OWNER:?}" "${ZGS_REPO:?}"
TOKEN_FILE="${ZGS_TOKEN_FILE:-$HOME/.config/zotero-github-sync/token}"
STEPS="${ZGS_STEPS:-A1 B1 A2 B2 B3 A3}"

run_zotero() { # profile step
	local profile="$1" step="$2"
	systemd-run --user --unit="zgs-conflict-$profile" --collect \
		--setenv=MOZ_HEADLESS=1 --setenv=XDG_RUNTIME_DIR=/run/user/1000 \
		--setenv=ZGS_STEP="$step" --setenv=ZGS_OUT="$T/out" --setenv=ZGS_TOKEN_FILE="$TOKEN_FILE" \
		--setenv=ZGS_OWNER="$ZGS_OWNER" --setenv=ZGS_REPO="$ZGS_REPO" --setenv=ZGS_BASE_PATH="${ZGS_BASE_PATH:-}" \
		bash -c "exec $ZOTERO_APP/zotero-bin -app $ZOTERO_APP/app/application.ini -no-remote -profile '$T/$profile/profile' -ZoteroDebugText >> '$T/$profile/debug.log' 2>&1"
}
stop_zotero() {
	systemctl --user stop "zgs-conflict-$1" 2>/dev/null || true
	for i in $(seq 1 30); do systemctl --user is-active --quiet "zgs-conflict-$1" || return 0; sleep 1; done
}

setup_profile() { # A|B
	local p="$T/$1"
	rm -rf "$p"
	mkdir -p "$p/profile/extensions" "$p/data"
	cat > "$p/profile/user.js" <<PREFS
user_pref("extensions.zotero.dataDir", "$p/data");
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
	cp "$T/zotero-github-sync.xpi" "$p/profile/extensions/zotero-github-sync@situkangsayur.github.io.xpi"
	cp "$T/zgs-conflict-test.xpi" "$p/profile/extensions/zgs-conflict-test@situkangsayur.github.io.xpi"
	run_zotero "$1" ""
	for i in $(seq 1 60); do grep -q zgs-conflict-test "$p/profile/extensions.json" 2>/dev/null && break; sleep 1; done
	sleep 5; stop_zotero "$1"
	sed -i 's/"active":false/"active":true/g; s/"userDisabled":true/"userDisabled":false/g; s/"seen":false/"seen":true/g' "$p/profile/extensions.json"
}

if [ "${ZGS_SETUP:-1}" = 1 ]; then
	rm -rf "$T/out"; mkdir -p "$T/out"
	setup_profile A
	setup_profile B
fi

for step in $STEPS; do
	profile="${step:0:1}"
	rm -f "$T/out/$step.done"
	run_zotero "$profile" "$step"
	for i in $(seq 1 600); do [ -f "$T/out/$step.done" ] && break; sleep 1; done
	sleep 3; stop_zotero "$profile"
	echo "$step: $(cat "$T/out/$step.done" 2>/dev/null || echo timeout)"
	[ "$(cat "$T/out/$step.done" 2>/dev/null)" = ok ] || exit 1
done
