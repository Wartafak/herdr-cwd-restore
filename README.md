# herdr-tab-cwd

Restore working directories in named Herdr tabs on server startup.

Herdr restores the workspace *shape* on server restart (tabs, panes, layout)
but not the process inside each pane, nor reliably the current working
directory if the shell had `cd`'d elsewhere after the pane was created. This
plugin closes that gap: a TOML config maps tab labels to directories, and a
`[[startup]]` hook sends `cd <cwd>` into each matched tab.

## How it works

1. On server startup (and on live handoff via `herdr update`), Herdr runs
   `src/run.sh`, which finds a Node 18+ interpreter and execs
   `src/main.js`.
2. `main.js` loads `config.toml`, lists open tabs via `herdr tab list`, and
   matches configured labels against live tab labels. Matching is exact
   and case-sensitive — a configured label restores the tab with that
   exact label.
3. Each matched tab gets `cd <cwd>` typed into its panes via
   `herdr pane run` (the only CLI command that injects text into a terminal;
   pane IDs are used purely as delivery addresses).
4. Tabs with an active agent session (`agent_status` anything other than
   `unknown`) are skipped, so the plugin never pastes into a working agent.

Sending bare `cd` keeps the hook idempotent: re-running it on a live handoff
just re-enters the same directory instead of spawning duplicate processes.

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
4. Generate the initial `config.toml` from your live tabs — easiest via
   the plugin action (runs inside the plugin environment, so no path
   needed; safe to re-run any time):
   ```sh
   herdr plugin action invoke herdr-tab-cwd.snapshot
   ```
   Or by hand (outside the plugin env `HERDR_PLUGIN_CONFIG_DIR` is
   unset, so pass the path explicitly):
   ```sh
    node src/snapshot.js --out "$(herdr plugin config-dir herdr-tab-cwd)/config.toml"
   ```
   Review it once — ambiguous labels are emitted commented-out.
5. Optional but recommended: snapshot on every `cd` (see below).
   Without it, the config refreshes on tab/pane/workspace lifecycle
   events; with it, it also tracks `cd` inside open panes.
6. Verify: restart the Herdr server (or trigger a live handoff), then
   check the hook ran and what it did:
   ```sh
   herdr plugin log list --plugin herdr-tab-cwd
   ```

## Config

Generate it from your live tabs (recommended):

```sh
node src/snapshot.js --stdout   # preview, writes nothing
node src/snapshot.js            # mirror into the plugin config dir (inside plugin hooks;
                                # add --out <path> when running by hand)
```

- `~` and `$VAR` in `cwd` are expanded by the plugin before the `cd` is sent.
- Labels duplicated across tabs with *different* directories are ambiguous
  (one entry would `cd` every such tab to the same place) — `snapshot.js`
  emits those commented-out with a warning, so rename one of the tabs to
  make the label unambiguous.
- The config is a mirror of the live tab state and is fully regenerated on
  every run: entries for closed tabs disappear, so do not hand-edit the
  generated file. The `[[events]]` hooks in `herdr-plugin.toml` re-run the
  snapshot (`src/snapshot.sh`, i.e. `snapshot.js` with no arguments)
  whenever tabs, panes, workspaces, or worktrees are created, closed,
  renamed, opened, or removed. High-frequency events (`*.focused`,
  `pane.scroll_changed`, `pane.output_matched`,
  `pane.agent_status_changed`) are deliberately not subscribed.

## Snapshot on every `cd` (optional)

Event hooks cover tab/pane/workspace lifecycle, but not `cd` inside an
already-open pane. For that, hook the shell itself — Herdr injects
`HERDR_ENV=1` (plus `HERDR_TAB_ID` / `HERDR_PANE_ID` /
`HERDR_WORKSPACE_ID`) into every pane's shell, so the hook fires only
inside Herdr panes. The snapshot runs fully detached, so the prompt never
waits on it.

```fish
# config.fish
set -g __herdr_tab_cwd_snapshot_sh /path/to/herdr-tab-cwd/src/snapshot.sh
# optional, defaults to ~/.config/herdr/plugins/config/herdr-tab-cwd/config.toml:
# set -g __herdr_tab_cwd_snapshot_out /custom/path/config.toml
source /path/to/herdr-tab-cwd/src/shell/herdr-tab-cwd.fish
```

```zsh
# .zshrc
__herdr_tab_cwd_snapshot_sh=/path/to/herdr-tab-cwd/src/snapshot.sh
# optional, defaults to ~/.config/herdr/plugins/config/herdr-tab-cwd/config.toml:
# __herdr_tab_cwd_snapshot_out=/custom/path/config.toml
source /path/to/herdr-tab-cwd/src/shell/herdr-tab-cwd.zsh
```

```sh
# .bashrc (wraps cd; delegates to the builtin, snapshots only on success)
__herdr_tab_cwd_snapshot_sh=/path/to/herdr-tab-cwd/src/snapshot.sh
# optional, defaults to ~/.config/herdr/plugins/config/herdr-tab-cwd/config.toml:
# __herdr_tab_cwd_snapshot_out=/custom/path/config.toml
source /path/to/herdr-tab-cwd/src/shell/herdr-tab-cwd.sh
```

Use an absolute path: the hook runs after the `cd`, so a relative path
would resolve against the new directory. The explicit `--out` is required
because `HERDR_PLUGIN_CONFIG_DIR` is only set inside plugin hook processes,
not in interactive panes — without it the snapshot fails silently (output
goes to `/dev/null` so the prompt never blocks). There is no Herdr-side
command interception to hook instead — panes are plain PTYs and no
documented event fires reliably on cwd change, so the shell hook is the
mechanism.

To verify the hook in a pane: `echo $HERDR_ENV` must print `1`; `cd` to a
directory not yet in the config, wait ~2 seconds, and check that
`config.toml`'s mtime changed. To see errors directly, run the snapshot in
the foreground once:
```sh
sh /path/to/herdr-tab-cwd/src/snapshot.sh --out /path/to/config.toml
```

## Layout

- `herdr-plugin.toml` — plugin manifest (`[[startup]]` hook, `[[events]]`
  snapshot hooks, and the invocable `snapshot` `[[actions]]` entry).
- `src/main.js` — the startup hook (Node stdlib only, no npm packages).
- `src/toml.js` — minimal TOML reader for the `[[tabs]]` schema, shared by
  both scripts (Node has no built-in TOML parser).
- `src/run.sh` — interpreter wrapper (argv has no shell expansion, so the
  manifest calls this to locate a Node 18+ binary — including nvm install
  dirs, which the server's PATH doesn't see — and exec `main.js`).
- `src/snapshot.js` — config generator from live Herdr state: a pure
  mirror, fully regenerated on every run (`--stdout` preview, `--out`
  writes elsewhere).
- `src/snapshot.sh` — interpreter wrapper for the event hooks (no
  arguments = mirror into the plugin config dir).
- `src/shell/herdr-tab-cwd.{fish,zsh,sh}` — optional shell hooks that run
  the snapshot after every `cd` inside Herdr panes.

## Requirements

- Herdr >= 0.8.0 (developed against 0.9.1), Linux/macOS/Windows.
- Node >= 18 (no npm dependencies; `run.sh` / `snapshot.sh` search PATH,
  Homebrew locations, and nvm install dirs).
