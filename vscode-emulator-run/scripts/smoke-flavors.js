#!/usr/bin/env node
/**
 * Headless test for src/flavorDiscovery.ts against the exact
 * launch.json shape from the user's Flutter project.
 *
 * We stub the `vscode` module just enough for the module under test to
 * run in a plain Node context (no VS Code host).
 */
'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs');
const Module = require('module');

const USER_LAUNCH_JSON = {
  version: '0.2.0',
  configurations: [
    { name: 'development', request: 'launch', type: 'dart', program: 'lib/main_development.dart', args: ['--flavor', 'development'] },
    { name: 'staging',     request: 'launch', type: 'dart', program: 'lib/main_staging.dart',     args: ['--flavor', 'staging'] },
    { name: 'production',  request: 'launch', type: 'dart', program: 'lib/main_production.dart',  args: ['--flavor', 'production'] },
    { name: 'ntgStaging',  request: 'launch', type: 'dart', program: 'lib/main_ntg_staging.dart', args: ['--flavor', 'ntgStaging'] },
    // A non-Flutter/dart entry that should be ignored.
    { name: 'Some other tool', request: 'launch', type: 'node', program: 'foo.js' },
    // Also try the --flavor=xxx form.
    { name: 'inlineFlavor', request: 'launch', type: 'dart', program: 'lib/main_inline.dart', args: ['--flavor=inline', '--dart-define=X=1'] },
  ],
};

// Set up a temp Flutter-ish workspace so main_*.dart scanning has files.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'esr-flavors-'));
fs.writeFileSync(path.join(tmp, 'pubspec.yaml'), 'name: sample\n');
fs.mkdirSync(path.join(tmp, 'lib'));
for (const f of ['main.dart', 'main_development.dart', 'main_staging.dart', 'main_production.dart', 'main_ntg_staging.dart', 'main_inline.dart', 'main_extra.dart']) {
  fs.writeFileSync(path.join(tmp, 'lib', f), '// stub\n');
}

// Stub the `vscode` module.
const vscodeStub = {
  workspace: {
    getConfiguration(section, _uri) {
      if (section === 'launch') {
        return {
          get(key) {
            if (key === 'configurations') return USER_LAUNCH_JSON.configurations;
            return undefined;
          },
        };
      }
      return { get() { return undefined; } };
    },
    async findFiles(rel, _excl, _max) {
      // Emulate what VS Code would return: the URIs of matching files.
      // We only handle the `lib/main*.dart` pattern used in this module.
      const dir = path.join(rel._folderFs, 'lib');
      const results = [];
      for (const name of fs.readdirSync(dir)) {
        if (/^main.*\.dart$/.test(name)) {
          results.push({ fsPath: path.join(dir, name) });
        }
      }
      return results;
    },
  },
  RelativePattern: class {
    constructor(folder, pattern) {
      this._folderFs = folder.uri.fsPath;
      this._pattern = pattern;
    }
  },
};

// Marker file must exist before require.resolve() can succeed.
const markerFile = path.join(__dirname, '_vscode_stub_marker.js');
if (!fs.existsSync(markerFile)) fs.writeFileSync(markerFile, 'module.exports = {};\n');

const markerId = require.resolve('./_vscode_stub_marker.js');
require.cache[markerId] = {
  id: markerId, filename: markerId, loaded: true, exports: vscodeStub,
};

const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'vscode') return markerId;
  return originalResolve.call(this, request, ...rest);
};

const { discoverFlavors, findFlavor } = require('../out/flavorDiscovery.js');

async function main() {
  const folder = { uri: { fsPath: tmp, toString: () => `file://${tmp}` } };
  const flavors = await discoverFlavors(folder);

  console.log('\ndiscovered flavors:');
  for (const f of flavors) {
    console.log(`  - name=${f.name} target=${f.target ?? '(none)'} flavor=${f.flavor ?? '(none)'} args=${JSON.stringify(f.args ?? [])} source=${f.source}`);
  }

  const expected = ['development', 'staging', 'production', 'ntgStaging', 'inlineFlavor'];
  const missing = expected.filter((n) => !flavors.find((f) => f.name === n));
  if (missing.length) {
    console.error('\nFAIL: missing expected flavors:', missing);
    process.exit(1);
  }
  // --flavor=inline parsing check
  const inline = findFlavor(flavors, 'inlineFlavor');
  if (!inline || inline.flavor !== 'inline') {
    console.error('FAIL: --flavor=inline was not parsed correctly:', inline);
    process.exit(1);
  }
  // extra dart-define arg should be preserved
  if (!inline.args || !inline.args.includes('--dart-define=X=1')) {
    console.error('FAIL: extra args were not preserved:', inline);
    process.exit(1);
  }
  // node config should be filtered out
  if (flavors.find((f) => f.name === 'Some other tool')) {
    console.error('FAIL: non-dart config leaked into flavors');
    process.exit(1);
  }
  // Filesystem-only flavor ("extra") should appear.
  if (!flavors.find((f) => f.name === 'extra')) {
    console.error('FAIL: filesystem-only flavor "extra" missing (expected from lib/main_extra.dart)');
    process.exit(1);
  }
  // launch.json wins over fs when they collide (e.g. "development"):
  const dev = findFlavor(flavors, 'development');
  if (!dev || dev.source !== 'launch.json') {
    console.error('FAIL: expected "development" to come from launch.json:', dev);
    process.exit(1);
  }

  console.log('\nOK — all flavor-discovery assertions passed.');
}

main().catch((err) => { console.error(err); process.exit(1); });
