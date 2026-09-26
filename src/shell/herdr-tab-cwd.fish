# herdr-tab-cwd: snapshot Herdr tab cwds after every directory change.
#
# Source this from config.fish:
#   set -g __herdr_tab_cwd_snapshot_sh /path/to/herdr-tab-cwd/src/snapshot.sh
#   source /path/to/herdr-tab-cwd/src/shell/herdr-tab-cwd.fish
#
# Optional: override where the snapshot is written (defaults to this
# plugin's config.toml under ~/.config):
#   set -g __herdr_tab_cwd_snapshot_out /custom/path/config.toml
#
# How it works: Herdr injects HERDR_ENV=1 (plus HERDR_TAB_ID / HERDR_PANE_ID /
# HERDR_WORKSPACE_ID) into every pane's shell, so this fires only inside Herdr
# panes. Note HERDR_PLUGIN_CONFIG_DIR is *not* set in interactive panes (only
# in plugin hook processes), hence the explicit --out below. The snapshot runs
# fully detached so the prompt never waits on it; mirroring is idempotent and
# writes config.toml only on change.

function __herdr_tab_cwd_snapshot --on-variable PWD --description "herdr-tab-cwd snapshot on cd"
    test "$HERDR_ENV" = 1; or return 0
    test -n "$__herdr_tab_cwd_snapshot_sh"; or return 0
    set -l snapshot_out $__herdr_tab_cwd_snapshot_out
    test -n "$snapshot_out"; or set snapshot_out $HOME/.config/herdr/plugins/config/herdr-tab-cwd/config.toml
    sh $__herdr_tab_cwd_snapshot_sh --out "$snapshot_out" >/dev/null 2>&1 &
end
