# herdr-workspace-autosave: auto-save the full workspace layout after every directory change.
#
# Source this from config.fish:
#   set -g __herdr_workspace_autosave_capture_sh /path/to/herdr-workspace-autosave/src/snapshot.sh
#   source /path/to/herdr-workspace-autosave/src/shell/herdr-workspace-autosave.fish
#
# How it works: Herdr injects HERDR_ENV=1 (plus HERDR_TAB_ID / HERDR_PANE_ID /
# HERDR_WORKSPACE_ID) into every pane's shell, so this fires only inside Herdr
# panes. The layout is rewritten into the single projects/workspace-state.toml (full
# state across all spaces), the mirror of the live layout. The
# capture runs fully detached so the prompt never waits on it.

function __herdr_workspace_autosave_capture --on-variable PWD --description "herdr-workspace-autosave autosave on cd"
    test "$HERDR_ENV" = 1; or return 0
    test -n "$__herdr_workspace_autosave_capture_sh"; or return 0
    sh $__herdr_workspace_autosave_capture_sh --autosave >/dev/null 2>&1 &
end
