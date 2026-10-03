"use strict";
// Unit tests for the pure parts of src/capture.js (arg parsing, ancestor
// computation, tab collection, rendering). Live Herdr reads are covered by
// live verification instead.

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const {
  parseArgs,
  collectProjectTabs,
  commonAncestor,
  renderProject,
  validProjectName,
} = require("../src/capture");

let savedEnv;
let savedError;
beforeEach(() => {
  savedEnv = {
    HERDR_TAB_CWD_PROJECT: process.env.HERDR_TAB_CWD_PROJECT,
    HERDR_PLUGIN_CONTEXT_JSON: process.env.HERDR_PLUGIN_CONTEXT_JSON,
  };
  // parseArgs failure paths log to stderr; keep test output clean.
  savedError = console.error;
  console.error = () => {};
});
afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  console.error = savedError;
});

describe("validProjectName", () => {
  it("accepts plain names, rejects paths and dots", () => {
    assert.equal(validProjectName("myproj"), true);
    assert.equal(validProjectName("autosave"), true);
    for (const bad of ["", ".", "..", "a/b", "a\\b"]) {
      assert.equal(validProjectName(bad), false);
    }
  });
});

describe("parseArgs", () => {
  it("parses flags and --out forms", () => {
    assert.deepEqual(parseArgs(["--force", "--stdout", "myproj"]), {
      name: "myproj",
      force: true,
      stdout: true,
      out: null,
      autosave: false,
    });
    assert.equal(parseArgs(["--out", "x.toml", "p"]).out, "x.toml");
    assert.equal(parseArgs(["--out=x.toml", "p"]).out, "x.toml");
  });

  it("forces name and overwrite for --autosave", () => {
    assert.deepEqual(parseArgs(["--autosave"]), {
      name: "autosave",
      force: true,
      stdout: false,
      out: null,
      autosave: true,
    });
  });

  it("rejects bad combinations", () => {
    assert.equal(parseArgs(["--autosave", "other"]), null);
    assert.equal(parseArgs(["--bogus"]), null);
    assert.equal(parseArgs(["a", "b"]), null);
    assert.equal(parseArgs(["--out"]), null);
  });

  it("falls back to env then workspace slug", () => {
    delete process.env.HERDR_TAB_CWD_PROJECT;
    delete process.env.HERDR_PLUGIN_CONTEXT_JSON;
    assert.equal(parseArgs([]).name, null);
    process.env.HERDR_TAB_CWD_PROJECT = "from-env";
    assert.equal(parseArgs([]).name, "from-env");
    delete process.env.HERDR_TAB_CWD_PROJECT;
    process.env.HERDR_PLUGIN_CONTEXT_JSON = JSON.stringify({ workspace_label: "My Projects" });
    assert.equal(parseArgs([]).name, "my-projects");
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

describe("renderProject", () => {
  it("emits workspace keys and omits inherited dirs", () => {
    const text = renderProject("demo", "/base", [
      { name: "a", workspace: "Space", workingDir: "/base/a" },
      { name: "b", workspace: "Space", workingDir: null },
      { name: "c", workspace: "", workingDir: "/elsewhere" },
    ]);
    assert.match(text, /name = "demo"/);
    assert.match(text, /working_dir = "\/base"/);
    assert.match(text, /name = "a"\nworkspace = "Space"\nworking_dir = "\/base\/a"/);
    const bBlock = text.split("[[tabs]]")[2];
    assert.ok(!bBlock.includes("working_dir"));
    assert.ok(!text.split("[[tabs]]")[3].includes("workspace = "));
  });

  it("notes automatic regeneration for the autosave file", () => {
    assert.match(renderProject("autosave", "/", []), /Regenerated automatically/);
    assert.match(renderProject("demo", "/", []), /Recapture with/);
  });
});
