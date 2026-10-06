"use strict";
// Tests for setup-cd-hook.sh: installs the `cd` hook lines into the shell
// rc file idempotently. The script is exercised as a subprocess with an
// isolated HOME (and XDG_CONFIG_HOME / ZDOTDIR) so it never touches the
// real user files. The plugin root defaults to this checkout, which already
// contains src/snapshot.sh and the src/shell hooks.

const { describe, it, after } = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const SETUP_HOOK = path.join(__dirname, "..", "setup-cd-hook.sh");
// Fixtures stay inside the repo (test/.tmp/, git-ignored) under a
// file-specific subdir; only that subdir is cleaned (whole-dir wipes race
// with parallel test files).
const SCRATCH = path.join(__dirname, ".tmp", `setup-cd-hook-${process.pid}`);
after(() => {
  fs.rmSync(SCRATCH, { recursive: true, force: true });
});

function freshHome(name) {
  const home = path.join(SCRATCH, name, "home");
  fs.rmSync(path.join(SCRATCH, name), { recursive: true, force: true });
  fs.mkdirSync(home, { recursive: true });
  return home;
}

// Minimal env: isolated HOME, no ZDOTDIR/XDG/HERDR overrides leaking in.
function childEnv(home, extra = {}) {
  const env = { ...process.env, HOME: home, ...extra };
  delete env.ZDOTDIR;
  delete env.HERDR_CWD_RESTORE_PLUGIN_ROOT;
  if (!extra.XDG_CONFIG_HOME) delete env.XDG_CONFIG_HOME;
  return env;
}

function run(args, home, extra) {
  return execFileSync("sh", [SETUP_HOOK, ...args], {
    env: childEnv(home, extra),
    encoding: "utf8",
  });
}

function runFails(args, home, extra) {
  assert.throws(() => run(args, home, extra));
}

function countOccurrences(text, needle) {
  return text.split(needle).length - 1;
}

describe("setup-cd-hook.sh", () => {
  it("creates ~/.zshrc with the hook lines on first run", () => {
    const home = freshHome("zsh-new");
    const out = run(["zsh"], home);
    assert.match(out, /configured zsh hook/);
    const rc = fs.readFileSync(path.join(home, ".zshrc"), "utf8");
    assert.ok(rc.includes("__herdr_cwd_restore_snapshot_sh="));
    assert.ok(rc.includes("src/snapshot.sh"));
    assert.ok(rc.includes("src/shell/herdr-cwd-restore.zsh"));
  });

  it("is idempotent: a second run changes nothing", () => {
    const home = freshHome("zsh-idem");
    run(["zsh"], home);
    const rcPath = path.join(home, ".zshrc");
    const before = fs.readFileSync(rcPath, "utf8");
    const out = run(["zsh"], home);
    assert.match(out, /already configured/);
    assert.equal(fs.readFileSync(rcPath, "utf8"), before);
    assert.equal(countOccurrences(before, "herdr-cwd-restore.zsh"), 1);
  });

  it("appends to an existing .bashrc, preserving its content, and backs up", () => {
    const home = freshHome("bash-append");
    const rcPath = path.join(home, ".bashrc");
    fs.writeFileSync(rcPath, 'export FOO=1\n');
    run(["bash"], home);
    const rc = fs.readFileSync(rcPath, "utf8");
    assert.ok(rc.startsWith("export FOO=1\n"));
    assert.ok(rc.includes("src/shell/herdr-cwd-restore.sh"));
    assert.equal(fs.readFileSync(`${rcPath}.bak`, "utf8"), "export FOO=1\n");
    // Rerun stays a single copy.
    run(["bash"], home);
    assert.equal(countOccurrences(fs.readFileSync(rcPath, "utf8"), "herdr-cwd-restore.sh"), 1);
  });

  it("honours XDG_CONFIG_HOME for fish", () => {
    const home = freshHome("fish-xdg");
    const xdg = path.join(SCRATCH, "fish-xdg", "xdg");
    fs.mkdirSync(xdg, { recursive: true });
    run(["fish"], home, { XDG_CONFIG_HOME: xdg });
    const rc = fs.readFileSync(path.join(xdg, "fish", "config.fish"), "utf8");
    assert.ok(rc.includes("set -g __herdr_cwd_restore_snapshot_sh"));
    assert.ok(rc.includes("src/shell/herdr-cwd-restore.fish"));
  });

  it("refreshes stale paths when the plugin root moved", () => {
    const home = freshHome("stale");
    const oldRoot = path.join(SCRATCH, "stale", "old-root");
    const newRoot = path.join(SCRATCH, "stale", "new-root");
    for (const root of [oldRoot, newRoot]) {
      fs.mkdirSync(path.join(root, "src", "shell"), { recursive: true });
      fs.writeFileSync(path.join(root, "src", "snapshot.sh"), "# stub\n");
      fs.writeFileSync(path.join(root, "src", "shell", "herdr-cwd-restore.zsh"), "# stub\n");
    }
    const rcPath = path.join(home, ".zshrc");
    fs.writeFileSync(
      rcPath,
      `__herdr_cwd_restore_snapshot_sh="${oldRoot}/src/snapshot.sh"\nsource "${oldRoot}/src/shell/herdr-cwd-restore.zsh"\n`
    );
    const out = run(["zsh", "--plugin-root", newRoot], home);
    assert.match(out, /refreshed/);
    const rc = fs.readFileSync(rcPath, "utf8");
    assert.ok(!rc.includes(oldRoot));
    assert.ok(rc.includes(`"${newRoot}/src/snapshot.sh"`));
    assert.ok(rc.includes(`"${newRoot}/src/shell/herdr-cwd-restore.zsh"`));
    assert.equal(countOccurrences(rc, "herdr-cwd-restore.zsh"), 1);
  });

  it("rejects a missing or unsupported shell argument", () => {
    const home = freshHome("bad-args");
    runFails([], home);
    runFails(["powershell"], home);
    assert.ok(!fs.existsSync(path.join(home, ".zshrc")));
    assert.ok(!fs.existsSync(path.join(home, ".bashrc")));
  });

  it("supports --help without touching anything", () => {
    const home = freshHome("help");
    const out = run(["--help"], home);
    assert.match(out, /usage:/);
    assert.deepEqual(fs.readdirSync(home), []);
  });
});
