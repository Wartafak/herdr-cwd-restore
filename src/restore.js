"use strict";
// Startup restore: reconcile the live session with `projects/workspace-state.toml`,
// which is the source of truth.
//
// Herdr restores workspaces, tabs, panes, and cwds itself on server start;
// this hook then enforces the saved layout entry by entry, keyed by
// (workspace, label):
// - entry absent live -> created (workspaces reused by exact label or created).
// - entry present once with the saved directory -> kept.
// - entry present with a different directory, duplicated, or unreadable ->
//   closed and recreated from the saved definition.
//
// Closing a wrongly-restored tab kills whatever it runs (including a resumed
// agent session); that is the point -- a tab in the wrong directory is worse
// than a fresh one in the right directory. Every close and create is logged.
// All directories are verified before anything is closed or created, so a
// typo never leaves a half-torn-down session behind.
//
// Usage (via the `[[startup]]` manifest hook; takes no arguments):
//     node src/restore.js

const fs = require("node:fs");
const path = require("node:path");
const { getWorkspaceState, LiveError } = require("./utils/workspace-state");
const { resolveConfigDir } = require("./utils/config");
const { loadProject, resolveTabDirs, ProjectError } = require("./utils/project");
const { openGroups, closeTab } = require("./utils/herdr");

const PROJECTS_DIR_NAME = "projects";
const STATE_NAME = "workspace-state";

class RestoreError extends Error {}

function liveKey(workspace, label) {
  return `${workspace || ""}	${label}`;
}

function expandHomeOnly(p) {
  // Live cwds carry at most a leading `~` (see workspace-state.js shortenHome).
  const home = process.env.HOME || "";
  if (p === "~") return home;
  if (home && p.startsWith("~/")) return home + p.slice(1);
  return p;
}

// Reconcile resolved autosave entries against live tabs. Returns:
// - keep: entries with exactly one live tab already in the saved directory.
// - replace: entries to (re)create -- absent live, mismatched, or duplicated.
// - closeIds: live tab ids to close first (wrong-dir and duplicate tabs).
function planRestore(resolved, liveTabs) {
  const byKey = new Map();
  for (const tab of liveTabs) {
    const key = liveKey(tab.workspace, tab.label);
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(tab);
  }
  const keep = [];
  const replace = [];
  const closeIds = [];
  for (const entry of resolved) {
    const live = byKey.get(liveKey(entry.tab.workspace, entry.tab.name)) || [];
    const good = live.filter((t) => t.cwd !== "" && expandHomeOnly(t.cwd) === entry.dir);
    if (live.length === 0) {
      replace.push(entry);
      continue;
    }
    const keepOne = good.length > 0 ? good[0] : null;
    for (const tab of live) {
      if (tab !== keepOne) closeIds.push(tab.tabId);
    }
    if (keepOne) keep.push(entry);
    else replace.push(entry);
  }
  return { keep, replace, closeIds };
}

function main() {
  let statePath;
  try {
    statePath = path.join(resolveConfigDir(), PROJECTS_DIR_NAME, `${STATE_NAME}.toml`);
  } catch (error) {
    if (error instanceof ProjectError) {
      console.error(`restore: ${error.message}; skipping`);
      return 0;
    }
    throw error;
  }
  try {
    if (!fs.statSync(statePath).isFile()) {
      console.error(`restore: no ${statePath} yet; skipping`);
      return 0;
    }
  } catch {
    console.error(`restore: no ${statePath} yet; skipping`);
    return 0;
  }
  try {
    const project = loadProject(statePath);
    // Verifies all dirs exist before closing or creating anything.
    const resolved = resolveTabDirs(project);
    const { keep, replace, closeIds } = planRestore(resolved, getWorkspaceState());
    for (const tabId of closeIds) {
      console.error(`restore: closing deviating tab ${tabId}`);
      closeTab(tabId);
    }
    if (replace.length === 0) {
      console.error(`restore: all ${keep.length} tab(s) already match; nothing to do`);
      return 0;
    }
    openGroups(replace);
    console.error(
      `restore: (re)created ${replace.length} tab(s), kept ${keep.length} matching tab(s)`
    );
    return 0;
  } catch (error) {
    if (error instanceof ProjectError || error instanceof LiveError) {
      console.error(`restore: ${error.message}`);
      return 1;
    }
    throw error;
  }
}

if (require.main === module) {
  process.exit(main());
}

module.exports = {
  planRestore,
  liveKey,
  RestoreError,
};
