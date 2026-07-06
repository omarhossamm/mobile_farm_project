/**
 * Project Registry
 *
 * The server owns the Flutter projects on this machine. Clients (the
 * VS Code extension) never see filesystem paths — they see opaque
 * project ids + display names + a list of flavors. The extension asks
 * the server "list_projects", the user picks one, and every future
 * call refers to it by id.
 *
 * Two ways to populate the registry:
 *
 *   1. Config file `flutter-projects.json` next to this server. The
 *      canonical way for production. Example:
 *
 *      {
 *        "projects": [
 *          {
 *            "id": "elm-employee-hub",
 *            "name": "ELM Employee Hub",
 *            "path": "/Users/ntg/Desktop/production/elm-employee-hub",
 *            "flutterPath": "flutter",
 *            "flavors": [
 *              { "name": "development", "target": "lib/main_development.dart", "flavor": "development" },
 *              { "name": "staging",     "target": "lib/main_staging.dart",     "flavor": "staging" },
 *              { "name": "production",  "target": "lib/main_production.dart",  "flavor": "production" }
 *            ]
 *          }
 *        ]
 *      }
 *
 *   2. If `flavors` is omitted for a project, we auto-derive them from
 *      the project's `.vscode/launch.json` (`type: "dart"` configs)
 *      and its `lib/main_*.dart` files, mirroring the logic the old
 *      extension used before this pivot.
 *
 * If the config file is missing entirely, the registry is empty and
 * the extension surfaces a clear "no projects configured on server"
 * message so the operator knows exactly what to do.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const CONFIG_FILE = path.join(__dirname, '..', 'flutter-projects.json');

const logger = {
  info:  (m, d = {}) => console.log (`[PROJECTS][INFO]  ${new Date().toISOString()} - ${m}`, Object.keys(d).length ? d : ''),
  warn:  (m, d = {}) => console.warn(`[PROJECTS][WARN]  ${new Date().toISOString()} - ${m}`, Object.keys(d).length ? d : ''),
  error: (m, d = {}) => console.error(`[PROJECTS][ERROR] ${new Date().toISOString()} - ${m}`, Object.keys(d).length ? d : ''),
};

/**
 * Read and normalize the config file. Returns an array of projects
 * with fully-resolved flavors. Returns [] if the config is missing or
 * unreadable (with a warn log — this is a legitimate operator state,
 * not a crash condition).
 */
function loadProjects() {
  if (!fs.existsSync(CONFIG_FILE)) {
    logger.warn(`No flutter-projects.json at ${CONFIG_FILE} — extension will see an empty project list`);
    return [];
  }

  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch (err) {
    logger.error(`flutter-projects.json is not valid JSON: ${err.message}`);
    return [];
  }

  const projects = Array.isArray(raw?.projects) ? raw.projects : [];
  const normalized = [];
  for (const proj of projects) {
    const p = normalizeProject(proj);
    if (p) normalized.push(p);
  }
  return normalized;
}

function normalizeProject(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (!raw.id || !raw.path) {
    logger.warn(`Skipping malformed project (missing id or path): ${JSON.stringify(raw).slice(0, 200)}`);
    return null;
  }
  const abs = path.resolve(raw.path);
  if (!fs.existsSync(path.join(abs, 'pubspec.yaml'))) {
    logger.warn(`Project "${raw.id}" — no pubspec.yaml at ${abs}, skipping`);
    return null;
  }
  const flavors = Array.isArray(raw.flavors) && raw.flavors.length > 0
    ? raw.flavors.map(normalizeFlavor).filter(Boolean)
    : discoverFlavors(abs);
  return {
    id: String(raw.id),
    name: String(raw.name || raw.id),
    path: abs,
    flutterPath: String(raw.flutterPath || 'flutter'),
    flavors,
  };
}

