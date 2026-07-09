/**
 * EmulatorDesktopApp installer.
 *
 * Responsible for making sure a runnable desktop-app binary exists on
 * this machine by the time the orchestrator wants to spawn it. Its
 * behaviour is best described as a resolution ladder — from cheapest
 * (no I/O) to most expensive (network):
 *
 *   1. **User override** — `emulatorStreamRun.desktopAppPath` points
 *      at a specific binary → trust it, run it. Owner: developer.
 *   2. **Bundled fallback** — the extension ships a copy at
 *      `vendor/desktop-app/<rid>/EmulatorDesktopApp[.exe]`. Only
 *      present when packaged with `npm run package:bundle` or in dev
 *      mode where `scripts/bootstrap.js` publishes into the tree.
 *      Air-gapped installs live here.
 *   3. **Cache hit** — `<globalStorage>/desktop-app/<version>/<rid>/…`
 *      exists AND its `.ok` sentinel is present AND (optionally)
 *      SHA256 matches. Owner: this installer.
 *   4. **Download + extract** — fetch the pinned zip, verify SHA256,
 *      unzip atomically, write `.ok`, hand back the path.
 *
 * A background updater fires on activate: it polls
 * `updateManifestUrl` and, if a newer *compatible* version is
 * advertised, downloads it into cache. The **currently-in-use** path
 * is NEVER swapped mid-run; the next F5 picks up whatever the
 * ladder resolves to at that time.
 *
 * Concurrency: a lock file (`<version>-<rid>.lock`) in the cache dir
 * serialises extraction so two VS Code windows opening the same
 * project at once can't race the archive open. Downloads are
 * idempotent — the second window sees the `.ok` sentinel and skips.
 */
'use strict';

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import * as http from 'http';
import * as crypto from 'crypto';
import AdmZip from 'adm-zip';
import {
  PINNED_MANIFEST,
  REQUIRED_DESKTOP_APP_FEATURES,
  pinnedAssetFor,
  resolveAssetUrl,
  type PinnedAsset,
} from './desktopAppManifest';

/** Runtime name inside every published archive. */
export function expectedBinaryName(): string {
  return process.platform === 'win32' ? 'EmulatorDesktopApp.exe' : 'EmulatorDesktopApp';
}

/**
 * How we came by the binary the extension is about to launch. Bubbles
 * up through DesktopAppInfo → the doctor UI so users can see whether
 * they're running the shipped copy, a local override, or something the
 * installer downloaded.
 */
export type ResolvedSource =
  | { kind: 'user-setting'; path: string }
  | { kind: 'bundled';      path: string; rid: string }
  | { kind: 'cached';       path: string; rid: string; version: string }
  | { kind: 'downloaded';   path: string; rid: string; version: string };

/** Report progress to whatever UI is watching. */
export type ProgressReporter = (msg: {
  phase: 'downloading' | 'verifying' | 'extracting' | 'ready';
  bytes?: number;
  totalBytes?: number;
  message?: string;
}) => void;

/** Snapshot of installer state for diagnostics. */
export interface InstallerState {
  cacheDir: string;
  cachedVersions: Array<{ version: string; rid: string; okAt: string | null }>;
  lastDownloadError?: string;
  lastUpdateCheckAt?: string;
  lastUpdateCheckResult?: 'up-to-date' | 'downloaded-newer' | 'error' | 'disabled';
}

/**
 * Options for `ensure()`. Every field is optional; sensible defaults
 * come from the pinned manifest + VS Code workspace settings.
 */
export interface EnsureOptions {
  /** Override RID resolution (`emulatorStreamRun.desktopAppRid`). */
  rid?: string;
  /** Absolute path to a specific binary — bypasses the ladder entirely. */
  userPath?: string;
  /** Extension root — used to find `vendor/desktop-app/`. */
  extensionRoot: string;
  /** Persistent cache root — VS Code's `context.globalStorageUri.fsPath`. */
  cacheRoot: string;
  /** `emulatorStreamRun.desktopAppBaseUrl` override, empty to accept the pinned default. */
  baseUrlOverride?: string;
  /** Progress callback for the download/extract path. */
  progress?: ProgressReporter;
  /** Cancellation token from vscode.window.withProgress. */
  cancel?: vscode.CancellationToken;
  /** Disable the network fetch entirely (offline / diagnostic mode). */
  offline?: boolean;
}

