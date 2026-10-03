# herdr-workspace-autosave: auto-save the full workspace layout after every directory change.
#
# Source this from .zshrc:
#   __herdr_workspace_autosave_capture_sh=/path/to/herdr-workspace-autosave/src/capture.sh
#   source /path/to/herdr-workspace-autosave/src/shell/herdr-workspace-autosave.zsh
#
# How it works: Herdr injects HERDR_ENV=1 (plus HERDR_TAB_ID / HERDR_PANE_ID /
# HERDR_WORKSPACE_ID) into every pane's shell, so this fires only inside Herdr
# panes. The layout is rewritten into the single projects/autosave.toml (full
# state across all spaces), the mirror of the live layout. The
# capture runs fully detached (&!) so the prompt never waits on it.

__herdr_workspace_autosave_capture() {
  [[ "${HERDR_ENV:-}" == "1" ]] || return 0
  [[ -n "${__herdr_workspace_autosave_capture_sh:-}" ]] || return 0
  (sh "$__herdr_workspace_autosave_capture_sh" --autosave >/dev/null 2>&1 &!)
}

autoload -Uz add-zsh-hook
add-zsh-hook chpwd __herdr_workspace_autosave_capture
