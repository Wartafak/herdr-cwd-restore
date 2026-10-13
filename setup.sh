#!/bin/sh
# herdr-cwd-restore: install the `cd` hook into the user's shell rc file.
#
# Usage: setup.sh zsh|fish|bash [--plugin-root PATH]
#
# Appends the two hook lines (snapshot path + source) to the shell's rc file
# idempotently: re-running never duplicates them, and refreshes the paths when
# the plugin root moved (e.g. after reinstalling a managed plugin elsewhere).
# Also ensures the Herdr server config sets
#   [session]
#   resume_agents_on_restore = false
# idempotently (missing file/section/key added, wrong value corrected,
# everything else preserved).
# The plugin root defaults to this checkout (this script's dir) and
# can be overridden with --plugin-root or HERDR_CWD_RESTORE_PLUGIN_ROOT.
# The Herdr config file defaults to
# ${HERDR_CONFIG_FILE:-${XDG_CONFIG_HOME:-$HOME/.config}/herdr/config.toml}
# (HERDR_CONFIG_FILE is a test override).
#
#   zsh  -> ${ZDOTDIR:-$HOME}/.zshrc
#   bash -> $HOME/.bashrc (the bash hook lives in src/shell/herdr-cwd-restore.sh)
#   fish -> ${XDG_CONFIG_HOME:-$HOME/.config}/fish/config.fish
#
# Modified rc files are backed up to <rc>.bak before being changed.

usage() {
  echo "usage: setup.sh zsh|fish|bash [--plugin-root PATH]" >&2
}

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
DEFAULT_ROOT="$SCRIPT_DIR"
PLUGIN_ROOT="${HERDR_CWD_RESTORE_PLUGIN_ROOT:-$DEFAULT_ROOT}"
PLUGIN_ROOT_EXPLICIT=0
case "${HERDR_CWD_RESTORE_PLUGIN_ROOT:-}" in
  "") ;;
  *) PLUGIN_ROOT_EXPLICIT=1 ;;
esac
SHELL_NAME=""
SHOW_HELP=0

while [ $# -gt 0 ]; do
  case "$1" in
    -h|--help)
      SHOW_HELP=1
      shift
      ;;
    --plugin-root)
      [ $# -ge 2 ] || { echo "herdr-cwd-restore: --plugin-root needs a path" >&2; usage; exit 1; }
      PLUGIN_ROOT="$2"
      PLUGIN_ROOT_EXPLICIT=1
      shift 2
      ;;
    --plugin-root=*)
      PLUGIN_ROOT="${1#--plugin-root=}"
      PLUGIN_ROOT_EXPLICIT=1
      shift
      ;;
    --*)
      echo "herdr-cwd-restore: unknown option: $1" >&2
      usage
      exit 1
      ;;
    *)
      if [ -z "$SHELL_NAME" ]; then
        SHELL_NAME="$1"
        shift
      elif [ "$PLUGIN_ROOT_EXPLICIT" -eq 0 ]; then
        # Bare second positional: plugin-root override for convenience.
        PLUGIN_ROOT="$1"
        PLUGIN_ROOT_EXPLICIT=1
        shift
      else
        echo "herdr-cwd-restore: too many arguments" >&2
        usage
        exit 1
      fi
      ;;
  esac
done

if [ "$SHOW_HELP" -eq 1 ]; then
  echo "usage: setup.sh zsh|fish|bash [--plugin-root PATH]"
  exit 0
fi

if [ -z "$SHELL_NAME" ]; then
  echo "herdr-cwd-restore: missing required shell argument" >&2
  usage
  exit 1
fi

case "$SHELL_NAME" in
  zsh) HOOK_EXT="zsh" ;;
  fish) HOOK_EXT="fish" ;;
  bash) HOOK_EXT="sh" ;;
  *)
    echo "herdr-cwd-restore: unsupported shell '$SHELL_NAME' (expected zsh, fish or bash)" >&2
    usage
    exit 1
    ;;
esac

