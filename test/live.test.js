"use strict";
// Unit tests for src/live.js (pure helpers only; collectLiveRows needs a
// running Herdr server and is covered by live verification instead).

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { shortenHome } = require("../src/live");

describe("shortenHome", () => {
  it("abbreviates paths under $HOME", () => {
    const saved = process.env.HOME;
    process.env.HOME = "/Users/tester";
    try {
      assert.equal(shortenHome("/Users/tester/dev"), "~/dev");
      assert.equal(shortenHome("/Users/tester"), "~");
      assert.equal(shortenHome("/other/place"), "/other/place");
      // Prefix match without a path separator must not abbreviate.
      assert.equal(shortenHome("/Users/tester2/dev"), "/Users/tester2/dev");
    } finally {
      process.env.HOME = saved;
    }
  });

  it("leaves paths alone when $HOME is unset", () => {
    const saved = process.env.HOME;
    delete process.env.HOME;
    try {
      assert.equal(shortenHome("/Users/tester/dev"), "/Users/tester/dev");
    } finally {
      process.env.HOME = saved;
    }
  });
});
