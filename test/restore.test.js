"use strict";
// Unit tests for the pure parts of src/restore.js (reconcile planning).
// Herdr-spawning paths (openGroups, closeTab, getWorkspaceState) are covered
// by live verification instead.

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const { planRestore, liveKey } = require("../src/restore");

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
