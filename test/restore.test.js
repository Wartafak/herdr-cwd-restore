"use strict";
// Unit tests for the pure parts of src/restore.js (reconcile planning).
// Herdr-spawning paths (openGroups, closeTab, getWorkspaceState) are covered
// by live verification instead.

const { describe, it, beforeEach, afterEach, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { planRestore, liveKey } = require("../src/restore");
const { loadProject, resolveTabDirs, ProjectError } = require("../src/utils/project");
const { groupByWorkspace } = require("../src/utils/herdr");

// Fixture writes stay inside the repo (test/.tmp/, git-ignored) under a
// file-specific subdir; only that subdir is cleaned (whole-dir wipes race
// with parallel test files).
const PROJECT_SCRATCH = path.join(__dirname, ".tmp", `restore-${process.pid}`);
after(() => {
  fs.rmSync(PROJECT_SCRATCH, { recursive: true, force: true });
});

let savedHome;
beforeEach(() => {
  savedHome = process.env.HOME;
});
afterEach(() => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
});

function entry(workspace, name, dir) {
  return { tab: { name, workspace, workingDir: null, command: null }, dir };
}

function live(tabId, workspace, label, cwd) {
  return { tabId, workspace, label, cwd };
}

describe("liveKey", () => {
  it("treats null workspace as empty", () => {
    assert.equal(liveKey(null, "a"), liveKey("", "a"));
    assert.notEqual(liveKey("W", "a"), liveKey("", "a"));
  });
});

describe("planRestore", () => {
  it("creates absent tabs without closing anything", () => {
    const { keep, replace, closeIds } = planRestore(
      [entry("A", "gone", "/a/gone")],
      [live("t1", "A", "other", "/a/other")]
    );
    assert.deepEqual(replace.map((e) => e.tab.name), ["gone"]);
    assert.deepEqual(keep, []);
    assert.deepEqual(closeIds, []);
  });

  it("keeps exact matches", () => {
    const { keep, replace, closeIds } = planRestore(
      [entry("A", "kept", "/a/kept")],
      [live("t1", "A", "kept", "/a/kept")]
    );
    assert.deepEqual(keep.map((e) => e.tab.name), ["kept"]);
    assert.deepEqual(replace, []);
    assert.deepEqual(closeIds, []);
  });

  it("closes and recreates wrong-directory tabs", () => {
    process.env.HOME = "/home/u";
    const { keep, replace, closeIds } = planRestore(
      [entry("A", "moved", "/saved")],
      [live("t1", "A", "moved", "~/elsewhere")]
    );
    assert.deepEqual(keep, []);
    assert.deepEqual(replace.map((e) => e.tab.name), ["moved"]);
    assert.deepEqual(closeIds, ["t1"]);
  });

  it("treats unreadable live cwds as deviating", () => {
    const { replace, closeIds } = planRestore(
      [entry("A", "empty", "/saved")],
      [live("t1", "A", "empty", "")]
    );
    assert.deepEqual(replace.map((e) => e.tab.name), ["empty"]);
    assert.deepEqual(closeIds, ["t1"]);
  });

  it("distinguishes same label across spaces", () => {
    const { keep, replace, closeIds } = planRestore(
      [entry("A", "shell", "/a"), entry("B", "shell", "/b")],
      [live("t1", "A", "shell", "/a"), live("t2", "B", "shell", "/wrong")]
    );
    assert.deepEqual(keep.map((e) => e.tab.workspace), ["A"]);
    assert.deepEqual(replace.map((e) => e.tab.workspace), ["B"]);
    assert.deepEqual(closeIds, ["t2"]);
  });

  it("keeps one correct duplicate and closes the extras", () => {
    const { keep, replace, closeIds } = planRestore(
      [entry("A", "dup", "/same")],
      [live("t1", "A", "dup", "/same"), live("t2", "A", "dup", "/same")]
    );
    assert.deepEqual(keep.map((e) => e.tab.name), ["dup"]);
    assert.deepEqual(replace, []);
    assert.deepEqual(closeIds, ["t2"]);
  });

  it("rebuilds everything when live state is empty", () => {
    const resolved = [entry("A", "a", "/a"), entry("B", "b", "/b")];
    const { keep, replace, closeIds } = planRestore(resolved, []);
    assert.equal(replace.length, 2);
    assert.deepEqual(keep, []);
    assert.deepEqual(closeIds, []);
  });
});

function writeProject(text) {
  fs.mkdirSync(PROJECT_SCRATCH, { recursive: true });
  const file = path.join(PROJECT_SCRATCH, `proj-${process.pid}.toml`);
  fs.writeFileSync(file, text);
  return file;
}

describe("loadProject", () => {
  it("parses name, working_dir and tab entries", () => {
    const project = loadProject(
      writeProject(
        'name = "workspace-state"\nworking_dir = "~/dev"\n\n[[tabs]]\nname = "api"\nworking_dir = "api"\nworkspace = "Space A"\n'
      )
    );
    assert.equal(project.name, "workspace-state");
    assert.equal(project.workingDir, "~/dev");
    assert.deepEqual(project.tabs, [
      { name: "api", workingDir: "api", command: null, workspace: "Space A" },
    ]);
  });

  it("rejects missing working_dir, nameless tabs and unknown keys", () => {
    assert.throws(
      () => loadProject(writeProject('name = "d"\n')),
      (e) => e instanceof ProjectError && /missing key 'working_dir'/.test(e.message)
    );
    assert.throws(
      () => loadProject(writeProject('name = "d"\nworking_dir = "/tmp"\n\n[[tabs]]\n')),
      (e) => e instanceof ProjectError && /missing key 'name'/.test(e.message)
    );
    assert.throws(
      () =>
        loadProject(
          writeProject('name = "d"\nworking_dir = "/tmp"\n\n[[tabs]]\nname = "x"\nbogus = "y"\n')
        ),
      (e) => e instanceof ProjectError && /invalid TOML/.test(e.message)
    );
  });
});

describe("resolveTabDirs", () => {
  it("expands ~, resolves relatives against the base, inherits base", () => {
    const home = path.join(PROJECT_SCRATCH, "home");
    process.env.HOME = home;
    const base = path.join(home, "dev");
    const api = path.join(base, "api");
    fs.mkdirSync(api, { recursive: true });
    const resolved = resolveTabDirs({
      workingDir: "~/dev",
      dir: home,
      tabs: [
        { name: "inherits", workingDir: null },
        { name: "relative", workingDir: "api" },
      ],
    });
    assert.equal(resolved[0].dir, base);
    assert.equal(resolved[1].dir, api);
  });

  it("throws listing every missing directory", () => {
    assert.throws(
      () =>
        resolveTabDirs({
          workingDir: "/definitely/not/here",
          dir: "/",
          tabs: [{ name: "gone", workingDir: null }],
        }),
      (e) => e instanceof ProjectError && /missing directories: 'gone'/.test(e.message)
    );
  });
});

describe("groupByWorkspace", () => {
  it("groups by workspace preserving first-seen order", () => {
    const groups = groupByWorkspace([
      { tab: { name: "a", workspace: "B" } },
      { tab: { name: "b", workspace: null } },
      { tab: { name: "c", workspace: "A" } },
      { tab: { name: "d", workspace: "B" } },
    ]);
    assert.deepEqual(
      groups.map((g) => [g.workspace, g.entries.map((e) => e.tab.name)]),
      [
        ["B", ["a", "d"]],
        [null, ["b"]],
        ["A", ["c"]],
      ]
    );
  });
});
