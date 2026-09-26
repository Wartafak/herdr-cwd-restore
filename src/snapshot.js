"use strict";
// Mirror the current Herdr tab state into a herdr-tab-cwd config file.
//
// Queries the live Herdr server via the CLI (`herdr tab list` for labels,
// `herdr pane list` only to read each tab's live `foreground_cwd`, since tab
// objects expose no working directory) and writes a `[[tabs]]` config mapping
// every open tab label to the directory its pane is currently sitting in.
//
// The output is a mirror: the file is fully regenerated on every run, so it
// always reflects exactly the tabs that are open right now. Entries for
// closed tabs disappear; there is no merge and nothing is preserved -- do
// not hand-edit the generated file.
//
// Usage:
//     node src/snapshot.js                 # mirror into the plugin config dir
//     node src/snapshot.js --stdout        # preview on stdout, write nothing
//     node src/snapshot.js --out /path/to/config.toml  # mirror into that file
//
// Like `main.js`, the herdr binary is resolved via `$HERDR_BIN_PATH` (the
// running server's own binary path) with a bare `herdr` PATH fallback.
// Notes on the generated file:
// - `foreground_cwd` (where the shell actually is right now) is snapshotted,
//   not `cwd` (the pane's restored-at-creation directory).
// - `$HOME` is abbreviated to `~`; `main.js` expands it back before `cd`.
// - Tab labels duplicated across tabs with *different* directories are
//   ambiguous for label-based matching (one entry would `cd` both tabs to
//   the same place), so they are emitted commented-out with a warning --
//   rename one of the tabs or pick the entry you want and uncomment it.

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { tomlString } = require("./toml");

const CONFIG_FILE_NAME = "config.toml";

// One live tab's snapshot row (cwd already `~`-abbreviated).
// { label, cwd, workspace, note }

function herdrBinary() {
  return process.env.HERDR_BIN_PATH || "herdr";
}

function runHerdrJson(...args) {
  const binary = herdrBinary();
  let result;
  try {
    result = spawnSync(binary, args, { encoding: "utf8" });
  } catch {
    throw new Error(`herdr executable not found at '${binary}'`);
  }
  if (result.error && result.error.code === "ENOENT") {
    throw new Error(`herdr executable not found at '${binary}'`);
  }
  if (result.status !== 0) {
    throw new Error(`herdr ${args.join(" ")} failed: ${(result.stderr || "").trim()}`);
  }
  return JSON.parse(result.stdout);
}

function shortenHome(p) {
  const home = process.env.HOME || "";
  if (home && (p === home || p.startsWith(home + path.sep))) {
    return "~" + p.slice(home.length);
  }
  return p;
}

function utcStamp() {
  return new Date().toISOString().slice(0, 16).replace("T", " ") + " UTC";
}

// Python-repr-style single quoting for warning/report lines.
function pyRepr(value) {
  if (!value.includes("'")) return `'${value}'`;
  if (!value.includes('"')) return `"${value}"`;
  return `'${value.replace(/'/g, "\\'")}'`;
}

// Collect live (tab label, cwd) rows grouped by label.
function collectLiveRows() {
  const tabs = (runHerdrJson("tab", "list").result || {}).tabs || [];
  const panes = (runHerdrJson("pane", "list").result || {}).panes || [];
  const workspaces = (runHerdrJson("workspace", "list").result || {}).workspaces || [];
  const workspaceLabel = {};
  for (const w of workspaces) workspaceLabel[w.workspace_id] = w.label || "";

  const panesByTab = {};
  for (const pane of panes) {
    const tabId = pane.tab_id || "";
    (panesByTab[tabId] = panesByTab[tabId] || []).push(pane);
  }

  const rowsByLabel = new Map();
  const orderedTabs = [...tabs].sort((a, b) => {
    const wa = workspaceLabel[a.workspace_id || ""] || "";
    const wb = workspaceLabel[b.workspace_id || ""] || "";
    if (wa < wb) return -1;
    if (wa > wb) return 1;
    return (a.number || 0) - (b.number || 0);
  });
  for (const tab of orderedTabs) {
    const label = tab.label || "";
    const tabId = tab.tab_id || "";
    const ws = workspaceLabel[tab.workspace_id || ""] || "";
    const tabPanes = panesByTab[tabId] || [];
    if (!label || tabPanes.length === 0) continue;
    const cwds = tabPanes.map((p) => p.foreground_cwd || p.cwd || "");
    const cwd = cwds[0];
    let note = "";
    if (new Set(cwds).size > 1) {
      // One tab, several panes sitting in different directories: a single
      // label entry cannot restore each pane individually.
      note =
        `# WARNING: tab has ${tabPanes.length} panes in different ` +
        `directories; snapshotted the first (${cwd}).`;
    }
    if (!rowsByLabel.has(label)) rowsByLabel.set(label, []);
    rowsByLabel.get(label).push({ label, cwd: shortenHome(cwd), workspace: ws, note });
  }
  return rowsByLabel;
}

