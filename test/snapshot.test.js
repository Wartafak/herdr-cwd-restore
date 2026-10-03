"use strict";
// Unit tests for the pure parts of src/snapshot.js (arg parsing, ancestor
// computation, tab collection, rendering, backup rotation). Live Herdr reads
// are covered by live verification instead.

const { describe, it, beforeEach, afterEach, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  parseArgs,
  groupByLabel,
  collectProjectTabs,
  commonAncestor,
  renderProject,
  rotateBackup,
} = require("../src/snapshot");

// Rotation fixtures stay inside the repo (test/.tmp/, git-ignored) under a
// file-specific subdir; only that subdir is cleaned (whole-dir wipes race
// with parallel test files).
const ROTATE_SCRATCH = path.join(__dirname, ".tmp", `rotate-${process.pid}`);
after(() => {
  fs.rmSync(ROTATE_SCRATCH, { recursive: true, force: true });
});

let savedError;
beforeEach(() => {
  // parseArgs failure paths log to stderr; keep test output clean.
  savedError = console.error;
  console.error = () => {};
});
afterEach(() => {
  console.error = savedError;
});

describe("parseArgs", () => {
  it("defaults to writing the state file", () => {
    assert.deepEqual(parseArgs([]), { stdout: false });
  });

  it("supports --stdout preview", () => {
    assert.deepEqual(parseArgs(["--stdout"]), { stdout: true });
  });

  it("rejects anything else", () => {
    assert.equal(parseArgs(["--bogus"]), null);
    assert.equal(parseArgs(["somename"]), null);
    assert.equal(parseArgs(["--force"]), null);
  });
});

describe("groupByLabel", () => {
  it("groups flat state by label", () => {
    const grouped = groupByLabel([
      { workspace: "A", label: "x", cwd: "/a" },
      { workspace: "B", label: "x", cwd: "/b" },
    ]);
    assert.deepEqual([...grouped.keys()], ["x"]);
    assert.equal(grouped.get("x").length, 2);
  });
});

describe("commonAncestor", () => {
  it("finds the longest shared prefix", () => {
    assert.equal(commonAncestor(["/a/b/c", "/a/b/d", "/a/b/e/f"]), "/a/b");
  });

  it("returns / for unrelated paths and the path itself for one", () => {
    assert.equal(commonAncestor(["/a", "/b"]), "/");
    assert.equal(commonAncestor(["/only"]), "/only");
  });
});

function rows(pairs) {
  // pairs: [workspace, label, cwd][] -> Map<label, rows[]>
  const map = new Map();
  for (const [workspace, label, cwd] of pairs) {
    if (!map.has(label)) map.set(label, []);
    map.get(label).push({ workspace, label, cwd });
  }
  return map;
}

describe("collectProjectTabs", () => {
  it("sorts by workspace then label", () => {
    const { tabs, warnings } = collectProjectTabs(
      rows([
        ["B", "z", "/b/z"],
        ["A", "b", "/a/b"],
        ["A", "a", "/a/a"],
      ])
    );
    assert.deepEqual(warnings, []);
    assert.deepEqual(
      tabs.map((t) => [t.workspace, t.name]),
      [
        ["A", "a"],
        ["A", "b"],
        ["B", "z"],
      ]
    );
  });

  it("keeps the same label once per space", () => {
    const { tabs, warnings } = collectProjectTabs(
      rows([
        ["A", "shell", "/a"],
        ["B", "shell", "/b"],
      ])
    );
    assert.deepEqual(warnings, []);
    assert.equal(tabs.length, 2);
  });

  it("skips same-space duplicates and unreadable cwds with warnings", () => {
    const { tabs, warnings } = collectProjectTabs(
      rows([
        ["A", "dup", "/x"],
        ["A", "dup", "/y"],
        ["A", "empty", ""],
      ])
    );
    assert.deepEqual(tabs, []);
    assert.equal(warnings.length, 2);
    assert.match(warnings[0], /'dup' in workspace 'A' \(2 different directories\)/);
    assert.match(warnings[1], /'empty' \(no readable working directory\)/);
  });
});

describe("rotateBackup", () => {
  it("copies the existing file to .prev.toml and ignores missing files", () => {
    const dir = ROTATE_SCRATCH;
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    const out = path.join(dir, "workspace-state.toml");
    rotateBackup(out); // missing: nothing to back up, no throw
    fs.writeFileSync(out, "v1");
    rotateBackup(out);
    assert.equal(fs.readFileSync(path.join(dir, "workspace-state.prev.toml"), "utf8"), "v1");
    fs.writeFileSync(out, "v2");
    rotateBackup(out);
    assert.equal(fs.readFileSync(path.join(dir, "workspace-state.prev.toml"), "utf8"), "v2");
  });
});

describe("renderProject", () => {
  it("emits workspace keys and omits inherited dirs", () => {
    const text = renderProject("/base", [
      { name: "a", workspace: "Space", workingDir: "/base/a" },
      { name: "b", workspace: "Space", workingDir: null },
      { name: "c", workspace: "", workingDir: "/elsewhere" },
    ]);
    assert.match(text, /name = "workspace-state"/);
    assert.match(text, /working_dir = "\/base"/);
    assert.match(text, /name = "a"\nworkspace = "Space"\nworking_dir = "\/base\/a"/);
    const bBlock = text.split("[[tabs]]")[2];
    assert.ok(!bBlock.includes("working_dir"));
    assert.ok(!text.split("[[tabs]]")[3].includes("workspace = "));
  });

  it("marks the file as an auto-generated mirror", () => {
    assert.match(renderProject("/", []), /do not hand-edit/);
  });
});
