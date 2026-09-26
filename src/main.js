"use strict";
// Restore working directories in named herdr tabs on server startup.
//
// Herdr restores the workspace *shape* on server restart (tabs, panes, layout)
// but not the process inside each pane, nor reliably the current working
// directory if the user `cd`'d elsewhere after the pane was created. This
// plugin closes that gap: a TOML config maps tab labels to directories, and
// this startup hook sends `cd <cwd>` into the panes of each matched tab.
//
// Herdr-specific interactions (plugin v1, see https://herdr.dev/docs/plugins/):
// - This script runs as a `[[startup]]` hook: one-shot initialization that
//   fires once after Herdr restores the session and the API socket is ready.
//   It receives `HERDR_PLUGIN_EVENT=startup`. It may run again during a live
//   handoff (`herdr update`), so it must be idempotent -- `cd` is safe to
//   re-run, which is why this plugin only ever sends `cd`.
// - The whole Herdr CLI is the plugin API. The binary is resolved via
//   `$HERDR_BIN_PATH` (absolute path to the running Herdr binary) instead of
//   a bare `herdr` lookup, because the server process's PATH may not include
//   the CLI install directory.
// - `command` values in `herdr-plugin.toml` are argv arrays with no shell
//   expansion, which is why the manifest invokes `src/run.sh` (argv) that in
//   turn execs this script with a Node 18+ interpreter.
// - `herdr tab list` returns JSON describing open tabs (tab IDs, labels,
//   agent status). Config labels are matched directly against tab labels.
// - `herdr pane run <pane_id> "<command>"` is the only command that injects
//   text into a terminal, so the matched tab's `cd` is delivered via
//   `herdr pane list` pane-ID lookup (delivery addresses only -- the plugin
//   never matches, filters, or reports on panes themselves).

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { splitEntries, parseEntry } = require("./toml");

const CONFIG_FILE_NAME = "config.toml";
const PLUGIN_ID = "herdr-tab-cwd";
// herdr reports this agent_status for a tab no agent integration has ever
// reported lifecycle state for; anything else means an agent session is
// attached and we must not paste into it.
const NO_AGENT_STATUS = "unknown";

class ConfigError extends Error {}

// Resolve the herdr executable to invoke. Prefers `$HERDR_BIN_PATH` (set by
// the herdr server to its own absolute binary path) over a bare `herdr`
// lookup, since the server process's PATH may not include the directory the
// CLI is installed in.
function herdrBinary() {
  return process.env.HERDR_BIN_PATH || "herdr";
}

// Resolve the plugin config file path. Checks, in priority order:
// `$HERDR_PLUGIN_CONFIG_DIR` (set automatically when run as a
// linked/installed plugin), then `$XDG_CONFIG_HOME/herdr-tab-cwd/`, then
// `$HOME/.config/herdr-tab-cwd/`.
function resolveConfigPath() {
  const candidates = [];
  if (process.env.HERDR_PLUGIN_CONFIG_DIR) {
    candidates.push(path.join(process.env.HERDR_PLUGIN_CONFIG_DIR, CONFIG_FILE_NAME));
  }
  if (process.env.XDG_CONFIG_HOME) {
    candidates.push(path.join(process.env.XDG_CONFIG_HOME, PLUGIN_ID, CONFIG_FILE_NAME));
  }
  candidates.push(path.join(process.env.HOME || "", ".config", PLUGIN_ID, CONFIG_FILE_NAME));
  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // missing -- try the next candidate
    }
  }
  throw new ConfigError(`no ${CONFIG_FILE_NAME} found in: ${candidates.join(", ")}`);
}

// Parse the plugin config file into tab-label-to-directory mappings.
// Reads the `[[tabs]]` array (each entry providing `label` and `cwd`).
function loadTabCwds(configPath) {
  const chunks = splitEntries(fs.readFileSync(configPath, "utf8"));
  const tabCwds = [];
  for (const chunk of chunks) {
    if (chunk.kind !== "entry" || !chunk.active) continue;
    for (const line of chunk.lines) {
      const trimmed = line.trim();
      if (trimmed === "" || trimmed.startsWith("#")) continue;
      if (/^\[\[tabs\]\]/.test(trimmed)) continue;
      const kv = /^([A-Za-z0-9_-]+)\s*=\s*(.+?)\s*$/.exec(line);
      if (!kv || (kv[1] !== "label" && kv[1] !== "cwd")) {
        throw new ConfigError(`invalid TOML in ${configPath}: ${trimmed}`);
      }
    }
    const entry = parseEntry(true, chunk.lines);
    if (entry.label === null || entry.labelCommented) {
      throw new ConfigError(`tab entry missing key 'label' in ${configPath}`);
    }
    if (entry.cwd === null || entry.cwdCommented) {
      throw new ConfigError(`tab entry missing key 'cwd' in ${configPath}`);
    }
    tabCwds.push({ label: entry.label, cwd: entry.cwd });
  }
  return tabCwds;
}

// Run a `herdr` CLI subcommand and parse its JSON stdout.
function runHerdrJson(...args) {
  const binary = herdrBinary();
  let result;
  try {
    result = spawnSync(binary, args, { encoding: "utf8" });
  } catch (error) {
    throw new ConfigError(`herdr executable not found at '${binary}'`);
  }
  if (result.error && result.error.code === "ENOENT") {
    throw new ConfigError(`herdr executable not found at '${binary}'`);
  }
  if (result.status !== 0) {
    throw new ConfigError(`herdr ${args.join(" ")} failed: ${(result.stderr || "").trim()}`);
  }
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    throw new ConfigError(`could not parse herdr ${args.join(" ")} output: ${error.message}`);
  }
}

