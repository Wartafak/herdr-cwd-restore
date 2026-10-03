# herdr-tab-cwd: auto-save the full workspace layout after every directory change.
#
# Source this from config.fish:
#   set -g __herdr_tab_cwd_capture_sh /path/to/herdr-tab-cwd/src/capture.sh
#   source /path/to/herdr-tab-cwd/src/shell/herdr-tab-cwd.fish
#
# How it works: Herdr injects HERDR_ENV=1 (plus HERDR_TAB_ID / HERDR_PANE_ID /
# HERDR_WORKSPACE_ID) into every pane's shell, so this fires only inside Herdr
# panes. The layout is rewritten into the single projects/autosave.toml (full
# state across all spaces), the mirror of the live layout. The
# capture runs fully detached so the prompt never waits on it.

function __herdr_tab_cwd_capture --on-variable PWD --description "herdr-tab-cwd autosave on cd"
    test "$HERDR_ENV" = 1; or return 0
    test -n "$__herdr_tab_cwd_capture_sh"; or return 0
    sh $__herdr_tab_cwd_capture_sh --autosave >/dev/null 2>&1 &
end
