"use strict";
// Project file parsing and directory resolution. The only project file is
// `projects/workspace-state.toml`:
//
//   name = "workspace-state"
//   working_dir = "~/dev/shop"
//
//   [[tabs]]
//   name = "web"
//   workspace = "Shop"       # optional; no workspace = the invoking workspace.
//   working_dir = "frontend" # relative to the project working_dir
//
// Relative tab dirs resolve against the project working_dir, which itself
// resolves against the project file's directory when relative. `~` and
// $VARS are expanded. resolveTabDirs verifies every directory exists before
// returning, so callers never act on a half-valid layout.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { parseTomlString } = require("./toml");

class ProjectError extends Error {}

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

// Resolve every tab directory and verify all exist before returning.
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

module.exports = {
  loadProject,
  resolveTabDirs,
  ProjectError,
};
