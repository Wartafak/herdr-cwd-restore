# herdr-cwd-restore: snapshot live tab working directories after every directory change.
#
# Source this from .zshrc:
#   __herdr_cwd_restore_snapshot_sh=/path/to/herdr-cwd-restore/src/snapshot.sh
#   source /path/to/herdr-cwd-restore/src/shell/herdr-cwd-restore.zsh
#
# How it works: Herdr injects HERDR_ENV=1 (plus HERDR_TAB_ID / HERDR_PANE_ID /
# HERDR_WORKSPACE_ID) into every pane's shell, so this fires only inside Herdr
# panes. The layout is rewritten into the single projects/workspace-state.toml (full
# state across all spaces), the mirror of the live layout. The
# capture runs fully detached (&!) so the prompt never waits on it.

__herdr_cwd_restore_snapshot() {
  [[ "${HERDR_ENV:-}" == "1" ]] || return 0
  [[ -n "${__herdr_cwd_restore_snapshot_sh:-}" ]] || return 0
  (sh "$__herdr_cwd_restore_snapshot_sh" >/dev/null 2>&1 &!)
}

autoload -Uz add-zsh-hook
add-zsh-hook chpwd __herdr_cwd_restore_snapshot
