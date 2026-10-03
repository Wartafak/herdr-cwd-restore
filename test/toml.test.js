"use strict";
// Unit tests for src/utils/toml.js. Run: node --test test/toml.test.js
// (or `npm test` from the repo root). No external dependencies.

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  tomlString,
  parseTomlString,
  splitEntries,
  parseEntry,
} = require("../src/utils/toml");

describe("tomlString", () => {
  it("quotes plain strings", () => {
    assert.equal(tomlString("hello"), '"hello"');
  });

  it("escapes embedded quotes via JSON rules", () => {
    assert.equal(tomlString('say "hi"'), '"say \\"hi\\""');
  });
});

describe("parseTomlString", () => {
  it("parses basic strings", () => {
    assert.equal(parseTomlString('"abc"'), "abc");
  });

  it("parses literal strings verbatim", () => {
    assert.equal(parseTomlString("'a\\nb'"), "a\\nb");
  });

  it("rejects multiline literal strings", () => {
    assert.equal(parseTomlString("'a\nb'"), null);
  });

  it("rejects bare values", () => {
    assert.equal(parseTomlString("123"), null);
    assert.equal(parseTomlString("true"), null);
  });

  it("rejects unterminated strings", () => {
    assert.equal(parseTomlString('"abc'), null);
    assert.equal(parseTomlString(""), null);
  });
});

describe("splitEntries", () => {
  it("splits active entries on blank lines", () => {
    const chunks = splitEntries('[[tabs]]\nlabel = "a"\n\n[[tabs]]\nlabel = "b"\n');
    const entries = chunks.filter((c) => c.kind === "entry");
    assert.equal(entries.length, 2);
    assert.ok(entries.every((e) => e.active));
  });

  it("marks commented entries inactive", () => {
    const chunks = splitEntries('# [[tabs]]\n# label = "a"\n');
    const entries = chunks.filter((c) => c.kind === "entry");
    assert.equal(entries.length, 1);
    assert.equal(entries[0].active, false);
  });

  it("keeps header comments as other chunks", () => {
    const chunks = splitEntries('# hello\n\n[[tabs]]\nlabel = "a"\n');
    assert.equal(chunks[0].kind, "other");
    assert.equal(chunks[1].kind, "entry");
  });
});

describe("parseEntry", () => {
  it("reads active label and cwd", () => {
    const entry = parseEntry(true, ["[[tabs]]", 'label = "a"', 'cwd = "/x"']);
    assert.equal(entry.label, "a");
    assert.equal(entry.cwd, "/x");
    assert.equal(entry.updatable, true);
  });

  it("prefers active keys over commented ones", () => {
    const entry = parseEntry(true, [
      "[[tabs]]",
      '# label = "old"',
      'label = "new"',
      '# cwd = "/old"',
      'cwd = "/new"',
    ]);
    assert.equal(entry.label, "new");
    assert.equal(entry.cwd, "/new");
    assert.equal(entry.labelCommented, false);
  });

  it("falls back to commented keys with flags", () => {
    const entry = parseEntry(false, ["# [[tabs]]", '# label = "a"', '# cwd = "/x"']);
    assert.equal(entry.label, "a");
    assert.equal(entry.cwd, "/x");
    assert.equal(entry.labelCommented, true);
    assert.equal(entry.cwdCommented, true);
    assert.equal(entry.updatable, false);
  });

  it("skips unparsable values instead of failing", () => {
    const entry = parseEntry(true, ["[[tabs]]", "label = 123", 'cwd = "/x"']);
    assert.equal(entry.label, null);
    assert.equal(entry.cwd, "/x");
    assert.equal(entry.updatable, false);
  });
});
