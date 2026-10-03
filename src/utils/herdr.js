"use strict";
// Herdr mutations: create tabs (grouped by workspace), run commands in panes,
// and close tabs. All tabs are created with `herdr tab create --cwd` so each
// starts life in its directory -- typing `cd` can never fix an agent-owned
// pane (keystrokes land in the agent TUI, not the shell).

const { spawnSync } = require("node:child_process");
const { ProjectError } = require("./project");

function herdrBinary() {
  return process.env.HERDR_BIN_PATH || "herdr";
}

function runHerdrJson(...args) {
  const binary = herdrBinary();
  let result;
  try {
    result = spawnSync(binary, args, { encoding: "utf8" });
  } catch {
    throw new ProjectError(`herdr executable not found at '${binary}'`);
  }
  if (result.error && result.error.code === "ENOENT") {
    throw new ProjectError(`herdr executable not found at '${binary}'`);
  }
  if (result.status !== 0) {
    throw new ProjectError(`herdr ${args.join(" ")} failed: ${(result.stderr || "").trim()}`);
  }
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    throw new ProjectError(`could not parse herdr ${args.join(" ")} output: ${error.message}`);
  }
}

// Group resolved tabs by target workspace, preserving first-seen order.
// Tabs without a `workspace` key land in `current` (the invoking workspace)
// and are created without `--workspace`.
function groupByWorkspace(resolved) {
  const groups = [];
  const index = new Map();
  for (const entry of resolved) {
    const key = entry.tab.workspace === null ? "current" : entry.tab.workspace;
    if (!index.has(key)) {
      index.set(key, groups.length);
      groups.push({ workspace: entry.tab.workspace, entries: [] });
    }
    groups[index.get(key)].entries.push(entry);
  }
  return groups;
}

// Find a workspace by exact label, or create it fresh (`--no-focus` so the
// user's current space stays put). Returns { workspaceId, autoTabId }:
// `workspace create` also spawns a default tab the caller did not ask for,
// reported back so the caller can close it *after* the real tabs exist --
// closing the last tab of a workspace destroys the workspace itself, so it
// must never be closed first. Reused workspaces report autoTabId null.
function resolveWorkspaceId(label) {
  const list = runHerdrJson("workspace", "list");
  const workspaces = ((list.result || {}).workspaces || []);
  const existing = workspaces.find((w) => w.label === label);
  if (existing) return { workspaceId: existing.workspace_id, autoTabId: null };
  const created = runHerdrJson("workspace", "create", "--label", label, "--no-focus");
  const ws = (created.result || {}).workspace || {};
  if (!ws.workspace_id) {
    throw new ProjectError(`herdr workspace create returned no workspace for '${label}'`);
  }
  return {
    workspaceId: ws.workspace_id,
    autoTabId: ((created.result || {}).tab || {}).tab_id || null,
  };
}

// Best-effort removal of a tab; a failure is only a warning.
function closeTab(tabId) {
  const closed = spawnSync(herdrBinary(), ["tab", "close", tabId], { encoding: "utf8" });
  if (closed.status !== 0) {
    console.error(
      `herdr-workspace-autosave: warning: could not close tab ${tabId}: ` +
        (closed.stderr || "").trim()
    );
  }
}

// `herdr tab create` returns the new tab *and* its root pane in one call, so
// no follow-up lookup is needed to deliver the tab's command.
function createTab(dir, label, workspaceId) {
  const args = ["tab", "create", "--cwd", dir, "--label", label, "--no-focus"];
  if (workspaceId !== null) args.push("--workspace", workspaceId);
  const response = runHerdrJson(...args);
  const tab = (response.result || {}).tab || {};
  const rootPane = (response.result || {}).root_pane || {};
  if (!tab.tab_id || !rootPane.pane_id) {
    throw new ProjectError(`herdr tab create returned no tab/pane for '${label}'`);
  }
  return { tabId: tab.tab_id, paneId: rootPane.pane_id };
}

function runInPane(paneId, command) {
  const result = spawnSync(herdrBinary(), ["pane", "run", paneId, command], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new ProjectError(`herdr pane run failed: ${(result.stderr || "").trim()}`);
  }
}

// Create every resolved tab, grouped by workspace. Nothing is ever closed,
// moved, or duplicated by this path -- use the Herdr UI for that.
function openGroups(resolved) {
  for (const group of groupByWorkspace(resolved)) {
    const entries = group.entries;
    const { workspaceId, autoTabId } =
      group.workspace === null
        ? { workspaceId: null, autoTabId: null }
        : resolveWorkspaceId(group.workspace);
    for (const { tab, dir } of entries) {
      const { paneId } = createTab(dir, tab.name, workspaceId);
      if (tab.command !== null) runInPane(paneId, tab.command);
      const where = group.workspace === null ? "current workspace" : `workspace '${group.workspace}'`;
      console.error(`herdr-workspace-autosave: opened tab '${tab.name}' in ${dir} (${where})`);
    }
    if (autoTabId !== null) closeTab(autoTabId);
  }
}

module.exports = {
  groupByWorkspace,
  resolveWorkspaceId,
  openGroups,
  closeTab,
};
