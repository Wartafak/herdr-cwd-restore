# AGENTS.md

Zero-dependency Herdr plugin (Node >= 18, CommonJS). Tracks live tab working directories in `projects/workspace-state.toml`; `[[startup]]` reconciles the live session with it as source of truth.

## Commands

- `npm test` — runs exactly `test/toml.test.js test/workspace-state.test.js test/open.test.js test/snapshot.test.js test/restore.test.js` via `node --test`. No jest, no deps.
- Single file: `node --test test/<name>.test.js`.
- Test fixtures go under file-specific subdirs of `test/.tmp/` only (git-ignored). Never wipe the whole dir in `after()` — test files run in parallel processes and whole-dir wipes race. Never write fixtures outside the repo.
- Live Herdr calls (`getWorkspaceState`, `tab create`, `pane run`, `tab close`) are verified against a real server, not mocked — don't add mocks for them.

## Manifest (`herdr-plugin.toml`)

- `[[startup]]` (`src/restore.sh`), `[[actions]]` (`capture`) and all `[[events]]` use `command = ["/bin/sh", "src/<name>.sh", ...]` — manifest arrays get no shell expansion, so keep the `/bin/sh` + wrapper indirection. Never call `node` directly from the manifest.
- All `[[events]]` run `src/snapshot.sh`. Do not subscribe `*.focused`, `pane.scroll_changed`, `pane.output_matched`, `pane.agent_status_changed` (high-frequency noise), and `workspace.metadata_updated` never invokes plugin hooks by design.
- Requires Herdr `resume_agents_on_restore = false` (see README Requirements) — restored panes must be plain shells, not resumed agent processes.

## Code map

- `src/utils/workspace-state.js` — the single live-state reader. `getWorkspaceState()` returns `[{ tabId, workspace, label, cwd }]`; tab objects expose no cwd, so cwd comes from the first pane with `foreground_cwd` (`herdr pane list`), `~`-abbreviated. Workspace labels from `herdr workspace list`.
- `src/utils/config.js` — plugin config dir resolution (`projects/` lives beneath it).
- `src/utils/project.js` — state file parsing (`loadProject`) and dir resolution/verification (`resolveTabDirs`); owns `ProjectError`.
- `src/utils/herdr.js` — Herdr mutations: `openGroups` (tabs grouped by workspace via `herdr tab create --cwd`), `closeTab`, workspace create-or-reuse. `HERDR_BIN_PATH` overrides the `herdr` binary in tests. Named workspaces reused by exact label or created with `--no-focus`; the auto-spawned default tab is closed **after** real tabs exist (closing the last tab destroys the workspace).
- `src/restore.js` — startup reconciler, `workspace-state.toml` is the source of truth. Per (workspace, label) entry: absent → created; exact single match → kept; wrong dir / duplicate / unreadable cwd → closed via `herdr tab close` then recreated through `openGroups`. Verifies all dirs before closing or creating anything. No state file → exit 0, skip.
- `src/snapshot.js` — single-purpose state writer: always renders live state into `projects/workspace-state.toml` (top-level `working_dir` = longest common ancestor; a tab equal to it omits `working_dir`). Same label in different spaces → one tab per space; same label + different dirs in one space (or no readable cwd) → skipped with warning. Always overwrites but rotates the previous snapshot to `workspace-state.prev.toml` first. `--stdout` previews without writing; nothing else is accepted.
- `src/utils/toml.js` — minimal TOML subset only (`[[tabs]]` + `name`/`working_dir`/`command`/`workspace`, double-quoted via `JSON.stringify` or single-quoted literals). Do not add a TOML library; extend the subset deliberately.
- `src/*.sh` — locate a Node 18+ binary including nvm dirs (`~/.nvm/versions/node/*/bin/node`) because the server PATH differs from the shell. Test override: `SNAPSHOT_SH_NODE_CANDIDATES` / `OPEN_SH_NODE_CANDIDATES` / `RESTORE_SH_NODE_CANDIDATES`.
- `src/shell/herdr-cwd-restore.{fish,zsh,sh}` — required `cd` hooks (install step 5); gate on `HERDR_ENV=1`, run `snapshot.sh` detached. No Herdr-side cwd-change event exists; the shell hook is the mechanism.

## Env / paths

- Config dir resolution: `$HERDR_PLUGIN_CONFIG_DIR` → `$XDG_CONFIG_HOME/herdr/plugins/config/herdr-cwd-restore` → `$HOME/.config/...` → `$HOME/.config/herdr-cwd-restore`. Project files live in `projects/` beneath it.
- Never hand-edit `projects/workspace-state.toml` — it is rewritten untouched on every event/`cd`.
