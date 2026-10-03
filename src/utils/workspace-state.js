"use strict";
// Live Herdr state: the single reader every other script consumes.
//
// Returns the current workspace layout as a flat list of
// [{ tabId, workspace, label, cwd }] with ~-abbreviated cwds ("" when a tab
// has no pane with a readable foreground_cwd).
//
// Tab objects expose no cwd (`herdr tab list` yields agent_status, focused,
// label, number, pane_count, tab_id, workspace_id), so each tab's directory
// comes from its panes' `foreground_cwd` (`herdr pane list`). Workspace
// labels come from `herdr workspace list`.

const { spawnSync } = require("node:child_process");

class LiveError extends Error {}

function herdrBinary() {
  return process.env.HERDR_BIN_PATH || "herdr";
}

function runHerdrJson(...args) {
  const binary = herdrBinary();
  let result;
  try {
    result = spawnSync(binary, args, { encoding: "utf8" });
  } catch {
    throw new LiveError(`herdr executable not found at '${binary}'`);
  }
  if (result.error && result.error.code === "ENOENT") {
    throw new LiveError(`herdr executable not found at '${binary}'`);
  }
  if (result.status !== 0) {
    throw new LiveError(`herdr ${args.join(" ")} failed: ${(result.stderr || "").trim()}`);
  }
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    throw new LiveError(`could not parse herdr ${args.join(" ")} output: ${error.message}`);
  }
}

// "/Users/x/dev" -> "~/dev" when $HOME is "/Users/x"; otherwise unchanged.
function shortenHome(p) {
  const home = process.env.HOME || "";
  if (home !== "" && (p === home || p.startsWith(home + "/"))) {
    return "~" + p.slice(home.length);
  }
  return p;
}

function utcStamp() {
  return new Date().toISOString();
}

// The current workspace layout: [{ tabId, workspace, label, cwd }].
function getWorkspaceState() {
  const workspaces = ((runHerdrJson("workspace", "list").result || {}).workspaces || []);
  const wsById = new Map(workspaces.map((w) => [w.workspace_id, w.label]));
  const tabs = ((runHerdrJson("tab", "list").result || {}).tabs || []);
  const panes = ((runHerdrJson("pane", "list").result || {}).panes || []);
  const cwdByTab = new Map();
  for (const pane of panes) {
    if (!cwdByTab.has(pane.tab_id) && pane.foreground_cwd) {
      cwdByTab.set(pane.tab_id, pane.foreground_cwd);
    }
  }
  return tabs.map((tab) => {
    const raw = cwdByTab.get(tab.tab_id) || "";
    return {
      tabId: tab.tab_id,
      workspace: wsById.get(tab.workspace_id) || "",
      label: tab.label,
      cwd: raw ? shortenHome(raw) : "",
    };
  });
}

module.exports = { getWorkspaceState, shortenHome, utcStamp, LiveError };
