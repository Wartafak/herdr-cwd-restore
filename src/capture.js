"use strict";
// Capture the current Herdr tab state into a project template or the single
// autosave file.
//
// This reads the live state (`herdr tab list` for labels, `foreground_cwd`
// per tab for directories -- see live.js) and renders a `projects/<name>.toml`
// scaffold, or the full-state `projects/autosave.toml` with `--autosave`.
// The generated template is a starting point, not a mirror -- edit it freely
// afterwards (add `command = "..."` per tab, adjust directories, rename the
// project). The autosave file is rewritten untouched on every event/cd and is
// the live layout mirror -- never hand-edit it.
//
// Usage:
//     node src/capture.js                                     # via action invoke:
//                                                             # name defaults to the
//                                                             # slugified workspace label
//     HERDR_TAB_CWD_PROJECT=<name> node src/capture.js       # explicit (direct runs)
//     node src/capture.js <name>                              # direct
//     node src/capture.js <name> --force                      # overwrite existing file
//     node src/capture.js <name> --stdout                     # preview, write nothing
//     node src/capture.js <name> --out /path/to/<name>.toml   # write elsewhere
//     node src/capture.js --autosave                        # event/cd trigger:
//                                                             # full live state
//                                                             # into the single
//                                                             # projects/autosave.toml
//                                                             # (always overwrites)
//
// `herdr plugin action invoke` takes no arguments and does not forward the
// caller's environment, so an invoked capture always uses the workspace-label
// default; pass a name explicitly only when running the script directly.
//
// The top-level `working_dir` is the longest common ancestor of all captured
// tab directories; a tab whose directory equals it omits `working_dir`
// (`open.js` inherits the project base then). Every tab keeps the workspace
// (space) it was captured from as `workspace = "..."`, so `open.js` rebuilds
// each space via create-or-reuse instead of dumping everything into the
// invoking workspace. Ambiguity is judged per space: the same label in the
// same workspace with different directories (and tabs with no readable cwd)
// are skipped with a warning -- rename the tab and recapture. The same label
// in *different* spaces is fine and captured once per space.

const fs = require("node:fs");
const path = require("node:path");
const { tomlString } = require("./toml");
const { collectLiveRows, shortenHome, utcStamp } = require("./live");
const { resolveConfigDir, defaultProjectName, ProjectError } = require("./open");

const PROJECTS_DIR_NAME = "projects";
// The single auto-saved file: every event and shell cd rewrites the full live
// state here, so the live layout survives in a file.
const AUTOSAVE_NAME = "autosave";

class CaptureError extends Error {}

function expandHomeOnly(p) {
  // Rows from collectLiveRows() carry at most a leading `~` (from
  // shortenHome); no $VARS are ever introduced, so only `~` needs expanding
  // for the common-ancestor computation.
  const home = process.env.HOME || "";
  if (p === "~") return home;
  if (home && p.startsWith("~/")) return home + p.slice(1);
  return p;
}

// Longest common ancestor directory of absolute paths ("/" when unrelated).
function commonAncestor(dirs) {
  const split = dirs.map((d) => d.split("/").filter((s) => s !== ""));
  let common = split[0];
  for (const parts of split.slice(1)) {
    let i = 0;
    while (i < common.length && i < parts.length && common[i] === parts[i]) i++;
    common = common.slice(0, i);
  }
  return "/" + common.join("/");
}

function validProjectName(name) {
  return (
    name !== "" &&
    name !== "." &&
    name !== ".." &&
    !name.includes("/") &&
    !name.includes("\\")
  );
}

function parseArgs(argv) {
  const args = { name: null, force: false, stdout: false, out: null, autosave: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--force") args.force = true;
    else if (arg === "--stdout") args.stdout = true;
    else if (arg === "--autosave") args.autosave = true;
    else if (arg === "--out" || arg.startsWith("--out=")) {
      if (arg.startsWith("--out=")) args.out = arg.slice("--out=".length);
      else args.out = argv[++i];
      if (args.out === undefined) {
        console.error("capture: error: argument --out: expected one argument");
        return null;
      }
    } else if (arg.startsWith("--")) {
      console.error(`capture: error: unrecognized arguments: ${arg}`);
      return null;
    } else if (args.name === null) {
      args.name = arg;
    } else {
      console.error(`capture: error: unrecognized arguments: ${arg}`);
      return null;
    }
  }
  if (args.autosave && args.name !== null) {
    console.error("capture: error: --autosave takes no project name");
    return null;
  }
  if (args.autosave) {
    args.name = AUTOSAVE_NAME;
    args.force = true; // the autosave file is rewritten on every event
  } else if (args.name === null) {
    args.name = process.env.HERDR_TAB_CWD_PROJECT || defaultProjectName();
  }
  return args;
}