const OK_SENTINEL = '.ok';
const LOCK_SUFFIX = '.lock';

/**
 * Singleton because we want ONE installer per extension activation:
 * one lock table, one in-flight promise map, one background updater.
 */
export class DesktopAppInstaller {
  private lastDownloadError?: string;
  private lastUpdateCheckAt?: string;
  private lastUpdateCheckResult?: InstallerState['lastUpdateCheckResult'];
  /** In-flight installs keyed by `<version>-<rid>` — dedupes racing ensure() callers. */
  private inflight = new Map<string, Promise<void>>();

  /**
   * Resolve a runnable binary path, downloading + extracting on
   * demand. Return type is a `ResolvedSource` describing WHERE the
   * binary came from so the caller can log it and the doctor can
   * report it.
   */
  async ensure(opts: EnsureOptions): Promise<ResolvedSource> {
    // 1. User override wins over everything.
    if (opts.userPath && safeIsFile(opts.userPath)) {
      return { kind: 'user-setting', path: opts.userPath };
    }

    const rid = opts.rid ?? currentRid();

    // 2. Bundled fallback (dev mode + `--bundle` vsix + air-gapped).
    const bundled = bundledBinaryFor(opts.extensionRoot, rid);
    if (bundled && safeIsFile(bundled)) {
      return { kind: 'bundled', path: bundled, rid };
    }

    // 3+4. Cache/download for the version this extension pins to.
    const version = PINNED_MANIFEST.requiredVersion;
    const cachedPath = this.cachedBinaryPath(opts.cacheRoot, version, rid);
    if (this.isCacheValid(opts.cacheRoot, version, rid)) {
      return { kind: 'cached', path: cachedPath, rid, version };
    }

    if (opts.offline) {
      throw new InstallerError(
        `Desktop app binary not available on this machine and offline mode is on. ` +
        `Either enable network access or bundle the app manually (see README).`,
        'offline-and-not-cached'
      );
    }

    const key = `${version}-${rid}`;
    let promise: Promise<void> | undefined = this.inflight.get(key);
    if (!promise) {
      promise = this.downloadAndExtract({
        version, rid, cacheRoot: opts.cacheRoot,
        baseUrlOverride: opts.baseUrlOverride,
        progress: opts.progress, cancel: opts.cancel,
      });
      this.inflight.set(key, promise);
      // IMPORTANT: `promise.finally(cb).catch(() => {})` and NOT
      // `void promise.finally(cb)`. The latter constructs an
      // orphan promise that inherits the underlying rejection —
      // Node treats it as an unhandled rejection and exits, even
      // though the ensure() caller has its own handler. The
      // trailing .catch(() => {}) swallows the rejection on this
      // chain WITHOUT affecting the original promise (which is
      // still awaited below).
      promise.finally(() => this.inflight.delete(key)).catch(() => { /* handled by awaiter */ });
    }
    await promise;
    return { kind: 'downloaded', path: cachedPath, rid, version };
  }

  /**
   * Fire-and-forget background updater. Fetches the live manifest,
   * and if a newer compatible version is advertised, downloads it
   * into cache without touching the currently-in-use binary.
   *
   * Never throws — errors are recorded on the installer for the
   * doctor to surface.
   */
  async checkForUpdatesInBackground(opts: {
    cacheRoot: string;
    baseUrlOverride?: string;
    rid?: string;
    enabled: boolean;
  }): Promise<void> {
    if (!opts.enabled) {
      this.lastUpdateCheckResult = 'disabled';
      return;
    }
    this.lastUpdateCheckAt = new Date().toISOString();
    try {
      const url = PINNED_MANIFEST.updateManifestUrl;
      if (!url) {
        this.lastUpdateCheckResult = 'disabled';
        return;
      }
      const live = await fetchJson(url);
      const rid = opts.rid ?? currentRid();
      const candidate = pickNewerCompatible(live, rid);
      if (!candidate) {
        this.lastUpdateCheckResult = 'up-to-date';
        return;
      }
      // Race the pinned version. If the pinned one is already newer
      // than the live "latest", do nothing.
      if (compareSemver(candidate.version, PINNED_MANIFEST.requiredVersion) <= 0) {
        this.lastUpdateCheckResult = 'up-to-date';
        return;
      }
      if (this.isCacheValid(opts.cacheRoot, candidate.version, rid)) {
        this.lastUpdateCheckResult = 'up-to-date';
        return;
      }
      await this.downloadAndExtract({
        version: candidate.version,
        rid,
        cacheRoot: opts.cacheRoot,
        baseUrlOverride: opts.baseUrlOverride,
        asset: candidate.asset,
      });
      this.lastUpdateCheckResult = 'downloaded-newer';
    } catch (err) {
      this.lastUpdateCheckResult = 'error';
      this.lastDownloadError = err instanceof Error ? err.message : String(err);
    }
  }