# Resolve the plugin root to an absolute path.
case "$PLUGIN_ROOT" in
  /*) ;;
  *)
    echo "herdr-cwd-restore: plugin root must be an absolute path: $PLUGIN_ROOT" >&2
    exit 1
    ;;
esac
if [ ! -d "$PLUGIN_ROOT" ]; then
  echo "herdr-cwd-restore: plugin root not found: $PLUGIN_ROOT" >&2
  exit 1
fi

SNAPSHOT_SH="$PLUGIN_ROOT/src/snapshot.sh"
HOOK_SRC="$PLUGIN_ROOT/src/shell/herdr-cwd-restore.$HOOK_EXT"
if [ ! -f "$SNAPSHOT_SH" ]; then
  echo "herdr-cwd-restore: snapshot.sh not found: $SNAPSHOT_SH" >&2
  exit 1
fi
if [ ! -f "$HOOK_SRC" ]; then
  echo "herdr-cwd-restore: hook file not found: $HOOK_SRC" >&2
  exit 1
fi

# Resolve the rc file for the requested shell.
if [ "$SHELL_NAME" = "zsh" ]; then
  if [ -n "${ZDOTDIR:-}" ]; then
    RC="$ZDOTDIR/.zshrc"
  elif [ -n "${HOME:-}" ]; then
    RC="$HOME/.zshrc"
  else
    echo "herdr-cwd-restore: HOME is unset, cannot locate .zshrc (or set ZDOTDIR)" >&2
    exit 1
  fi
elif [ "$SHELL_NAME" = "bash" ]; then
  if [ -z "${HOME:-}" ]; then
    echo "herdr-cwd-restore: HOME is unset, cannot locate .bashrc" >&2
    exit 1
  fi
  RC="$HOME/.bashrc"
else
  if [ -n "${XDG_CONFIG_HOME:-}" ]; then
    case "$XDG_CONFIG_HOME" in
      /*) RC="$XDG_CONFIG_HOME/fish/config.fish" ;;
      *)
        echo "herdr-cwd-restore: XDG_CONFIG_HOME must be an absolute path" >&2
        exit 1
        ;;
    esac
  elif [ -n "${HOME:-}" ]; then
    RC="$HOME/.config/fish/config.fish"
  else
    echo "herdr-cwd-restore: HOME is unset, cannot locate config.fish (or set XDG_CONFIG_HOME)" >&2
    exit 1
  fi
fi

if [ "$SHELL_NAME" = "fish" ]; then
  VAR_LINE="set -g __herdr_cwd_restore_snapshot_sh \"$SNAPSHOT_SH\""
else
  VAR_LINE="__herdr_cwd_restore_snapshot_sh=\"$SNAPSHOT_SH\""
fi
SRC_LINE="source \"$HOOK_SRC\""
HOOK_MARK="herdr-cwd-restore.$HOOK_EXT"

# Herdr server config: restored panes must be plain shells, so the server
# must not resume agent processes on restart.
ensure_herdr_config() {
  if [ -n "${HERDR_CONFIG_FILE:-}" ]; then
    HERDR_CONFIG="$HERDR_CONFIG_FILE"
  elif [ -n "${XDG_CONFIG_HOME:-}" ]; then
    case "$XDG_CONFIG_HOME" in
      /*) HERDR_CONFIG="$XDG_CONFIG_HOME/herdr/config.toml" ;;
      *)
        echo "herdr-cwd-restore: XDG_CONFIG_HOME must be an absolute path" >&2
        return 1
        ;;
    esac
  elif [ -n "${HOME:-}" ]; then
    HERDR_CONFIG="$HOME/.config/herdr/config.toml"
  else
    echo "herdr-cwd-restore: HOME is unset, cannot locate herdr config.toml (or set XDG_CONFIG_HOME)" >&2
    return 1
  fi

  if [ ! -f "$HERDR_CONFIG" ]; then
    HERDR_CONFIG_DIR=$(dirname "$HERDR_CONFIG")
    mkdir -p "$HERDR_CONFIG_DIR" || { echo "herdr-cwd-restore: cannot create $HERDR_CONFIG_DIR" >&2; return 1; }
    {
      echo "[session]"
      echo "resume_agents_on_restore = false"
    } > "$HERDR_CONFIG" || { echo "herdr-cwd-restore: cannot write $HERDR_CONFIG" >&2; return 1; }
    echo "herdr-cwd-restore: set resume_agents_on_restore = false in $HERDR_CONFIG"
    return 0
  fi

  CFG_TMP="$HERDR_CONFIG.herdr-tmp.$$"
  awk '
    /^[ \t]*\[/ {
      h = $0
      sub(/^[ \t]*\[[ \t]*/, "", h)
      sub(/[ \t]*\].*$/, "", h)
      if (h == "session") { in_session = 1; seen_section = 1 }
      else { in_session = 0 }
      print
      next
    }
    in_session && /^[ \t]*resume_agents_on_restore[ \t]*=/ {
      print "resume_agents_on_restore = false"
      seen_key = 1
      next
    }
    { print }
    END {
      if (seen_section && seen_key) exit 0
      if (!seen_section) exit 2
      exit 3
    }
  ' "$HERDR_CONFIG" > "$CFG_TMP"
  CFG_STATUS=$?
  if [ "$CFG_STATUS" -eq 0 ]; then
    if cmp -s "$HERDR_CONFIG" "$CFG_TMP"; then
      rm -f "$CFG_TMP"
      echo "herdr-cwd-restore: resume_agents_on_restore already false in $HERDR_CONFIG"
      return 0
    fi
    cp "$HERDR_CONFIG" "$HERDR_CONFIG.bak" || { rm -f "$CFG_TMP"; echo "herdr-cwd-restore: cannot back up $HERDR_CONFIG" >&2; return 1; }
    if ! mv "$CFG_TMP" "$HERDR_CONFIG"; then
      rm -f "$CFG_TMP"
      echo "herdr-cwd-restore: cannot write $HERDR_CONFIG" >&2
      return 1
    fi
    echo "herdr-cwd-restore: set resume_agents_on_restore = false in $HERDR_CONFIG (backup: $HERDR_CONFIG.bak)"
    return 0
  fi
  rm -f "$CFG_TMP"
  if [ "$CFG_STATUS" -eq 2 ]; then
    # No [session] section: append it, preserving everything else.
    cp "$HERDR_CONFIG" "$HERDR_CONFIG.bak" || { echo "herdr-cwd-restore: cannot back up $HERDR_CONFIG" >&2; return 1; }
    if [ -s "$HERDR_CONFIG" ]; then
      printf '\n[session]\nresume_agents_on_restore = false\n' >> "$HERDR_CONFIG" || { echo "herdr-cwd-restore: cannot write $HERDR_CONFIG" >&2; return 1; }
    else
      printf '[session]\nresume_agents_on_restore = false\n' >> "$HERDR_CONFIG" || { echo "herdr-cwd-restore: cannot write $HERDR_CONFIG" >&2; return 1; }
    fi
    echo "herdr-cwd-restore: set resume_agents_on_restore = false in $HERDR_CONFIG (backup: $HERDR_CONFIG.bak)"
    return 0
  fi
  # [session] present without the key: insert it after the header.
  CFG_TMP="$HERDR_CONFIG.herdr-tmp.$$"
  awk '
    !inserted && /^[ \t]*\[/ {
      h = $0
      sub(/^[ \t]*\[[ \t]*/, "", h)
      sub(/[ \t]*\].*$/, "", h)
      if (h == "session") { print; print "resume_agents_on_restore = false"; inserted = 1; next }
    }
    { print }
  ' "$HERDR_CONFIG" > "$CFG_TMP" || { rm -f "$CFG_TMP"; echo "herdr-cwd-restore: cannot write $HERDR_CONFIG" >&2; return 1; }
  cp "$HERDR_CONFIG" "$HERDR_CONFIG.bak" || { rm -f "$CFG_TMP"; echo "herdr-cwd-restore: cannot back up $HERDR_CONFIG" >&2; return 1; }
  if ! mv "$CFG_TMP" "$HERDR_CONFIG"; then
    rm -f "$CFG_TMP"
    echo "herdr-cwd-restore: cannot write $HERDR_CONFIG" >&2
    return 1
  fi
  echo "herdr-cwd-restore: set resume_agents_on_restore = false in $HERDR_CONFIG (backup: $HERDR_CONFIG.bak)"
  return 0
}

