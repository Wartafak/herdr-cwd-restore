# herdr-tab-cwd: snapshot Herdr tab cwds after every directory change.
#
# Source this from .bashrc:
#   __herdr_tab_cwd_snapshot_sh=/path/to/herdr-tab-cwd/src/snapshot.sh
#   source /path/to/herdr-tab-cwd/src/shell/herdr-tab-cwd.sh
#
# Optional: override where the snapshot is written (defaults to this
# plugin's config.toml under ~/.config):
#   __herdr_tab_cwd_snapshot_out=/custom/path/config.toml
#
# Bash has no chpwd hook, so this wraps `cd` with a thin function that
# delegates to the builtin and snapshots only on success. Herdr injects
# HERDR_ENV=1 (plus HERDR_TAB_ID / HERDR_PANE_ID / HERDR_WORKSPACE_ID) into
# every pane's shell, so this fires only inside Herdr panes. Note
# HERDR_PLUGIN_CONFIG_DIR is *not* set in interactive panes (only in plugin
# hook processes), hence the explicit --out below. The snapshot runs fully
# detached so the prompt never waits on it; mirroring is idempotent and writes
# config.toml only on change.

__herdr_tab_cwd_snapshot() {
  [[ "${HERDR_ENV:-}" == "1" ]] || return 0
  [[ -n "${__herdr_tab_cwd_snapshot_sh:-}" ]] || return 0
  local out="${__herdr_tab_cwd_snapshot_out:-$HOME/.config/herdr/plugins/config/herdr-tab-cwd/config.toml}"
  nohup sh "$__herdr_tab_cwd_snapshot_sh" --out "$out" >/dev/null 2>&1 &
  disown 2>/dev/null || true
}

cd() {
  builtin cd "$@" || return
  __herdr_tab_cwd_snapshot
}