  /** Introspection for `emulatorStreamRun.doctor`. */
  state(cacheRoot: string): InstallerState {
    return {
      cacheDir: this.rootFor(cacheRoot),
      cachedVersions: this.listCached(cacheRoot),
      lastDownloadError: this.lastDownloadError,
      lastUpdateCheckAt: this.lastUpdateCheckAt,
      lastUpdateCheckResult: this.lastUpdateCheckResult,
    };
  }

  /** Force-clear the cache — exposed via the `redownloadDesktopApp` command. */
  purgeCache(cacheRoot: string): void {
    fs.rmSync(this.rootFor(cacheRoot), { recursive: true, force: true });
  }

  // ── internals ────────────────────────────────────────────────────

  private rootFor(cacheRoot: string): string {
    return path.join(cacheRoot, 'desktop-app');
  }

  private versionDir(cacheRoot: string, version: string, rid: string): string {
    return path.join(this.rootFor(cacheRoot), version, rid);
  }

  private cachedBinaryPath(cacheRoot: string, version: string, rid: string): string {
    return path.join(this.versionDir(cacheRoot, version, rid), expectedBinaryName());
  }

  private isCacheValid(cacheRoot: string, version: string, rid: string): boolean {
    const dir = this.versionDir(cacheRoot, version, rid);
    const bin = path.join(dir, expectedBinaryName());
    const ok = path.join(dir, OK_SENTINEL);
    return safeIsFile(ok) && safeIsFile(bin);
  }

  private listCached(cacheRoot: string): InstallerState['cachedVersions'] {
    const root = this.rootFor(cacheRoot);
    const out: InstallerState['cachedVersions'] = [];
    let versions: string[];
    try { versions = fs.readdirSync(root); } catch { return out; }
    for (const v of versions.sort()) {
      const vDir = path.join(root, v);
      let rids: string[];
      try { rids = fs.readdirSync(vDir); } catch { continue; }
      for (const rid of rids.sort()) {
        const okPath = path.join(vDir, rid, OK_SENTINEL);
        const okAt = safeIsFile(okPath)
          ? safeStat(okPath)?.mtime.toISOString() ?? null
          : null;
        out.push({ version: v, rid, okAt });
      }
    }
    return out;
  }