// Render one label's config lines plus an optional warning line. Ambiguous
// labels (several tabs, different directories) render commented-out: a
// mirror cannot pick one for you, so rename one of the tabs to make the
// label unambiguous.
function renderLabelGroup(label, rows) {
  const distinctCwds = [...new Set(rows.map((r) => r.cwd))].sort();
  if (distinctCwds.length > 1) {
    // Same label on several tabs pointing at different directories: emitting
    // both entries would `cd` every such tab twice (last write wins
    // everywhere). Emit commented-out so the user picks.
    const involved = [...new Set(rows.map((r) => r.workspace).filter(Boolean))].sort().join(", ");
    const warning =
      `# AMBIGUOUS label ${pyRepr(label)} used by tabs in ` +
      `workspace(s) [${involved}] with different directories; ` +
      `rename a tab so the label maps to exactly one directory.`;
    const lines = [];
    for (const row of rows) {
      if (row.note) lines.push(row.note);
      lines.push(`# [[tabs]]  # workspace: ${row.workspace}`);
      lines.push(`# label = ${tomlString(label)}`);
      lines.push(`# cwd = ${tomlString(row.cwd)}`);
      lines.push("");
    }
    return { lines, warning };
  }
  const row = rows[0];
  const wsList = [...new Set(rows.map((r) => r.workspace).filter(Boolean))].sort().join(", ");
  const lines = [];
  if (row.note) lines.push(row.note);
  lines.push("[[tabs]]");
  lines.push(`label = ${tomlString(label)}`);
  lines.push(`cwd = ${tomlString(row.cwd)}`);
  if (wsList) lines.push(`# workspace: ${wsList}`);
  lines.push("");
  return { lines, warning: null };
}

function renderEntries(rowsByLabel) {
  const entryLines = [];
  const warningLines = [];
  for (const label of [...rowsByLabel.keys()].sort()) {
    const { lines, warning } = renderLabelGroup(label, rowsByLabel.get(label));
    if (warning !== null) warningLines.push(warning);
    entryLines.push(...lines);
  }
  return { entryLines, warningLines };
}

function renderConfig(entryLines, warningLines) {
  const header = [
    "# Generated by herdr-tab-cwd snapshot script. DO NOT EDIT: this file",
    "# is a mirror of the live tab state and is fully regenerated on every run.",
    `# Source: live \`herdr tab list\` + \`herdr pane list\` (${utcStamp()}).`,
    "# Regenerate with: node src/snapshot.js",
  ];
  if (warningLines.length > 0) {
    header.push("#");
    header.push(...warningLines);
  }
  return [...header, "", ...entryLines].join("\n").replace(/\s+$/, "") + "\n";
}

function defaultOutPath() {
  const pluginDir = process.env.HERDR_PLUGIN_CONFIG_DIR;
  if (!pluginDir) {
    throw new Error(
      "HERDR_PLUGIN_CONFIG_DIR is not set; pass --out explicitly or run " +
        "with the plugin environment (herdr plugin link + server running)."
    );
  }
  return path.join(pluginDir, CONFIG_FILE_NAME);
}

function parseArgs(argv) {
  const args = { stdout: false, out: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--stdout") args.stdout = true;
    else if (arg === "--out" || arg.startsWith("--out=")) {
      if (arg.startsWith("--out=")) args.out = arg.slice("--out=".length);
      else args.out = argv[++i];
      if (args.out === undefined) {
        console.error("snapshot: error: argument --out: expected one argument");
        return null;
      }
    } else {
      console.error(`snapshot: error: unrecognized arguments: ${arg}`);
      return null;
    }
  }
  return args;
}

function writeMirror(out, rowsByLabel) {
  const { entryLines, warningLines } = renderEntries(rowsByLabel);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, renderConfig(entryLines, warningLines));
  console.error(`snapshot: mirrored ${rowsByLabel.size} label(s) into ${out}`);
  return 0;
}

function main(argv) {
  const args = parseArgs(argv);
  if (args === null) return 2;
  try {
    const rowsByLabel = collectLiveRows();
    if (args.stdout) {
      const { entryLines, warningLines } = renderEntries(rowsByLabel);
      process.stdout.write(renderConfig(entryLines, warningLines));
      return 0;
    }
    if (args.out) return writeMirror(args.out, rowsByLabel);
    return writeMirror(defaultOutPath(), rowsByLabel);
  } catch (error) {
    console.error(`snapshot: ${error.message}`);
    return 1;
  }
}

if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}

module.exports = {
  renderLabelGroup,
  renderEntries,
  renderConfig,
  parseArgs,
};
