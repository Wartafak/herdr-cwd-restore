# herdr-cwd-restore: snapshot live tab working directories after every directory change.
#
# Source this from config.fish:
#   set -g __herdr_cwd_restore_snapshot_sh /path/to/herdr-cwd-restore/src/snapshot.sh
#   source /path/to/herdr-cwd-restore/src/shell/herdr-cwd-restore.fish
#
# How it works: Herdr injects HERDR_ENV=1 (plus HERDR_TAB_ID / HERDR_PANE_ID /
# HERDR_WORKSPACE_ID) into every pane's shell, so this fires only inside Herdr
# panes. The layout is rewritten into the single projects/workspace-state.toml (full
# state across all spaces), the mirror of the live layout. The
# capture runs fully detached so the prompt never waits on it.

function __herdr_cwd_restore_snapshot --on-variable PWD --description "herdr-cwd-restore snapshot on cd"
    test "$HERDR_ENV" = 1; or return 0
    test -n "$__herdr_cwd_restore_snapshot_sh"; or return 0
    sh $__herdr_cwd_restore_snapshot_sh >/dev/null 2>&1 &
end
