# herdr-cwd-restore

> **Requires `resume_agents_on_restore = false`** in `~/.config/herdr/config.toml`
> (see Requirements below). Restored panes must come back as plain shells —
> with native agent session restore on, Herdr spawns agent processes this
> plugin would only have to tear down again.

Keep the full Herdr workspace layout in a single auto-saved project file —
and fix working-directory restoration.

> **Scope: server restarts only.** This plugin only acts on Herdr server
> start (the `[[startup]]` hook). Detaching / re-attaching the Herdr UI
> triggers nothing — Herdr already keeps everything across detach/attach
> exactly as it was, including agent sessions.

Herdr restores the workspace itself on server restart, but it only remembers
the directory each tab was *created* in: `cd` to another directory afterwards
and the new location is forgotten. This plugin tracks where your tabs
*actually* are — via each pane's live `foreground_cwd` plus a shell hook that
snapshots after every `cd` — and enforces those directories on the next
startup, recreating any tab Herdr restored into the wrong place. That is the
whole point: without the `cd` hook below, this plugin is just a second copy
of what Herdr already does.

## How it works

1. Any meaningful layout change (tab created/closed/renamed/moved,
   pane closed, workspace created/closed/renamed/moved/reordered/updated,
   worktree created/opened/removed) fires a `[[events]]` hook that runs
   `src/snapshot.sh`, rewriting `projects/workspace-state.toml` with the
   full cross-space state. High-frequency events (`*.focused`,
   `pane.scroll_changed`, `pane.output_matched`,
   `pane.agent_status_changed`) are deliberately not subscribed, and
   `workspace.metadata_updated` never invokes plugin hooks by design.
2. The required shell hooks (install step 5) do the same after every `cd`,
   so the file also tracks directory changes inside already-open panes —
   the gap Herdr alone leaves behind.
3. On every server start (including a live-handoff takeover, i.e. a new
   server process taking over — not a UI detach/attach) a `[[startup]]` hook
   runs `src/restore.sh`, which reconciles the restored session with
   `projects/workspace-state.toml` as the source of truth: autosave entries missing
   live are recreated, entries already present in the saved directory are
   kept, and entries Herdr restored into the wrong directory (or duplicated)
   are closed and recreated from the saved definition. All directories are
   verified before anything is closed or created. A UI detach/attach never
   reaches this step.

## Install

### Option A — install from GitHub (recommended)

1. Check prerequisites: Herdr >= 0.8.0 and Node >= 18 (`node --version`),
   plus `resume_agents_on_restore = false` in `~/.config/herdr/config.toml`
   (see Requirements — without it, restarts spawn agent processes instead
   of the plain shells this plugin manages).
2. Install the plugin:
   ```sh
   herdr plugin install Wartafak/herdr-cwd-restore
   ```
   Non-interactive / pinned variants:
   ```sh
   herdr plugin install Wartafak/herdr-cwd-restore --yes
   herdr plugin install Wartafak/herdr-cwd-restore --ref <tag-or-sha>
   ```
   If you previously linked a local checkout, uninstall/unlink it first —
   installing over a locally linked plugin is refused:
   ```sh
   herdr plugin unlink herdr-cwd-restore
   ```
   There is no `plugin update` in Herdr v1 — reinstall to refresh a managed
   install (`herdr plugin uninstall herdr-cwd-restore`, then install again).
   Your state under `herdr plugin config-dir herdr-cwd-restore` survives.
3. Verify the install took cleanly:
   ```sh
   herdr plugin list --plugin herdr-cwd-restore
   ```
   then continue at step 4 below (state file) and step 5 (shell hook — still
   required). For step 5, resolve the managed checkout path with:
   ```sh
   herdr plugin list --plugin herdr-cwd-restore --json
   ```
   and use its `plugin_root` as `<plugin_root>` in the hook snippets
   (`<plugin_root>/src/snapshot.sh`,
   `<plugin_root>/src/shell/herdr-cwd-restore.{fish,zsh,sh}`).

### Option B — link a local checkout (development)

