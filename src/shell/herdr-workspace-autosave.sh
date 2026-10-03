# herdr-workspace-autosave: auto-save the full workspace layout after every directory change.
#
# Source this from .bashrc:
#   __herdr_workspace_autosave_capture_sh=/path/to/herdr-workspace-autosave/src/snapshot.sh
#   source /path/to/herdr-workspace-autosave/src/shell/herdr-workspace-autosave.sh
#
# Bash has no chpwd hook, so this wraps `cd` with a thin function that
# delegates to the builtin and captures only on success. Herdr injects
# HERDR_ENV=1 (plus HERDR_TAB_ID / HERDR_PANE_ID / HERDR_WORKSPACE_ID) into
# every pane's shell, so this fires only inside Herdr panes. The layout is
# rewritten into the single projects/workspace-state.toml (full state across all
# spaces), the mirror of the live layout. The capture runs
# fully detached so the prompt never waits on it.

__herdr_workspace_autosave_capture() {
  [[ "${HERDR_ENV:-}" == "1" ]] || return 0
  [[ -n "${__herdr_workspace_autosave_capture_sh:-}" ]] || return 0
  nohup sh "$__herdr_workspace_autosave_capture_sh" --autosave >/dev/null 2>&1 &
  disown 2>/dev/null || true
}

cd() {
  builtin cd "$@" || return
  __herdr_workspace_autosave_capture
}
