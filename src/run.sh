#!/bin/sh
# Finds a Node 18+ interpreter and execs it on main.js.
# The herdr *server* process's PATH can differ from the interactive shell's
# (e.g. nvm shims are shell functions, invisible to the server), so we don't
# rely on PATH directly: search a candidate list of interpreter names/paths,
# plus nvm install dirs, and run the first Node 18+ one found.
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
# RUN_SH_NODE_CANDIDATES overrides the search list; used by tests.
CANDIDATES=${RUN_SH_NODE_CANDIDATES:-"node nodejs /opt/homebrew/bin/node /usr/local/bin/node"}
check_node() {
  "$1" -e 'process.exit(parseInt(process.versions.node.split(".")[0],10)>=18?0:1)' 2>/dev/null
}
for nd in $CANDIDATES; do
  if command -v "$nd" >/dev/null 2>&1 && check_node "$nd"; then
    exec "$nd" "$SCRIPT_DIR/main.js"
  fi
done
if [ -n "${HOME:-}" ]; then
  for nd in "$HOME"/.nvm/versions/node/*/bin/node; do
    if [ -x "$nd" ] && check_node "$nd"; then
      exec "$nd" "$SCRIPT_DIR/main.js"
    fi
  done
fi
echo "herdr-tab-cwd: no Node 18+ interpreter found" >&2
exit 1