  /**
   * The workhorse. Steps, in order:
   *   1. Resolve the pinned asset for this rid (or accept an
   *      already-fetched one from checkForUpdates).
   *   2. Take a file lock so parallel callers don't clobber.
   *   3. Stream the download to a `.part` file with progress
   *      reporting.
   *   4. Verify SHA256 against the pinned/manifest hash.
   *   5. Extract atomically into a `.tmp` subdir, then rename into
   *      place.
   *   6. `chmod +x` on unix.
   *   7. Write `.ok` sentinel.
   *
   * Every error path leaves the cache in a valid state (either
   * complete + `.ok`, or fully removed so a retry starts clean).
   */
  private async downloadAndExtract(input: {
    version: string;
    rid: string;
    cacheRoot: string;
    baseUrlOverride?: string;
    asset?: PinnedAsset;
    progress?: ProgressReporter;
    cancel?: vscode.CancellationToken;
  }): Promise<void> {
    const { version, rid, cacheRoot, baseUrlOverride, cancel } = input;
    const asset = input.asset ?? pinnedAssetFor(rid);
    if (!asset) {
      throw new InstallerError(
        `No download asset published for rid=${rid} at version=${version}. ` +
        `Either the maintainer hasn't run scripts/publish-desktop-app.js for this ` +
        `platform, or your host isn't in SUPPORTED_RIDS.`,
        'no-asset-for-rid'
      );
    }

    const url = resolveAssetUrl(asset, baseUrlOverride ?? '');
    if (!/^https?:\/\//i.test(url)) {
      throw new InstallerError(
        `Cannot resolve absolute URL for the desktop-app asset. Set ` +
        `emulatorStreamRun.desktopAppBaseUrl in your workspace / user settings ` +
        `and try again. (asset.url="${asset.url}")`,
        'no-base-url'
      );
    }

    const rootDir = this.rootFor(cacheRoot);
    fs.mkdirSync(rootDir, { recursive: true });
    const finalDir = this.versionDir(cacheRoot, version, rid);
    const lockPath = path.join(rootDir, `${version}-${rid}${LOCK_SUFFIX}`);
    const partPath = path.join(rootDir, `${version}-${rid}.zip.part`);
    const stagingDir = path.join(rootDir, `${version}-${rid}.staging`);

    // Lock. If someone else already produced an `.ok`, we bail
    // cheaply.
    await withFileLock(lockPath, async () => {
      if (this.isCacheValid(cacheRoot, version, rid)) return; // race won by the other side

      try {
        // Clean any leftover staging from a prior failed attempt.
        fs.rmSync(partPath, { force: true });
        fs.rmSync(stagingDir, { recursive: true, force: true });

        input.progress?.({ phase: 'downloading', message: `Downloading ${asset.url}`, totalBytes: asset.size });
        await downloadToFile(url, partPath, asset.size, input.progress, cancel);

        input.progress?.({ phase: 'verifying', message: 'Verifying SHA256…' });
        const gotSha = await sha256File(partPath);
        if (asset.sha256 && gotSha.toLowerCase() !== asset.sha256.toLowerCase()) {
          throw new InstallerError(
            `SHA256 mismatch for downloaded desktop-app archive. Expected ` +
            `${asset.sha256}, got ${gotSha}. Possible causes: proxy MITM, corrupted ` +
            `download, or the release URL was hijacked. Refusing to install.`,
            'sha256-mismatch'
          );
        }

        input.progress?.({ phase: 'extracting', message: 'Extracting archive…' });
        fs.mkdirSync(stagingDir, { recursive: true });
        const zip = new AdmZip(partPath);
        zip.extractAllTo(stagingDir, true);

        // Confirm the archive layout matches what we expect BEFORE
        // moving anything into place — an archive missing the binary
        // is a bad publish and must not overwrite a valid cached
        // version.
        const stagedBin = path.join(stagingDir, expectedBinaryName());
        if (!safeIsFile(stagedBin)) {
          throw new InstallerError(
            `Archive did not contain ${expectedBinaryName()} at the top level. ` +
            `The publish script emitted a badly-shaped zip for rid=${rid}. ` +
            `File the bug against the publish workflow.`,
            'bad-archive-layout'
          );
        }

        // Rename into place. rename() is atomic within a filesystem.
        fs.rmSync(finalDir, { recursive: true, force: true });
        fs.mkdirSync(path.dirname(finalDir), { recursive: true });
        fs.renameSync(stagingDir, finalDir);

        // chmod +x defensively — most zips preserve unix modes but
        // some don't.
        if (process.platform !== 'win32') {
          const bin = path.join(finalDir, expectedBinaryName());
          try {
            const st = fs.statSync(bin);
            if ((st.mode & 0o100) === 0) fs.chmodSync(bin, st.mode | 0o755);
          } catch { /* best effort */ }
        }

        fs.writeFileSync(path.join(finalDir, OK_SENTINEL), JSON.stringify({
          installedAt: new Date().toISOString(),
          version, rid, sha256: gotSha, sourceUrl: url,
        }));
        fs.rmSync(partPath, { force: true });
        input.progress?.({ phase: 'ready', message: `Installed ${version} for ${rid}` });
        this.lastDownloadError = undefined;
      } catch (err) {
        // Best-effort cleanup so the next attempt starts from zero.
        fs.rmSync(stagingDir, { recursive: true, force: true });
        fs.rmSync(partPath, { force: true });
        this.lastDownloadError = err instanceof Error ? err.message : String(err);
        throw err;
      }
    });
  }
}

/** Thrown by the installer with a machine-readable `code`. */
export class InstallerError extends Error {
  constructor(message: string, public readonly code: string) {
    super(message);
  }
}

// ── helpers (module-local; unit-testable individually) ───────────────