// Flatten live rows into project tabs, skipping what a template cannot
// express. Grouped by (workspace, label): the same label may appear once per
// space, each keeping its own `workspace`. Returns { tabs, warnings } with
// ~-abbreviated working dirs, sorted by workspace then label.
function collectProjectTabs(rowsByLabel) {
  const groups = new Map();
  for (const rows of rowsByLabel.values()) {
    for (const row of rows) {
      const key = `${row.workspace}	${row.label}`;
      if (!groups.has(key)) groups.set(key, { workspace: row.workspace, label: row.label, rows: [] });
      groups.get(key).rows.push(row);
    }
  }
  const tabs = [];
  const warnings = [];
  for (const key of [...groups.keys()].sort()) {
    const { workspace, label, rows } = groups.get(key);
    const distinctCwds = [...new Set(rows.map((r) => r.cwd))].sort();
    if (distinctCwds.length > 1) {
      warnings.push(
        `skipping '${label}' in workspace '${workspace}' (${distinctCwds.length} ` +
          "different directories); rename a tab and recapture"
      );
      continue;
    }
    if (!rows[0].cwd) {
      warnings.push(`skipping tab '${label}' (no readable working directory)`);
      continue;
    }
    tabs.push({ name: label, workspace, workingDir: rows[0].cwd });
  }
  return { tabs, warnings };
}

function renderProject(name, baseOut, tabs) {
  const recaptureHint =
    name === AUTOSAVE_NAME
      ? "# Regenerated automatically on tab/workspace events and cd."
      : `# Recapture with: HERDR_TAB_CWD_PROJECT=${name} node src/capture.js --force`;
  const lines = [
    `# Generated by herdr-tab-cwd capture from live tab state (${utcStamp()}).`,
    "# Scaffold for `herdr-tab-cwd.open`: edit freely -- rename the project,",
    '# adjust directories, add `command = "..."` per tab.',
    recaptureHint,
    "",
    `name = ${tomlString(name)}`,
    `working_dir = ${tomlString(baseOut)}`,
    "",
  ];
  for (const tab of tabs) {
    lines.push("[[tabs]]");
    lines.push(`name = ${tomlString(tab.name)}`);
    if (tab.workspace) lines.push(`workspace = ${tomlString(tab.workspace)}`);
    if (tab.workingDir !== null) lines.push(`working_dir = ${tomlString(tab.workingDir)}`);
    lines.push("");
  }
  return lines.join("\n").replace(/\s+$/, "") + "\n";
}

function main(argv) {
  const args = parseArgs(argv);
  if (args === null) return 2;
  if (!args.name) {
    console.error(
      "herdr-tab-cwd: no project name given; set HERDR_TAB_CWD_PROJECT, pass a name, or invoke from a workspace"
    );
    return 2;
  }
  try {
    if (!validProjectName(args.name)) {
      throw new CaptureError(`invalid project name '${args.name}'`);
    }
    const rowsByLabel = collectLiveRows();
    const { tabs, warnings } = collectProjectTabs(rowsByLabel);
    if (tabs.length === 0) {
      throw new CaptureError("no capturable tabs open (nothing to snapshot)");
    }
    const expanded = tabs.map((t) => expandHomeOnly(t.workingDir));
    const baseOut = shortenHome(commonAncestor(expanded));
    const baseExpanded = expandHomeOnly(baseOut);
    for (const tab of tabs) {
      if (expandHomeOnly(tab.workingDir) === baseExpanded) tab.workingDir = null;
    }
    const text = renderProject(args.name, baseOut, tabs);
    for (const warning of warnings) console.error(`capture: warning: ${warning}`);
    if (args.stdout) {
      process.stdout.write(text);
      return 0;
    }
    const out =
      args.out || path.join(resolveConfigDir(), PROJECTS_DIR_NAME, `${args.name}.toml`);
    if (!args.force) {
      try {
        if (fs.statSync(out).isFile()) {
          throw new CaptureError(
            `refuses to overwrite existing ${out}; pass --force to recapture`
          );
        }
      } catch (error) {
        if (error instanceof CaptureError) throw error;
        // missing -- this is the expected first-capture case
      }
    }
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, text);
    console.error(`capture: wrote ${tabs.length} tab(s) into ${out}`);
    return 0;
  } catch (error) {
    if (error instanceof CaptureError || error instanceof ProjectError) {
      console.error(`capture: ${error.message}`);
      return 1;
    }
    throw error;
  }
}

if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}

module.exports = {
  parseArgs,
  collectProjectTabs,
  commonAncestor,
  renderProject,
  validProjectName,
  AUTOSAVE_NAME,
  CaptureError,
};
