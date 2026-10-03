# herdr-cwd-restore: snapshot live tab working directories after every directory change.
#
# Source this from .bashrc:
#   __herdr_cwd_restore_snapshot_sh=/path/to/herdr-cwd-restore/src/snapshot.sh
#   source /path/to/herdr-cwd-restore/src/shell/herdr-cwd-restore.sh
#
# Bash has no chpwd hook, so this wraps `cd` with a thin function that
# delegates to the builtin and captures only on success. Herdr injects
# HERDR_ENV=1 (plus HERDR_TAB_ID / HERDR_PANE_ID / HERDR_WORKSPACE_ID) into
# every pane's shell, so this fires only inside Herdr panes. The layout is
# rewritten into the single projects/workspace-state.toml (full state across all
# spaces), the mirror of the live layout. The capture runs
# fully detached so the prompt never waits on it.

__herdr_cwd_restore_snapshot() {
  [[ "${HERDR_ENV:-}" == "1" ]] || return 0
  [[ -n "${__herdr_cwd_restore_snapshot_sh:-}" ]] || return 0
  nohup sh "$__herdr_cwd_restore_snapshot_sh" >/dev/null 2>&1 &
  disown 2>/dev/null || true
}

cd() {
  builtin cd "$@" || return
  __herdr_cwd_restore_snapshot
}
