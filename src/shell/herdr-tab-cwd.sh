# herdr-tab-cwd: auto-save the full workspace layout after every directory change.
#
# Source this from .bashrc:
#   __herdr_tab_cwd_capture_sh=/path/to/herdr-tab-cwd/src/capture.sh
#   source /path/to/herdr-tab-cwd/src/shell/herdr-tab-cwd.sh
#
# Bash has no chpwd hook, so this wraps `cd` with a thin function that
# delegates to the builtin and captures only on success. Herdr injects
# HERDR_ENV=1 (plus HERDR_TAB_ID / HERDR_PANE_ID / HERDR_WORKSPACE_ID) into
# every pane's shell, so this fires only inside Herdr panes. The layout is
# rewritten into the single projects/autosave.toml (full state across all
# spaces), the mirror of the live layout. The capture runs
# fully detached so the prompt never waits on it.

__herdr_tab_cwd_capture() {
  [[ "${HERDR_ENV:-}" == "1" ]] || return 0
  [[ -n "${__herdr_tab_cwd_capture_sh:-}" ]] || return 0
  nohup sh "$__herdr_tab_cwd_capture_sh" --autosave >/dev/null 2>&1 &
  disown 2>/dev/null || true
}

cd() {
  builtin cd "$@" || return
  __herdr_tab_cwd_capture
}
