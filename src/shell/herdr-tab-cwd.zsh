# herdr-tab-cwd: snapshot Herdr tab cwds after every directory change.
#
# Source this from .zshrc:
#   __herdr_tab_cwd_snapshot_sh=/path/to/herdr-tab-cwd/src/snapshot.sh
#   source /path/to/herdr-tab-cwd/src/shell/herdr-tab-cwd.zsh
#
# Optional: override where the snapshot is written (defaults to this
# plugin's config.toml under ~/.config):
#   __herdr_tab_cwd_snapshot_out=/custom/path/config.toml
#
# How it works: Herdr injects HERDR_ENV=1 (plus HERDR_TAB_ID / HERDR_PANE_ID /
# HERDR_WORKSPACE_ID) into every pane's shell, so this fires only inside Herdr
# panes. Note HERDR_PLUGIN_CONFIG_DIR is *not* set in interactive panes (only
# in plugin hook processes), hence the explicit --out below. The snapshot runs
# fully detached (&!) so the prompt never waits on it; mirroring is idempotent
# and writes config.toml only on change.

__herdr_tab_cwd_snapshot() {
  [[ "${HERDR_ENV:-}" == "1" ]] || return 0
  [[ -n "${__herdr_tab_cwd_snapshot_sh:-}" ]] || return 0
  local out="${__herdr_tab_cwd_snapshot_out:-$HOME/.config/herdr/plugins/config/herdr-tab-cwd/config.toml}"
  (sh "$__herdr_tab_cwd_snapshot_sh" --out "$out" >/dev/null 2>&1 &!)
}

autoload -Uz add-zsh-hook
add-zsh-hook chpwd __herdr_tab_cwd_snapshot
