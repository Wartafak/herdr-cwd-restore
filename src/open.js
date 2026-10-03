"use strict";
// Open a declarative project workspace: create one herdr tab per `[[tabs]]`
// entry, each natively started in its working directory, then run its command.
//
// This is the herdr-plus-style counterpart to blind `cd` restores. Typing
// `cd` can never fix an agent-owned pane (keystrokes land in the agent TUI,
// not the shell), and racing Herdr's own session restore is fragile -- so for
// agent-heavy workspaces the durable fix is to launch each tab already in the
// right directory via `herdr tab create --cwd` and start the agent (or dev
// server, or shell) there from birth.
//
// Project files live in `projects/` inside the plugin config dir:
//
//   name = "Shop"
//   working_dir = "~/dev/shop"
//
//   [[tabs]]
//   name = "web"
//   working_dir = "frontend"   # relative to the project working_dir
//   command = "npm run dev"    # optional; no command = just an empty shell
//
//   [[tabs]]
//   name = "shell"             # no working_dir = the project's working_dir
//
//   [[tabs]]
//   name = "api"
//   workspace = "Shop Spaces"  # optional; no workspace = the invoking space.
//                              # Named spaces are reused by exact label when
//                              # present, otherwise created fresh.
//
// The project to open comes from `$HERDR_WORKSPACE_AUTOSAVE_PROJECT` or from argv[2]
// when run directly as `node src/open.js <name>` (handy for shell aliases).
// `herdr plugin action invoke` takes no arguments and does not forward the
// caller's environment, so for invocations the name falls back to the
// slugified workspace label from `$HERDR_PLUGIN_CONTEXT_JSON` (e.g. the
// "My Projects" workspace opens `projects/my-projects.toml`).
// All directories are verified to exist *before* the first tab is created, so
// a typo never leaves a half-built workspace behind.

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { parseTomlString } = require("./utils/toml");

const PLUGIN_ID = "herdr-workspace-autosave";
const PROJECTS_DIR_NAME = "projects";

class ProjectError extends Error {}

function herdrBinary() {
  return process.env.HERDR_BIN_PATH || "herdr";
}

// Config *directory* lookup (project files live in `projects/` underneath
// it): $HERDR_PLUGIN_CONFIG_DIR first, then the XDG/HOME fallbacks.
function resolveConfigDir() {
  const candidates = [];
  if (process.env.HERDR_PLUGIN_CONFIG_DIR) {
    candidates.push(process.env.HERDR_PLUGIN_CONFIG_DIR);
  }
  if (process.env.XDG_CONFIG_HOME) {
    candidates.push(
      path.join(process.env.XDG_CONFIG_HOME, "herdr", "plugins", "config", PLUGIN_ID)
    );
  }
  const home = process.env.HOME || "";
  candidates.push(
    path.join(home, ".config", "herdr", "plugins", "config", PLUGIN_ID)
  );
  candidates.push(
    path.join(home, ".config", PLUGIN_ID)
  );
  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate).isDirectory()) return candidate;
    } catch {
      // missing -- try the next candidate
    }
  }
  throw new ProjectError(
    `no plugin config directory found in: ${candidates.join(", ")}`
  );
}

// Raw workspace label from the invocation context (present for
// action/event hooks, absent for direct shell runs). Null when unknown.
function contextWorkspaceLabel() {
  const raw = process.env.HERDR_PLUGIN_CONTEXT_JSON;
  if (!raw) return null;
  let context;
  try {
    context = JSON.parse(raw);
  } catch {
    return null;
  }
  const label =
    context.workspace_label ||
    (context.workspace || {}).label ||
    null;
  if (typeof label !== "string" || label.trim() === "") return null;
  return label;
}

// "My Projects" -> "my-projects". Symbols-only labels slug to "" (no default).
function slugifyWorkspaceLabel(label) {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// Project name when none was passed explicitly: the slugified workspace label
// from the invocation context (present for action/event hooks, absent for
// direct shell runs). Returns null when there is nothing to derive one from.
function defaultProjectName() {
  const label = contextWorkspaceLabel();
  if (label === null) return null;
  const slug = slugifyWorkspaceLabel(label);
  return slug === "" ? null : slug;
}

function expandUser(text) {
  const home = process.env.HOME || os.homedir();
  if (text === "~" || text.startsWith("~/")) return home + text.slice(1);
  const username = os.userInfo().username;
  if (text === `~${username}` || text.startsWith(`~${username}/`)) {
    return home + text.slice(username.length + 1);
  }
  return text;
}

function expandVars(text) {
  return text.replace(/\$(\w+|\{[^}]*\})/g, (m, name) => {
    if (name.startsWith("{") && name.endsWith("}")) name = name.slice(1, -1);
    return Object.prototype.hasOwnProperty.call(process.env, name)
      ? process.env[name]
      : m;
  });
}