backup_rc() {
  cp "$RC" "$RC.bak" || return 1
}

if [ ! -f "$RC" ]; then
  RC_DIR=$(dirname "$RC")
  mkdir -p "$RC_DIR" || { echo "herdr-cwd-restore: cannot create $RC_DIR" >&2; exit 1; }
  {
    echo "# herdr-cwd-restore: snapshot tab cwds after every cd (added by setup.sh)"
    echo "$VAR_LINE"
    echo "$SRC_LINE"
  } > "$RC" || { echo "herdr-cwd-restore: cannot write $RC" >&2; exit 1; }
  echo "herdr-cwd-restore: configured $SHELL_NAME hook in $RC"
  echo "herdr-cwd-restore: re-source it (source \"$RC\") or restart your shell, then verify with: cd <dir> && check workspace-state.toml mtime"
  ensure_herdr_config || exit 1
  exit 0
fi

if ! grep -Fq "$HOOK_MARK" "$RC"; then
  backup_rc || { echo "herdr-cwd-restore: cannot back up $RC" >&2; exit 1; }
  {
    echo ""
    echo "# herdr-cwd-restore: snapshot tab cwds after every cd (added by setup.sh)"
    echo "$VAR_LINE"
    echo "$SRC_LINE"
  } >> "$RC" || { echo "herdr-cwd-restore: cannot write $RC" >&2; exit 1; }
  echo "herdr-cwd-restore: configured $SHELL_NAME hook in $RC (backup: $RC.bak)"
  echo "herdr-cwd-restore: re-source it (source \"$RC\") or restart your shell, then verify with: cd <dir> && check workspace-state.toml mtime"
  ensure_herdr_config || exit 1
  exit 0
