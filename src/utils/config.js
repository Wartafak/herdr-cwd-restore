"use strict";
// Plugin config directory: project files live in `projects/` underneath it.
// Lookup order: $HERDR_PLUGIN_CONFIG_DIR first, then the XDG/HOME fallbacks.

const fs = require("node:fs");
const path = require("node:path");
const { ProjectError } = require("./project");

const PLUGIN_ID = "herdr-workspace-autosave";

function resolveConfigDir() {
  const candidates = [];
  if (process.env.HERDR_PLUGIN_CONFIG_DIR) {
    candidates.push(process.env.HERDR_PLUGIN_CONFIG_DIR);
  }
  if (process.env.XDG_CONFIG_HOME) {
    candidates.push(
      path.join(process.env.XDG_CONFIG_HOME, "herdr", "plugins", "config", PLUGIN_ID)
    );
  }
  const home = process.env.HOME || "";
  candidates.push(
    path.join(home, ".config", "herdr", "plugins", "config", PLUGIN_ID)
  );
  candidates.push(
    path.join(home, ".config", PLUGIN_ID)
  );
  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate).isDirectory()) return candidate;
    } catch {
      // missing -- try the next candidate
    }
  }
  throw new ProjectError(
    `no plugin config directory found in: ${candidates.join(", ")}`
  );
}

module.exports = { resolveConfigDir, PLUGIN_ID };