1. Same prerequisites as Option A, step 1.
2. Link the plugin:
   ```sh
   herdr plugin link /path/to/herdr-cwd-restore
   ```
   Here `<plugin_root>` below is `/path/to/herdr-cwd-restore` itself.
3. Verify the link took cleanly:
   ```sh
   herdr plugin list --plugin herdr-cwd-restore
   ```

4. The state file appears on its own after the first tab/workspace
   event — or force one immediately:
   ```sh
   herdr plugin action invoke herdr-cwd-restore.capture
   ```
5. Hook your shell so every `cd` snapshots — this is the core of the
   plugin. Event hooks cover tab/pane/workspace lifecycle but
   never fire on `cd` inside an already-open pane (panes are plain PTYs; no
   documented event fires reliably on cwd change). Without this step the
   plugin only duplicates what Herdr already does.
   Run the setup script with your shell as the required argument
   (`zsh`, `fish` or `bash`) — it appends the hook lines to your rc file
   idempotently (re-running never duplicates them, and refreshes the
   paths if the plugin moved, e.g. after a reinstall):
   ```sh
   <plugin_root>/src/setup-cd-hook.sh zsh
   # or: <plugin_root>/src/setup-cd-hook.sh fish
   # or: <plugin_root>/src/setup-cd-hook.sh bash
   ```
   Replace `<plugin_root>` with your managed checkout root (Option A,
   from `herdr plugin list --plugin herdr-cwd-restore --json`) or your
   local checkout (Option B). The script targets `~/.zshrc`
   (`$ZDOTDIR/.zshrc` if set), `~/.bashrc`, or
   `${XDG_CONFIG_HOME:-~/.config}/fish/config.fish`, backs the rc file
   up to `<rc>.bak` before changing it, and derives the plugin root from
   its own location unless overridden (`--plugin-root <path>` or
   `HERDR_CWD_RESTORE_PLUGIN_ROOT`). Then re-source the rc file or
   restart your shell.
   Manual equivalent (if you prefer to edit the rc file yourself —
   use an absolute path: the hook runs after the `cd`, so a relative path
   would resolve against the new directory):
   ```fish
   # config.fish
   set -g __herdr_cwd_restore_snapshot_sh <plugin_root>/src/snapshot.sh
   source <plugin_root>/src/shell/herdr-cwd-restore.fish
   ```
   ```zsh
   # .zshrc
   __herdr_cwd_restore_snapshot_sh=<plugin_root>/src/snapshot.sh
   source <plugin_root>/src/shell/herdr-cwd-restore.zsh
   ```
   ```sh
   # .bashrc (wraps cd; delegates to the builtin, captures only on success)
   __herdr_cwd_restore_snapshot_sh=<plugin_root>/src/snapshot.sh
   source <plugin_root>/src/shell/herdr-cwd-restore.sh
   ```
   Herdr injects `HERDR_ENV=1`
   into every pane's shell, so the hook fires only inside Herdr panes, and
   the snapshot runs fully detached — the prompt never waits on it.
6. Verify: restart the Herdr server process (not just detach/re-attach the
   UI — that triggers nothing by design), then
   check the hook ran and what it did:
   ```sh
   herdr plugin log list --plugin herdr-cwd-restore
   ```
   Expect `already present ... skipping` lines when nothing is missing.

## Workspace State file

`projects/workspace-state.toml` inside the plugin config dir
(`herdr plugin config-dir herdr-cwd-restore`) is rewritten untouched on every
subscribed event and every hooked `cd` — never hand-edit it, the next
change overwrites it anyway:

- Top-level `working_dir` is the longest common ancestor of the live tab
  directories; each tab keeps the space it was saved from as
  `workspace = "..."`.
- Same-label-different-dir tabs in one space are skipped with a warning
  (rename the tab so the next save picks it up); the same label in
  different spaces is saved once per space.
- Every rewrite rotates the previous snapshot to
  `projects/workspace-state.prev.toml` first, so one bad capture (e.g. the first
  event after a degraded Herdr restore) never destroys the last good state
  silently.