fi

# Hook already referenced: refresh stale paths (plugin root may have moved),
# preserving every other line. awk with index() avoids regex-escaping issues.
TMP="$RC.herdr-tmp.$$"
if ! awk -v var_line="$VAR_LINE" -v src_line="$SRC_LINE" -v hook_mark="$HOOK_MARK" '
  index($0, "__herdr_cwd_restore_snapshot_sh") > 0 { print var_line; replaced_var = 1; next }
  index($0, hook_mark) > 0 { print src_line; replaced_src = 1; next }
  { print }
  END { exit !(replaced_var && replaced_src) }
' "$RC" > "$TMP"; then
  # One of the two lines is missing despite the hook mark: append what's missing.
  rm -f "$TMP"
  backup_rc || { echo "herdr-cwd-restore: cannot back up $RC" >&2; exit 1; }
  if ! grep -Fq "__herdr_cwd_restore_snapshot_sh" "$RC"; then
    printf '%s\n' "$VAR_LINE" >> "$RC" || { echo "herdr-cwd-restore: cannot write $RC" >&2; exit 1; }
  fi
  if ! grep -Fq "$SRC_LINE" "$RC"; then
    printf '%s\n' "$SRC_LINE" >> "$RC" || { echo "herdr-cwd-restore: cannot write $RC" >&2; exit 1; }
  fi
  echo "herdr-cwd-restore: $SHELL_NAME hook already present in $RC, topped up missing lines (backup: $RC.bak)"
  ensure_herdr_config || exit 1
  exit 0
fi

if cmp -s "$RC" "$TMP"; then
  rm -f "$TMP"
  echo "herdr-cwd-restore: $SHELL_NAME hook already configured in $RC"
  ensure_herdr_config || exit 1
  exit 0
fi
backup_rc || { rm -f "$TMP"; echo "herdr-cwd-restore: cannot back up $RC" >&2; exit 1; }
if ! mv "$TMP" "$RC"; then
  rm -f "$TMP"
  echo "herdr-cwd-restore: cannot write $RC" >&2
  exit 1
fi
echo "herdr-cwd-restore: refreshed $SHELL_NAME hook paths in $RC (backup: $RC.bak)"
ensure_herdr_config || exit 1
exit 0
