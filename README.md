# herdr-tab-cwd

Keep the full Herdr workspace layout in a single auto-saved project file.

Herdr restores the workspace itself on server restart; this plugin keeps a
live mirror of that layout — every tab/pane/workspace change (plus every
`cd`) rewrites the whole cross-space state into one file,
`projects/autosave.toml`. What counts is always the current live state:
previous spaces are simply overwritten by the next snapshot.

## How it works

1. Any meaningful layout change (tab created/closed/renamed/moved,
   pane closed, workspace created/closed/renamed/moved/reordered/updated,
   worktree created/opened/removed) fires a `[[events]]` hook that runs
   `src/capture.sh --autosave`, rewriting `projects/autosave.toml` with the
   full cross-space state. High-frequency events (`*.focused`,
   `pane.scroll_changed`, `pane.output_matched`,
   `pane.agent_status_changed`) are deliberately not subscribed, and
   `workspace.metadata_updated` never invokes plugin hooks by design.
2. The optional shell hooks (below) do the same after every `cd`, so the
   file also tracks directory changes inside already-open panes.
3. There is no `[[startup]]` hook: Herdr restores the workspace on its own,
   and the autosave file is purely a mirror of the live state — nothing to
   replay.

## Install

1. Check prerequisites: Herdr >= 0.8.0 and Node >= 18 (`node --version`).
2. Link the plugin:
   ```sh
   herdr plugin link /path/to/herdr-tab-cwd
   ```
3. Verify the link took cleanly — the `warnings` field must be empty
   (it surfaces bad `[[events]]` names or manifest problems):
   ```sh
   herdr plugin list
   ```
4. The autosave file appears on its own after the first tab/workspace
   event — or force one immediately:
   ```sh
   herdr plugin action invoke herdr-tab-cwd.capture
   ```
   (Invoked, the name defaults to the slugified workspace label; the
   automatic file is always `projects/autosave.toml` regardless.)
5. Optional but recommended: autosave on every `cd` (see below).
   Without it, the file refreshes on tab/pane/workspace lifecycle
   events; with it, it also tracks `cd` inside open panes.
6. Verify: restart the Herdr server (or trigger a live handoff), then
   check the hook ran and what it did:
   ```sh
   herdr plugin log list --plugin herdr-tab-cwd
   ```
   Expect `already present ... skipping` lines when nothing is missing.

## Autosave file

`projects/autosave.toml` inside the plugin config dir
(`herdr plugin config-dir herdr-tab-cwd`) is rewritten untouched on every
subscribed event and every hooked `cd` — never hand-edit it, the next
change overwrites it anyway:

- Top-level `working_dir` is the longest common ancestor of the live tab
  directories; each tab keeps the space it was saved from as
  `workspace = "..."`.
- Same-label-different-dir tabs in one space are skipped with a warning
  (rename the tab so the next save picks it up); the same label in
  different spaces is saved once per space.

## Project workspaces (manual templates + on-demand open)

The autosave covers the steady state; project templates cover intent.
`open` rebuilds a named template from scratch (or appends it), and
`capture` freezes the current tabs into a named template you can edit
(add `command` entries, drop tabs, adjust dirs):

```toml
name = "Shop"
working_dir = "~/dev/shop"

[[tabs]]
name = "web"
workspace = "Shop"       # optional; no workspace → the invoking workspace.
working_dir = "frontend" # → ~/dev/shop/frontend
command = "npm run dev"

[[tabs]]
name = "api"
workspace = "Shop"
working_dir = "backend"  # → ~/dev/shop/backend
command = "make run"

[[tabs]]
name = "shell"           # no command, no working_dir → empty shell in ~/dev/shop
```

Named workspaces are reused by exact label when present, otherwise created
fresh (the default tab Herdr spawns alongside is closed again). Opening is
append, not sync — invoking twice creates the tabs twice. Every directory
is verified to exist *before* the first tab is created, so a typo never
leaves a half-built workspace behind. Unknown projects fail listing the
available ones.

