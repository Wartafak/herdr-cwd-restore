"use strict";
// Unit tests for the pure parts of src/open.js (parsing, naming, path
// resolution, workspace grouping). Herdr-spawning functions are covered by
// live verification instead.

const { describe, it, beforeEach, afterEach, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  loadProject,
  findProjectFile,
  resolveTabDirs,
  groupByWorkspace,
  slugifyWorkspaceLabel,
  defaultProjectName,
  ProjectError,
} = require("../src/open");

// All fixture writes stay inside the repo (test/.tmp/, git-ignored) --
// never the machine home folder or system temp dir. Wiped after the run.
const SCRATCH = path.join(__dirname, ".tmp");
let scratchSeq = 0;
function scratch() {
  const dir = path.join(SCRATCH, `case-${process.pid}-${scratchSeq++}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
after(() => {
  fs.rmSync(SCRATCH, { recursive: true, force: true });
});

// Env keys the tests borrow; always restored afterwards.
let savedEnv;
beforeEach(() => {
  savedEnv = {
    HERDR_PLUGIN_CONTEXT_JSON: process.env.HERDR_PLUGIN_CONTEXT_JSON,
    HERDR_PLUGIN_CONFIG_DIR: process.env.HERDR_PLUGIN_CONFIG_DIR,
    HOME: process.env.HOME,
  };
});
afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function writeProject(dir, text) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "proj.toml");
  fs.writeFileSync(file, text);
  return file;
}

describe("slugifyWorkspaceLabel", () => {
  it("lowercases and dashes separators", () => {
    assert.equal(slugifyWorkspaceLabel("My Projects"), "my-projects");
  });

  it("trims leading/trailing dashes", () => {
    assert.equal(slugifyWorkspaceLabel("  spaces  "), "spaces");
  });

  it("slugs symbols-only labels to empty", () => {
    assert.equal(slugifyWorkspaceLabel("!!!"), "");
  });
});

describe("defaultProjectName", () => {
  it("reads the flat workspace_label", () => {
    process.env.HERDR_PLUGIN_CONTEXT_JSON = JSON.stringify({ workspace_label: "My Projects" });
    assert.equal(defaultProjectName(), "my-projects");
  });

  it("reads the nested workspace label", () => {
    process.env.HERDR_PLUGIN_CONTEXT_JSON = JSON.stringify({
      workspace: { label: "Demo Space" },
    });
    assert.equal(defaultProjectName(), "demo-space");
  });

  it("returns null without context or with garbage", () => {
    delete process.env.HERDR_PLUGIN_CONTEXT_JSON;
    assert.equal(defaultProjectName(), null);
    process.env.HERDR_PLUGIN_CONTEXT_JSON = "not json";
    assert.equal(defaultProjectName(), null);
    process.env.HERDR_PLUGIN_CONTEXT_JSON = JSON.stringify({ workspace_label: "!!!" });
    assert.equal(defaultProjectName(), null);
  });
});

describe("loadProject", () => {
  it("parses name, working_dir and tab entries", () => {
    const dir = scratch();
    const file = writeProject(
      dir,
      'name = "demo"\nworking_dir = "~/dev"\n\n[[tabs]]\nname = "api"\nworking_dir = "api"\ncommand = "npm run dev"\nworkspace = "Space A"\n'
    );
    const project = loadProject(file);
    assert.equal(project.name, "demo");
    assert.equal(project.workingDir, "~/dev");
    assert.deepEqual(project.tabs, [
      { name: "api", workingDir: "api", command: "npm run dev", workspace: "Space A" },
    ]);
  });

  it("defaults optional tab keys to null", () => {
    const dir = scratch();
    const file = writeProject(dir, 'name = "d"\nworking_dir = "/tmp"\n\n[[tabs]]\nname = "bare"\n');
    const [tab] = loadProject(file).tabs;
    assert.deepEqual(tab, { name: "bare", workingDir: null, command: null, workspace: null });
  });

  it("rejects missing working_dir, nameless tabs and unknown keys", () => {
    const dir = scratch();
    assert.throws(
      () => loadProject(writeProject(dir, 'name = "d"\n')),
      (e) => e instanceof ProjectError && /missing key 'working_dir'/.test(e.message)
    );
    assert.throws(
      () => loadProject(writeProject(dir, 'name = "d"\nworking_dir = "/tmp"\n\n[[tabs]]\n')),
      (e) => e instanceof ProjectError && /missing key 'name'/.test(e.message)
    );
    assert.throws(
      () =>
        loadProject(
          writeProject(dir, 'name = "d"\nworking_dir = "/tmp"\n\n[[tabs]]\nname = "x"\nbogus = "y"\n')
        ),
      (e) => e instanceof ProjectError && /invalid TOML/.test(e.message)
    );
  });
});

describe("findProjectFile", () => {
  it("prefers exact match over case-insensitive fallback", () => {
    // Separate dirs: macOS default filesystems are case-insensitive, so
    // "demo.toml" and "Demo.toml" would be the same file on disk.
    let dir = scratch();
    fs.writeFileSync(path.join(dir, "demo.toml"), "x");
    fs.writeFileSync(path.join(dir, "other.toml"), "x");
    assert.equal(findProjectFile(dir, "demo"), path.join(dir, "demo.toml"));
    dir = scratch();
    fs.writeFileSync(path.join(dir, "Demo.toml"), "x");
    assert.equal(findProjectFile(dir, "demo"), path.join(dir, "Demo.toml"));
  });

  it("lists available projects on unknown names", () => {
    const dir = scratch();
    fs.writeFileSync(path.join(dir, "alpha.toml"), "x");
    assert.throws(
      () => findProjectFile(dir, "nope"),
      (e) => e instanceof ProjectError && /unknown project 'nope'.*available: alpha/.test(e.message)
    );
  });
});

describe("resolveTabDirs", () => {
  it("expands ~, resolves relatives against the base, inherits base", () => {
    const home = path.join(scratch(), "home");
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