export function currentRid(override?: string): string {
  if (override && override.trim()) return override.trim();
  const p = process.platform;
  const a = process.arch;
  if (p === 'darwin') return a === 'arm64' ? 'osx-arm64' : 'osx-x64';
  if (p === 'linux')  return a === 'arm64' ? 'linux-arm64' : 'linux-x64';
  if (p === 'win32')  return a === 'arm64' ? 'win-arm64'  : 'win-x64';
  return `${p}-${a}`;
}

/**
 * Look for the "bundled" (in-vsix) binary for this rid. Present in
 * dev mode after `scripts/bootstrap.js`, and in vsix files built with
 * `npm run package:bundle`. Slim vsix files will always return null
 * here and fall through to the cache path.
 */
export function bundledBinaryFor(extensionRoot: string, rid: string): string | null {
  const vendor = path.join(extensionRoot, 'vendor', 'desktop-app');
  const ridPath = path.join(vendor, rid, expectedBinaryName());
  const flatPath = path.join(vendor, expectedBinaryName());
  // Universal bundles: per-RID subdirs only — check those first.
  if (safeIsFile(ridPath)) return ridPath;
  if (safeIsFile(flatPath)) return flatPath;
  return null;
}

function safeIsFile(p: string): boolean {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}
function safeStat(p: string): fs.Stats | undefined {
  try { return fs.statSync(p); } catch { return undefined; }
}

/**
 * Stream a URL to disk with progress reporting. Follows redirects up
 * to 5 times (GitHub Releases redirects through S3). Rejects on any
 * HTTP status ≥ 400.
 */
export function downloadToFile(
  url: string,
  destPath: string,
  expectedSize: number | undefined,
  progress: ProgressReporter | undefined,
  cancel: vscode.CancellationToken | undefined,
  redirectsRemaining = 5,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const client = parsed.protocol === 'http:' ? http : https;
    // Explicit `agent: false` + `Connection: close` — each download
    // is a one-shot; there's no benefit to keeping the socket in a
    // pool, and it makes tests easier to reason about.
    const req = client.get({
      ...parsed,
      hostname: parsed.hostname,
      protocol: parsed.protocol,
      port: parsed.port || undefined,
      path: parsed.pathname + parsed.search,
      headers: { Connection: 'close' },
      agent: false,
    } as http.RequestOptions, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode ?? 0)) {
        const loc = res.headers.location;
        res.resume();
        if (!loc) return reject(new InstallerError(`redirect without Location header from ${url}`, 'bad-redirect'));
        if (redirectsRemaining <= 0) return reject(new InstallerError(`too many redirects starting from ${url}`, 'too-many-redirects'));
        return resolve(downloadToFile(new URL(loc, parsed).toString(), destPath, expectedSize, progress, cancel, redirectsRemaining - 1));
      }
      if ((res.statusCode ?? 0) >= 400) {
        res.resume();
        return reject(new InstallerError(`HTTP ${res.statusCode} while fetching ${url}`, 'http-error'));
      }
      const total = expectedSize ?? Number(res.headers['content-length'] ?? 0);
      let received = 0;
      const stream = fs.createWriteStream(destPath);
      const onCancel = cancel?.onCancellationRequested(() => {
        req.destroy(new InstallerError('download cancelled by user', 'cancelled'));
        stream.destroy();
        try { fs.rmSync(destPath, { force: true }); } catch { /* ignore */ }
      });
      // Consume the response manually so we can drive BOTH the write
      // stream AND the progress reporter from the same chunk without
      // racing pipe(). Attaching an external 'data' listener while
      // also calling res.pipe(stream) was letting some chunks arrive
      // in the data-handler before pipe subscribed, silently
      // corrupting the download.
      res.on('data', (chunk: Buffer) => {
        received += chunk.length;
        stream.write(chunk);
        progress?.({ phase: 'downloading', bytes: received, totalBytes: total });
      });
      res.on('end', () => stream.end());
      stream.on('finish', () => { stream.close(); onCancel?.dispose(); resolve(); });
      stream.on('error', (err) => { onCancel?.dispose(); reject(err); });
      res.on('error', (err) => { onCancel?.dispose(); reject(err); });
    });
    req.on('error', reject);
    req.setTimeout(60_000, () => {
      req.destroy(new InstallerError(`request timeout on ${url}`, 'timeout'));
    });
  });
}

export function sha256File(p: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const stream = fs.createReadStream(p);
    stream.on('data', (chunk) => h.update(chunk));
    stream.on('end', () => resolve(h.digest('hex')));
    stream.on('error', reject);
  });
}

