"use strict";
// Minimal TOML support for herdr-tab-cwd config files.
//
// Node has no TOML parser in its standard library, so this module implements
// exactly the subset this plugin reads and writes -- and nothing else:
//
//   [[tabs]]            # array-of-tables entry (active, or commented out)
//   label = "..."       # basic ("...") or literal ('...') single-line string
//   cwd = "..."         # same
//   # ...               # full-line comments, blank lines, "# key = ..." notes
//
// Behavior notes:
// - Everything outside a `[[tabs]]` block (other tables, bare keys, header
//   comments) is ignored when loading. Python's `tomllib` would reject a
//   malformed file wholesale; here only lines inside an *active* entry that
//   are neither blank, comment, nor `label`/`cwd` key-value pairs raise.
// - `parseTomlString` handles basic strings via JSON.parse (JSON string
//   syntax is a subset of TOML basic-string syntax for the characters this
//   plugin emits) and literal `'...'` strings. Anything else (multiline
//   strings, bare values) parses as null, and callers treat such lines as
//   opaque: loaders skip them instead of failing.

const ENTRY_START_RE = /^\s*(?:#\s*)?\[\[tabs\]\].*$/;
const KEYVAL_RE = /^(\s*(?:#\s*)?)(label|cwd)\s*=\s*(.+?)\s*$/;

function tomlString(value) {
  return JSON.stringify(value);
}

function parseTomlString(raw) {
  const text = raw.trim();
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) {
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }
  if (
    text.length >= 2 &&
    text.startsWith("'") &&
    text.endsWith("'") &&
    !text.includes("\n")
  ) {
    return text.slice(1, -1);
  }
  return null;
}

// Split config text into `{ kind, active, lines }` chunks, where kind is
// "other" (header comments, blank lines, anything outside an entry) or
// "entry" (a `[[tabs]]` block, active or commented out). A blank line ends
// an entry chunk; everything else accumulates.
function splitEntries(text) {
  const chunks = [];
  let kind = "other";
  let active = false;
  let current = [];
  const flush = () => {
    if (current.length > 0) {
      chunks.push({ kind, active, lines: current });
      current = [];
    }
  };
  for (const line of text.split(/\r?\n/)) {
    if (ENTRY_START_RE.test(line)) {
      flush();
      kind = "entry";
      active = !line.trimStart().startsWith("#");
      current = [line];
    } else if (kind === "entry" && line.trim() === "") {
      current.push(line);
      flush();
      kind = "other";
      active = false;
      current = [];
    } else {
      current.push(line);
    }
  }
  flush();
  return chunks;
}

// Extract the effective label/cwd from an entry's lines. The first active
// key wins; commented-out keys are only a fallback.
function parseEntry(active, lines) {
  let label = null;
  let labelCommented = false;
  let commentedLabel = null;
  let cwd = null;
  let cwdIdx = null;
  let cwdCommented = false;
  let commentedCwd = null;
  for (let idx = 0; idx < lines.length; idx++) {
    const match = KEYVAL_RE.exec(lines[idx]);
    if (!match) continue;
    const commented = match[1].includes("#");
    const value = parseTomlString(match[3]);
    if (value === null) continue;
    if (match[2] === "label") {
      if (commented && commentedLabel === null) commentedLabel = value;
      else if (!commented && label === null) label = value;
    } else {
      if (commented && commentedCwd === null) {
        commentedCwd = { value, idx };
      } else if (!commented && cwd === null) {
        cwd = value;
        cwdIdx = idx;
      }
    }
  }
  if (label === null && commentedLabel !== null) {
    label = commentedLabel;
    labelCommented = true;
  }
  if (cwd === null && commentedCwd !== null) {
    cwd = commentedCwd.value;
    cwdIdx = commentedCwd.idx;
    cwdCommented = true;
  }
  const entry = { active, lines, label, labelCommented, cwd, cwdIdx, cwdCommented };
  entry.updatable = active && label !== null && !labelCommented;
  return entry;
}

module.exports = {
  ENTRY_START_RE,
  KEYVAL_RE,
  tomlString,
  parseTomlString,
  splitEntries,
  parseEntry,
};