// Parse one project file: top-level `name` + `working_dir`, then `[[tabs]]`
// entries with `name`, optional `working_dir`, optional `command`, optional
// `workspace` (tabs without one open in the invoking workspace).
function loadProject(projectPath) {
  const text = fs.readFileSync(projectPath, "utf8");
  const project = { name: null, workingDir: null, tabs: [], dir: path.dirname(projectPath) };
  let currentTab = null;
  const finishTab = () => {
    if (currentTab !== null) {
      project.tabs.push(currentTab);
      currentTab = null;
    }
  };
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    if (/^\[\[tabs\]\]/.test(trimmed)) {
      finishTab();
      currentTab = { name: null, workingDir: null, command: null, workspace: null };
      continue;
    }
    if (trimmed.startsWith("[")) continue; // unknown table: ignore
    const kv = /^([A-Za-z0-9_-]+)\s*=\s*(.+?)\s*$/.exec(line);
    if (!kv) {
      throw new ProjectError(`invalid TOML in ${projectPath}: ${trimmed}`);
    }
    const value = parseTomlString(kv[2]);
    if (value === null) {
      throw new ProjectError(`invalid TOML in ${projectPath}: ${trimmed}`);
    }
    const target = currentTab !== null ? currentTab : project;
    if (currentTab !== null) {
      if (kv[1] === "name") target.name = value;
      else if (kv[1] === "working_dir") target.workingDir = value;
      else if (kv[1] === "command") target.command = value;
      else if (kv[1] === "workspace") target.workspace = value;
      else {
        throw new ProjectError(`invalid TOML in ${projectPath}: ${trimmed}`);
      }
    } else {
      if (kv[1] === "name") target.name = value;
      else if (kv[1] === "working_dir") target.workingDir = value;
      else {
        throw new ProjectError(`invalid TOML in ${projectPath}: ${trimmed}`);
      }
    }
  }
  finishTab();
  if (project.workingDir === null) {
    throw new ProjectError(`project missing key 'working_dir' in ${projectPath}`);
  }
  project.tabs.forEach((tab, index) => {
    if (tab.name === null) {
      throw new ProjectError(
        `tab entry #${index + 1} missing key 'name' in ${projectPath}`
      );
    }
  });
  return project;
}

// Find `projects/<name>.toml`: exact match first, case-insensitive fallback.
function findProjectFile(projectsDir, name) {
  let files;
  try {
    files = fs.readdirSync(projectsDir).filter((f) => f.endsWith(".toml"));
  } catch {
    throw new ProjectError(`no projects directory at ${projectsDir}`);
  }
  const exact = files.find((f) => f.slice(0, -5) === name);
  if (exact) return path.join(projectsDir, exact);
  const folded = files.find((f) => f.slice(0, -5).toLowerCase() === name.toLowerCase());
  if (folded) return path.join(projectsDir, folded);
  const available = files.map((f) => f.slice(0, -5));
  throw new ProjectError(
    `unknown project '${name}'` +
      (available.length > 0 ? ` (available: ${available.join(", ")})` : " (no projects defined)")
  );
}

// Resolve every tab directory (expand ~/$VARS; relative paths resolve against
// the project working_dir, which itself resolves against the project file's
// directory when relative) and verify all exist before anything is created.
function resolveTabDirs(project) {
  const baseRaw = expandVars(expandUser(project.workingDir));
  const base = path.isAbsolute(baseRaw)
    ? baseRaw
    : path.resolve(project.dir || process.cwd(), baseRaw);
  const resolved = project.tabs.map((tab) => {
    if (tab.workingDir === null) return { tab, dir: base };
    const expanded = expandVars(expandUser(tab.workingDir));
    const dir = path.isAbsolute(expanded) ? expanded : path.resolve(base, expanded);
    return { tab, dir };
  });
  const missing = resolved.filter(({ dir }) => {
    try {
      return !fs.statSync(dir).isDirectory();
    } catch {
      return true;
    }
  });
  if (missing.length > 0) {
    throw new ProjectError(
      `missing directories: ${missing
        .map(({ tab, dir }) => `'${tab.name}' -> ${dir}`)
        .join(", ")}`
    );
  }
  return resolved;
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
// `workspace create` also spawns a default tab the template did not ask for,
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

// Best-effort removal of the default tab `workspace create` spawns; a failure
// is only a warning -- the workspace itself is still usable.
function closeTab(tabId) {
  const closed = spawnSync(herdrBinary(), ["tab", "close", tabId], { encoding: "utf8" });
  if (closed.status !== 0) {
    console.error(
      `herdr-workspace-autosave: warning: could not close default tab ${tabId}: ` +
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

function main() {
  const name =
    process.env.HERDR_WORKSPACE_AUTOSAVE_PROJECT || process.argv[2] || defaultProjectName();
  if (!name) {
    console.error(
      "herdr-workspace-autosave: no project given; set HERDR_WORKSPACE_AUTOSAVE_PROJECT, pass a name, or invoke from a workspace"
    );
    return 2;
  }
  try {
    const projectsDir = path.join(resolveConfigDir(), PROJECTS_DIR_NAME);
    const projectPath = findProjectFile(projectsDir, name);
    const project = loadProject(projectPath);
    const resolved = resolveTabDirs(project);
    openGroups(resolved);
  } catch (error) {
    if (error instanceof ProjectError) {
      console.error(`herdr-workspace-autosave: ${error.message}`);
      return 1;
    }
    throw error;
  }
  return 0;
}

if (require.main === module) {
  process.exit(main());
}

module.exports = {
  resolveConfigDir,
  loadProject,
  findProjectFile,
  resolveTabDirs,
  groupByWorkspace,
  resolveWorkspaceId,
  openGroups,
  closeTab,
  slugifyWorkspaceLabel,
  defaultProjectName,
  ProjectError,
};