/**
 * Simple advisory file lock. On extract:
 *   • creates `<lockPath>` with the current pid
 *   • runs `fn`
 *   • removes the lock
 * If the lock is already held, polls every 100ms up to 2 minutes
 * before failing. That's enough for a normal extract (~seconds) and
 * bounded so a hung stale lock doesn't hang F5 forever.
 *
 * NOT rely on OS-level flock — VS Code extensions on Windows can't
 * assume fcntl semantics. `renameSync` of the file plus an mtime
 * heuristic keeps the code portable.
 */
export async function withFileLock<T>(lockPath: string, fn: () => Promise<T>): Promise<T> {
  const STALE_MS = 15 * 60 * 1000; // 15 minutes
  const DEADLINE = Date.now() + 2 * 60 * 1000; // 2 minute wait
  while (true) {
    try {
      // Open exclusively: fails with EEXIST if the file already exists.
      const fd = fs.openSync(lockPath, 'wx');
      fs.writeSync(fd, `${process.pid}\n${new Date().toISOString()}`);
      fs.closeSync(fd);
      try { return await fn(); }
      finally { try { fs.rmSync(lockPath, { force: true }); } catch { /* ignore */ } }
    } catch (err: unknown) {
      const errno = (err as NodeJS.ErrnoException).code;
      if (errno !== 'EEXIST') throw err;
      // Owned by someone. Check whether it's stale.
      const st = safeStat(lockPath);
      if (st && Date.now() - st.mtimeMs > STALE_MS) {
        try { fs.rmSync(lockPath, { force: true }); } catch { /* ignore */ }
        continue;
      }
      if (Date.now() > DEADLINE) {
        throw new InstallerError(`timed out waiting for install lock ${lockPath}`, 'lock-timeout');
      }
      await sleep(100);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function fetchJson(url: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('http:') ? http : https;
    const req = client.get(url, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode ?? 0)) {
        const loc = res.headers.location;
        res.resume();
        if (!loc) return reject(new Error(`redirect without Location header from ${url}`));
        return resolve(fetchJson(new URL(loc, url).toString()));
      }
      if ((res.statusCode ?? 0) >= 400) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} fetching ${url}`));
      }
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch (err) { reject(err); }
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(15_000, () => req.destroy(new Error(`timeout fetching ${url}`)));
  });
}

/**
 * Semver-ish comparator: numeric ordering by dotted segments.
 *
 *   compareSemver("0.2.1", "0.2.0") ===  1
 *   compareSemver("0.2.0", "0.2.1") === -1
 *   compareSemver("0.2.0", "0.2.0") ===  0
 */
export function compareSemver(a: string, b: string): number {
  const norm = (v: string) => v.replace(/^v/, '').split('-')[0].split('.').map((n) => parseInt(n, 10) || 0);
  const [aa, ab, ac] = norm(a);
  const [ba, bb, bc] = norm(b);
  if (aa !== ba) return aa - ba;
  if (ab !== bb) return ab - bb;
  return (ac ?? 0) - (bc ?? 0);
}

/**
 * Parse the LIVE manifest fetched from `updateManifestUrl` and return
 * the newest entry that
 *   • lists the caller's RID under `assets`, and
 *   • advertises every feature in REQUIRED_DESKTOP_APP_FEATURES.
 *
 * The live manifest schema mirrors what `scripts/publish-desktop-app.js`
 * writes. We stay defensive here — the file is user-controlled data.
 */
export function pickNewerCompatible(raw: unknown, rid: string): { version: string; asset: PinnedAsset } | null {
  if (!raw || typeof raw !== 'object') return null;
  const m = raw as {
    versions?: Record<string, {
      features?: string[];
      assets?: Record<string, PinnedAsset>;
    }>;
  };
  if (!m.versions) return null;

  const candidates = Object.entries(m.versions)
    .filter(([, v]) => {
      const feats = new Set(v.features ?? []);
      for (const req of REQUIRED_DESKTOP_APP_FEATURES) if (!feats.has(req)) return false;
      return !!(v.assets && v.assets[rid]);
    })
    .sort((a, b) => compareSemver(b[0], a[0]));
  const best = candidates[0];
  if (!best) return null;
  return { version: best[0], asset: best[1].assets![rid] };
}
