/**
 * Pinned metadata about the EmulatorDesktopApp release the extension
 * *requires* at build time.
 *
 * Why pin this into the extension source instead of always fetching a
 * live manifest from the network first?
 *
 *   • First-run bootstrap can proceed **without** any prior network
 *     round-trip. The extension knows the exact URL + SHA256 for the
 *     RID it needs and can start downloading immediately.
 *   • Version drift is impossible: whoever built this .vsix committed
 *     to exactly this desktop-app version. If GitHub Releases moved
 *     things around, the extension still works.
 *   • Integrity is not gated on trusting a live JSON file that could
 *     be tampered with; the hashes here live in the same signed(?)
 *     .vsix as the code that consumes them.
 *
 * `scripts/publish-desktop-app.js` REGENERATES this file after
 * publishing new artefacts — it produces the archive per RID, computes
 * SHA256, and writes both the release manifest AND this TS source. Keep
 * the two in sync by running that script; do NOT hand-edit the hashes.
 *
 * The "check for a newer compatible version in the background" path in
 * `desktopAppInstaller.ts` fetches a live manifest at
 * `<baseUrl>/manifest.json` on top of this static one; it never
 * *replaces* the pinned data.
 */
'use strict';

/** Feature tags the extension expects the downloaded binary to advertise. */
export const REQUIRED_DESKTOP_APP_FEATURES = ['headless-attach-v1'] as const;

/**
 * Every .NET RID the extension can operate against. Publish script
 * MUST provide an entry for each RID in this list or the corresponding
 * platform install fails.
 */
export const SUPPORTED_RIDS = [
  'win-x64',
  'win-arm64',
  'osx-x64',
  'osx-arm64',
  'linux-x64',
  'linux-arm64',
] as const;

export type SupportedRid = typeof SUPPORTED_RIDS[number];

export interface PinnedAsset {
  /** Absolute URL (or path fragment appended to desktopAppBaseUrl). */
  url: string;
  /** Hex-encoded lower-case SHA256 of the zip archive. */
  sha256: string;
  /** Byte count — used for progress-bar total. */
  size: number;
}

export interface PinnedManifest {
  /** Version of the EmulatorDesktopApp release this extension pins to. */
  requiredVersion: string;
  /** When the publish script generated this file. */
  generatedAt: string;
  /** Optional: git sha of the desktop-app source at publish time. */
  gitSha?: string;
  /** Per-RID download data. Every SUPPORTED_RIDS entry SHOULD be present. */
  assets: Partial<Record<SupportedRid, PinnedAsset>>;
  /**
   * Base URL the publish script uploaded to. Used at runtime ONLY as a
   * default for the `emulatorStreamRun.desktopAppBaseUrl` setting, and
   * for the "check for updates" fetch of the live manifest.
   */
  defaultBaseUrl: string;
  /**
   * Where `<baseUrl>/manifest.json` should live so the installer can
   * poll for newer versions. Absolute URL, empty string disables the
   * background updater entirely.
   */
  updateManifestUrl: string;
}

/**
 * PLACEHOLDER manifest — no artefacts have been published yet.
 *
 * When the maintainer runs `npm run publish-desktop-app`, that script
 * overwrites this file with the real URLs + SHA256 hashes for every
 * RID. Until it runs, the installer treats first-run downloads as
 * unavailable and points the user at the doctor command / manual
 * `emulatorStreamRun.desktopAppPath` setting.
 *
 * The empty `assets` object is intentional: it makes it impossible for
 * the extension to silently point at a stale URL if the publish
 * pipeline was skipped.
 */
export const PINNED_MANIFEST: PinnedManifest = {
  requiredVersion: "0.2.0",
  generatedAt: "2026-07-08T15:23:16.070Z",
  gitSha: "90eacd2c24bee65bfd72185dacc2e04684774628",
  defaultBaseUrl: "https://github.com/YOUR_ORG/YOUR_REPO/releases/download/desktop-app-v0.2.0",
  updateManifestUrl: "https://raw.githubusercontent.com/YOUR_ORG/YOUR_REPO/main/dist/desktop-app-releases/latest/manifest.json",
  assets: {
  'win-x64': {"url":"https://github.com/YOUR_ORG/YOUR_REPO/releases/download/desktop-app-v0.2.0/emulator-desktop-app-0.2.0-win-x64.zip","sha256":"6768c9ed5a2496e103fabc3a32cb79d631f0264a9e31cc4a3d632924471af10c","size":45424093},
  'win-arm64': {"url":"https://github.com/YOUR_ORG/YOUR_REPO/releases/download/desktop-app-v0.2.0/emulator-desktop-app-0.2.0-win-arm64.zip","sha256":"c9ac44d79625c0841d731127e4c13f7f19a896043e4d63296da00a6372a0d26b","size":44551908},
  'osx-x64': {"url":"https://github.com/YOUR_ORG/YOUR_REPO/releases/download/desktop-app-v0.2.0/emulator-desktop-app-0.2.0-osx-x64.zip","sha256":"43f548988d28e08de6cf3050c74fea57255fd389ca0890bda02275218cb78a30","size":19803893},
  'osx-arm64': {"url":"https://github.com/YOUR_ORG/YOUR_REPO/releases/download/desktop-app-v0.2.0/emulator-desktop-app-0.2.0-osx-arm64.zip","sha256":"b2fa65c834e22621f7adaa7b0f2d7f6ce4cefcd85def6b4a960a05d5dc61f2c4","size":19801547},
  'linux-x64': {"url":"https://github.com/YOUR_ORG/YOUR_REPO/releases/download/desktop-app-v0.2.0/emulator-desktop-app-0.2.0-linux-x64.zip","sha256":"fa755d46b5d20d3562d9e64154bb7458c6e7cf2d96837755cf62f77890ffe37c","size":16998176},
  'linux-arm64': {"url":"https://github.com/YOUR_ORG/YOUR_REPO/releases/download/desktop-app-v0.2.0/emulator-desktop-app-0.2.0-linux-arm64.zip","sha256":"d11f6c585d904359cbd669847ba392e895d0547ef5395438089b048847a1d950","size":16701458},
  },
};

/**
 * Convenience: lookup the pinned download URL + SHA256 for a RID.
 *
 * @returns null when either
 *   • the RID isn't in SUPPORTED_RIDS (host unsupported), or
 *   • no asset was published for this RID yet (publish script hasn't
 *     run, or was run with a `--rid` subset that omitted this one).
 */
export function pinnedAssetFor(rid: string): PinnedAsset | null {
  if (!(SUPPORTED_RIDS as readonly string[]).includes(rid)) return null;
  const asset = PINNED_MANIFEST.assets[rid as SupportedRid];
  return asset ?? null;
}

/**
 * Build an absolute URL for a pinned asset. Assets can be published
 * with absolute URLs (typical for GitHub Releases) OR with a path
 * fragment that gets joined against the user-configurable base URL
 * (typical for self-hosted / air-gapped mirrors).
 */
export function resolveAssetUrl(asset: PinnedAsset, overrideBaseUrl: string): string {
  if (/^https?:\/\//i.test(asset.url)) return asset.url;
  const base = overrideBaseUrl || PINNED_MANIFEST.defaultBaseUrl;
  if (!base) return asset.url; // publish script produced a relative URL but no base — caller will error out
  return base.replace(/\/+$/, '') + '/' + asset.url.replace(/^\/+/, '');
}