function normalizeFlavor(raw) {
  if (!raw || typeof raw !== 'object' || !raw.name) return null;
  return {
    name: String(raw.name),
    target: raw.target ? String(raw.target) : null,
    flavor: raw.flavor ? String(raw.flavor) : null,
    args:   Array.isArray(raw.args) ? raw.args.map(String) : [],
  };
}

/**
 * Auto-discover flavors from an existing Flutter project.
 *
 * Sources (in order):
 *   1. `.vscode/launch.json` entries of `type: "dart"` — their `program`
 *      becomes target, `args` supplies --flavor / extra args.
 *   2. `lib/main_*.dart` files — everything after `main_` becomes the
 *      flavor name. Launch.json entries win on collision.
 *
 * Returns a de-duplicated, alphabetically-sorted array. Empty array
 * means "no flavors found → use the default `flutter run`".
 */
function discoverFlavors(projectPath) {
  const seen = new Map(); // name → flavor
  // 1. launch.json
  const launchJson = path.join(projectPath, '.vscode', 'launch.json');
  if (fs.existsSync(launchJson)) {
    try {
      const parsed = parseJsonWithComments(fs.readFileSync(launchJson, 'utf8'));
      const configs = Array.isArray(parsed?.configurations) ? parsed.configurations : [];
      for (const c of configs) {
        if ((c.type || '').toLowerCase() !== 'dart') continue;
        const name = c.name;
        if (!name) continue;
        const target = c.program || null;
        const args = Array.isArray(c.args) ? [...c.args] : [];
        let flavor = null;
        const remaining = [];
        for (let i = 0; i < args.length; i++) {
          const a = args[i];
          if (a === '--flavor' && i + 1 < args.length) {
            flavor = args[i + 1];
            i++;
          } else if (a.startsWith('--flavor=')) {
            flavor = a.slice('--flavor='.length);
          } else {
            remaining.push(a);
          }
        }
        seen.set(name, { name, target, flavor, args: remaining });
      }
    } catch (err) {
      logger.warn(`Could not parse ${launchJson}: ${err.message}`);
    }
  }
  // 2. lib/main_*.dart
  const libDir = path.join(projectPath, 'lib');
  if (fs.existsSync(libDir)) {
    for (const entry of fs.readdirSync(libDir)) {
      const m = entry.match(/^main_(.+)\.dart$/);
      if (!m) continue;
      const name = m[1];
      if (seen.has(name)) continue;
      seen.set(name, { name, target: `lib/${entry}`, flavor: name, args: [] });
    }
  }
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Tolerant JSON parser — VS Code's launch.json allows line and block
 * comments plus trailing commas that strict JSON.parse rejects.
 */
function parseJsonWithComments(text) {
  // Strip // line comments and /* */ block comments, then trailing commas
  // before `}` or `]`. Not perfect (won't handle // inside strings) but good
  // enough for hand-written launch.json.
  const stripped = text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
    .replace(/,(\s*[}\]])/g, '$1');
  return JSON.parse(stripped);
}

// Cached at load; reload triggered externally via reload().
let cache = loadProjects();
logger.info(`Loaded ${cache.length} Flutter project(s) from ${CONFIG_FILE}`);

module.exports = {
  /** Reload from disk (useful for hot-editing the config file). */
  reload() { cache = loadProjects(); return cache; },

  /** All projects (safe view; excludes filesystem path from the wire shape). */
  listProjects() {
    return cache.map((p) => ({
      id: p.id,
      name: p.name,
      flavors: p.flavors.map((f) => ({
        name: f.name,
        target: f.target,
        flavor: f.flavor,
        args: f.args,
      })),
    }));
  },

  /** Full project record (server-internal — includes filesystem path). */
  getProject(id) {
    return cache.find((p) => p.id === id) || null;
  },

  /** Find a flavor by name inside a project. */
  getFlavor(projectId, flavorName) {
    const p = cache.find((x) => x.id === projectId);
    if (!p) return null;
    return p.flavors.find((f) => f.name === flavorName) || null;
  },
};
