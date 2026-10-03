#!/bin/sh
# Finds a Node 18+ interpreter and execs snapshot.js.
# Same rationale as the other wrappers: the herdr *server* process's PATH can differ
# from the interactive shell's, so search a candidate list of interpreter
# names/paths, plus nvm install dirs, and run the first Node 18+ one found.
# With no arguments this snapshots the live tab state into the single
# `$HERDR_PLUGIN_CONFIG_DIR/projects/workspace-state.toml`; `--stdout`
# previews without writing. Any other arguments are rejected by snapshot.js.
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
# SNAPSHOT_SH_NODE_CANDIDATES overrides the search list; used by tests.
CANDIDATES=${SNAPSHOT_SH_NODE_CANDIDATES:-"node nodejs /opt/homebrew/bin/node /usr/local/bin/node"}
check_node() {
  "$1" -e 'process.exit(parseInt(process.versions.node.split(".")[0],10)>=18?0:1)' 2>/dev/null
}
for nd in $CANDIDATES; do
  if command -v "$nd" >/dev/null 2>&1 && check_node "$nd"; then
    exec "$nd" "$SCRIPT_DIR/snapshot.js" "$@"
  fi
done
if [ -n "${HOME:-}" ]; then
  for nd in "$HOME"/.nvm/versions/node/*/bin/node; do
    if [ -x "$nd" ] && check_node "$nd"; then
      exec "$nd" "$SCRIPT_DIR/snapshot.js" "$@"
    fi
  done
fi
echo "herdr-cwd-restore: no Node 18+ interpreter found" >&2
exit 1