## On-demand snapshot

```sh
herdr plugin action invoke herdr-cwd-restore.capture  # rewrite workspace-state.toml now
```

It always rewrites the single state file (rotating the
previous one to `workspace-state.prev.toml` first).

## Verifying the `cd` hook

In any pane: `echo $HERDR_ENV` must print `1` (otherwise the hook stays
silent — correct outside Herdr). Then `cd` to a directory, wait ~2 seconds,
and check that `workspace-state.toml`'s mtime changed. If it didn't, the hook path
in your shell rc is wrong or the rc wasn't re-sourced.

## Layout

- `herdr-plugin.toml` — plugin manifest (the `[[startup]]` restore hook,
  the `[[events]]` autosave hooks and the invocable `open` / `capture`
  `[[actions]]` entries).
- `src/utils/workspace-state.js` — the single live-state reader:
  `getWorkspaceState()` returns the current layout as
  `[{ tabId, workspace, label, cwd }]` (tab objects expose no cwd, so each
  tab's directory is joined in from the first pane with `foreground_cwd`).
- `src/utils/toml.js` — minimal TOML reader/writer for the state file schema
  (Node has no built-in TOML parser).
- `src/utils/config.js` — plugin config dir resolution (`projects/` lives
  beneath it).
- `src/utils/project.js` — state file parsing (`loadProject`) and directory
  resolution/verification (`resolveTabDirs`).
- `src/utils/herdr.js` — Herdr mutations: `openGroups` (create tabs grouped
  by workspace via `herdr tab create --cwd`), `closeTab`, workspace
  create-or-reuse.
- `src/snapshot.js` — renders live state into `projects/workspace-state.toml`
  (`--stdout` previews without writing), rotating the previous file to
  `workspace-state.prev.toml` first.
- `src/snapshot.sh` — interpreter wrapper for the event hooks, the shell
  hooks, and the invocable `capture` `[[actions]]` entry.
- `src/restore.js` — startup reconciler: enforces `projects/workspace-state.toml`
  as the source of truth (missing tabs recreated, wrong-directory tabs
  closed and recreated, exact matches kept).
- `src/restore.sh` — interpreter wrapper for the `[[startup]]` hook.
- `src/shell/herdr-cwd-restore.{fish,zsh,sh}` — required shell hooks that run
  the snapshot after every `cd` inside Herdr panes.
- `src/setup-cd-hook.sh` — installs the `cd` hook into the shell rc file
  (`setup-cd-hook.sh zsh|fish|bash`): appends the snapshot-path + source
  lines idempotently, refreshing stale paths on rerun.
- `test/*.test.js` — unit tests (built-in `node:test`, see Testing).

Each `*.sh` wrapper locates a Node 18+ binary — including nvm install
dirs, which the server's PATH doesn't see — because manifest `command`
arrays get no shell expansion.

## Testing

Unit tests use only Node's built-in runner — no jest, no npm
dependencies (`node:test` + `node:assert/strict`):

```sh
npm test
```

`test/*.test.js` cover the pure logic: TOML subset parsing, project
parsing/naming/path resolution, snapshot arg handling/rendering/backup
rotation, restore reconcile planning. Live
Herdr calls (`getWorkspaceState`, `tab create`, `pane run`, `tab close`) are
verified against a real server instead of mocked. Test fixtures go under
file-specific subdirs of `test/.tmp/` (git-ignored) — never outside the repo.

## Requirements

- Herdr >= 0.8.0 (developed against 0.9.x), Linux/macOS/Windows.
- Node >= 18 (no npm dependencies).
- `resume_agents_on_restore = false` in `~/.config/herdr/config.toml`:
  ```toml
  [session]
  resume_agents_on_restore = false
  ```
  The plugin only works properly with native agent session restore off.
  Restored panes must come back as plain shells in their saved directories:
  resumed agent processes would spawn `opencode` (or other agent) instances
  you never asked for, and agent-owned panes cannot be repaired in place
  (keystrokes land in the agent TUI, not the shell) — so the startup
  reconciler would only end up killing them anyway.