// Query herdr for the currently open tabs (`herdr tab list`): IDs, labels,
// and agent status.
function fetchTabs() {
  const response = runHerdrJson("tab", "list");
  return ((response.result || {}).tabs || []);
}

// Query herdr for the currently open panes (`herdr pane list`). Used only to
// resolve the pane IDs inside each matched tab -- `herdr pane run` is the
// sole text-injection command, so a tab's `cd` is delivered through its
// panes' addresses.
function fetchPanes() {
  const response = runHerdrJson("pane", "list");
  return ((response.result || {}).panes || []);
}

// Index pane IDs by the tab they belong to.
function groupPaneIdsByTab(panes) {
  const paneIdsByTab = {};
  for (const pane of panes) {
    const tabId = pane.tab_id || "";
    (paneIdsByTab[tabId] = paneIdsByTab[tabId] || []).push(pane.pane_id);
  }
  return paneIdsByTab;
}

function hasActiveAgentSession(agentStatus) {
  return agentStatus !== NO_AGENT_STATUS;
}

// Match configured tab labels against currently open tabs. Matching is an
// exact, case-sensitive string comparison, on every platform. The snapshot
// only ever writes exact live labels, so globs would only ever match entries
// nobody wrote on purpose — they were dropped.
function matchTabs(tabCwds, tabs) {
  const matched = [];
  const unmatched = [];
  const labeledTabs = tabs.filter((tab) => tab.label);
  for (const tabCwd of tabCwds) {
    const matchedTabs = labeledTabs.filter((tab) => tab.label === tabCwd.label);
    if (matchedTabs.length > 0) {
      for (const tab of matchedTabs) matched.push({ tab, cwd: tabCwd.cwd });
    } else {
      unmatched.push(tabCwd.label);
    }
  }
  return { matched, unmatched };
}

function expandUser(cwd) {
  const home = process.env.HOME || os.homedir();
  if (cwd === "~" || cwd.startsWith("~/")) return home + cwd.slice(1);
  const username = os.userInfo().username;
  if (cwd === `~${username}` || cwd.startsWith(`~${username}/`)) {
    return home + cwd.slice(username.length + 1);
  }
  return cwd;
}

function expandVars(text) {
  return text.replace(/\$(\w+|\{[^}]*\})/g, (m, name) => {
    if (name.startsWith("{") && name.endsWith("}")) name = name.slice(1, -1);
    return Object.prototype.hasOwnProperty.call(process.env, name)
      ? process.env[name]
      : m;
  });
}

// Port of Python's shlex.quote.
function shellQuote(text) {
  if (text === "") return "''";
  if (/^[A-Za-z0-9@%_+=:,./-]+$/.test(text)) return text;
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

// Build the shell command that restores a tab's working directory. `~` and
// `$VAR` references are expanded here in Node so the tab receives an absolute
// path -- quoting the raw text would otherwise suppress the shell's own tilde
// expansion. The result is then shell-quoted so paths with spaces or special
// characters survive the round-trip through `herdr pane run`, which sends the
// string plus Enter into the terminal. Sending bare `cd` is idempotent by
// design: re-running it on live handoff just re-enters the same directory.
function buildCdCommand(cwd) {
  return `cd ${shellQuote(expandVars(expandUser(cwd)))}`;
}

// Send a command to every pane of a herdr tab via
// `herdr pane run <pane_id> <command>`, which atomically types the command
// into each PTY and presses Enter. Pane IDs are pure delivery addresses here.
function runCommandInTab(tabId, paneIds, command) {
  for (const paneId of paneIds) {
    const result = spawnSync(herdrBinary(), ["pane", "run", paneId, command], {
      encoding: "utf8",
    });
    if (result.status !== 0) {
      throw new ConfigError(
        `herdr pane run failed for tab ${tabId}: ${(result.stderr || "").trim()}`
      );
    }
  }
}

function main() {
  let configPath;
  let tabCwds;
  let tabs;
  let panes;
  try {
    configPath = resolveConfigPath();
    tabCwds = loadTabCwds(configPath);
    tabs = fetchTabs();
    panes = fetchPanes();
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(`herdr-tab-cwd: ${error.message}`);
      return 1;
    }
    throw error;
  }

  const paneIdsByTab = groupPaneIdsByTab(panes);
  const { matched, unmatched } = matchTabs(tabCwds, tabs);
  for (const label of unmatched) {
    console.error(`herdr-tab-cwd: no tab labeled '${label}' found, skipping`);
  }

  let hadError = false;
  for (const { tab, cwd } of matched) {
    const tabId = tab.tab_id;
    const label = tab.label || tabId;
    const agentStatus = tab.agent_status || NO_AGENT_STATUS;
    if (hasActiveAgentSession(agentStatus)) {
      console.error(
        `herdr-tab-cwd: skipping tab '${label}', agent session active (status=${agentStatus})`
      );
      continue;
    }
    const paneIds = paneIdsByTab[tabId] || [];
    if (paneIds.length === 0) {
      console.error(`herdr-tab-cwd: tab '${label}' has no open panes, skipping`);
      continue;
    }
    try {
      runCommandInTab(tabId, paneIds, buildCdCommand(cwd));
    } catch (error) {
      console.error(`herdr-tab-cwd: ${error.message}`);
      hadError = true;
    }
  }
  return hadError ? 1 : 0;
}

if (require.main === module) {
  process.exit(main());
}

module.exports = {
  shellQuote,
  expandUser,
  expandVars,
  buildCdCommand,
  matchTabs,
  loadTabCwds,
  ConfigError,
};