```sh
herdr plugin action invoke herdr-tab-cwd.open     # rebuild (defaults to workspace slug)
herdr plugin action invoke herdr-tab-cwd.capture  # freeze current tabs to projects/<slug>.toml
```

Invoke takes no arguments and never sees your shell's environment, so both
default to the slugified workspace label — e.g. the "My Projects" workspace
opens `projects/my-projects.toml`. For an explicit name, run directly:
`HERDR_TAB_CWD_PROJECT=Shop node src/open.js`,
`node src/capture.js Shop --force` (recapture refuses to overwrite without
`--force`).

## Autosave on every `cd` (optional)

Event hooks cover tab/pane/workspace lifecycle, but not `cd` inside an
already-open pane. For that, hook the shell itself — Herdr injects
`HERDR_ENV=1` (plus `HERDR_TAB_ID` / `HERDR_PANE_ID` /
`HERDR_WORKSPACE_ID`) into every pane's shell, so the hook fires only
inside Herdr panes. The capture runs fully detached, so the prompt never
waits on it.

```fish
# config.fish
set -g __herdr_tab_cwd_capture_sh /path/to/herdr-tab-cwd/src/capture.sh
source /path/to/herdr-tab-cwd/src/shell/herdr-tab-cwd.fish
```

```zsh
# .zshrc
__herdr_tab_cwd_capture_sh=/path/to/herdr-tab-cwd/src/capture.sh
source /path/to/herdr-tab-cwd/src/shell/herdr-tab-cwd.zsh
```

```sh
# .bashrc (wraps cd; delegates to the builtin, captures only on success)
__herdr_tab_cwd_capture_sh=/path/to/herdr-tab-cwd/src/capture.sh
source /path/to/herdr-tab-cwd/src/shell/herdr-tab-cwd.sh
```

Use an absolute path: the hook runs after the `cd`, so a relative path
would resolve against the new directory. No `--out` is needed:
`--autosave` always targets `projects/autosave.toml` under the plugin
config dir (resolved via `$HOME` in interactive panes, where
`HERDR_PLUGIN_CONFIG_DIR` is unset). There is no Herdr-side command
interception to hook instead — panes are plain PTYs and no documented
event fires reliably on cwd change, so the shell hook is the mechanism.

To verify the hook in a pane: `echo $HERDR_ENV` must print `1`; `cd` to a
directory, wait ~2 seconds, and check that `autosave.toml`'s mtime
changed.

## Layout

- `herdr-plugin.toml` — plugin manifest (`[[events]]` autosave hooks and
  the invocable `open` / `capture` `[[actions]]` entries).
- `src/live.js` — live Herdr state: tab labels joined with per-tab
  `foreground_cwd` and workspace labels (tab objects expose no cwd).
- `src/toml.js` — minimal TOML reader/writer for the project schema
  (Node has no built-in TOML parser).
- `src/capture.js` — renders live state into `projects/<name>.toml`
  scaffolds, or the single `projects/autosave.toml` with `--autosave`
  (`--stdout` preview, `--out` writes elsewhere, `--force` overwrites).
- `src/capture.sh` — interpreter wrapper for the event hooks, the shell
  hooks, and the invocable `capture` `[[actions]]` entry.
- `src/open.js` — project workspace opener: reads `projects/<name>.toml`,
  creates tabs via `herdr tab create --cwd` and delivers each `command`
  with `herdr pane run`.
- `src/open.sh` — interpreter wrapper for the invocable `open`
  `[[actions]]` entry.
- `src/shell/herdr-tab-cwd.{fish,zsh,sh}` — optional shell hooks that run
  the autosave after every `cd` inside Herdr panes.
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
parsing/naming/path resolution, capture arg handling and rendering. Live
Herdr calls (`collectLiveRows`, `tab create`, `pane run`) are verified
against a real server instead of mocked. Test fixtures are written under
`test/.tmp/` (git-ignored, wiped after the run) — never outside the repo.

## Requirements

- Herdr >= 0.8.0 (developed against 0.9.x), Linux/macOS/Windows.
- Node >= 18 (no npm dependencies).
