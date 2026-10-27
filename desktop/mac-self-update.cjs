const { execFile, spawn } = require("node:child_process");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { posix } = require("node:path");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);

/**
 * In-place updates for unsigned (or ad-hoc-signed) macOS builds.
 *
 * Squirrel.Mac — the mechanism electron-updater drives — refuses to replace a
 * bundle whose signature does not satisfy the running app's designated
 * requirement. Stiva Browser's macOS artifacts are ad-hoc signed unless the release
 * job has a Developer ID certificate, so Squirrel can never install them.
 *
 * This module does the swap itself. It takes its integrity guarantee from the
 * SHA-512 published in `latest-mac.yml`, which electron-updater fetched over
 * HTTPS from the same GitHub release as the zip. The zip is hashed while it
 * streams, rejected unless the digest matches byte for byte, unpacked with
 * `ditto`, checked to be a Stiva Browser bundle of the expected version, and only
 * then moved over the installed app by a detached helper that waits for this
 * process to exit.
 *
 * This is not a substitute for code signing. A build signed with a real
 * Developer ID goes back through Squirrel automatically (see `updater.cjs`,
 * `detectAutoInstallSupport`), and a bundle installed somewhere this user
 * cannot write is sent to GitHub instead.
 */

const OWNER = "salvatorecorvaglia";
const REPO = "stiva-browser";
const APP_ID = "io.github.salvatorecorvaglia.stiva-browser";
const RELEASE_ASSET_ORIGIN = "https://github.com";
const RELEASE_ASSET_PREFIX = `${RELEASE_ASSET_ORIGIN}/${OWNER}/${REPO}/releases/download/`;

/** Prefix of the temp directories a staged update lives in. */
const STAGE_PREFIX = "stiva-browser-update-";

/** Hard ceiling when the feed does not tell us how big the asset is (~1 GiB). */
const MAX_UNKNOWN_DOWNLOAD_BYTES = 1024 * 1024 * 1024;

/** How often download progress reaches the renderer. Enough for a smooth bar. */
const PROGRESS_INTERVAL_MS = 250;

let staged = null;
let applying = false;
let quitHookArmed = false;
let selfInstallSupport = null;

function electron() {
  return require("electron");
}

/**
 * The installed `.app` this process is running from.
 *
 * `process.execPath` is `<bundle>/Contents/MacOS/Stiva Browser`, so the bundle is two
 * levels up. Returns null when that does not look like an app bundle — an
 * unpackaged dev run, or a binary someone lifted out of its bundle.
 *
 * The path helpers are pinned to `posix`: these are macOS paths whichever host
 * the code is parsed on, and the platform-sensitive versions mangle them into
 * drive-prefixed backslash paths when the test suite runs on Windows.
 */
function getBundlePath(platform = process.platform, execPath = process.execPath) {
  if (platform !== "darwin") return null;
  const bundlePath = posix.resolve(posix.dirname(execPath), "..", "..");
  if (!bundlePath.endsWith(".app")) return null;
  // A bundle with fewer than two segments below root ("/Stiva Browser.app") would make
  // the replace step operate dangerously close to the filesystem root.
  if (bundlePath.split("/").filter(Boolean).length < 2) return null;
  return bundlePath;
}

/**
 * Can this build replace its own bundle in place?
 *
 * Three ways it cannot, all of which must route the user to GitHub instead:
 * the app is not packaged; it is running translocated (Gatekeeper's read-only
 * shadow copy under `AppTranslocation`, where the real bundle is elsewhere);
 * or the bundle and its parent directory are not writable by this user — an
 * app installed into `/Applications` by an admin, for one.
 */
function detectSelfInstallSupport() {
  const { app } = electron();
  const bundlePath = getBundlePath();
  if (!app.isPackaged || !bundlePath) return Promise.resolve(false);

  if (bundlePath.includes("/AppTranslocation/")) {
    console.warn("[SelfUpdate] Running translocated; in-place update is not possible.");
    return Promise.resolve(false);
  }

  return Promise.all([
    fsp.access(bundlePath, fs.constants.W_OK),
    fsp.access(posix.dirname(bundlePath), fs.constants.W_OK),
  ])
    .then(() => true)
    .catch((err) => {
      console.warn(
        "[SelfUpdate] Bundle location is not writable; in-place update off:",
        err.message,
      );
      return false;
    });
}

/** Memoized: the answer cannot change while the app runs. */
function isSelfInstallSupported() {
  selfInstallSupport ??= detectSelfInstallSupport();
  return selfInstallSupport;
}

function hasStagedUpdate() {
  return staged !== null;
}

/**
 * Pick the macOS zip for the architecture we are running.
 *
 * The feed lists both arches plus the dmgs; installing the wrong slice would
 * produce an app that launches under Rosetta at best. Only `.zip` is usable —
 * a dmg would need mounting — and the arch has to match exactly, so a feed
 * that somehow lists neither is a hard error rather than a guess.
 */
function selectMacAsset(info, arch = process.arch) {
  const files = Array.isArray(info.files) ? info.files : [];
  const wanted = arch === "arm64" ? "arm64" : "x64";
  const asset = files.find(
    (file) =>
      typeof file.url === "string" &&
      file.url.endsWith(".zip") &&
      (file.url.includes(`_mac_${wanted}.`) || file.url.includes(`-mac-${wanted}.`)),
  );
  if (!asset) throw new Error(`The release has no macOS ${wanted} package to download.`);
  if (!asset.sha512) {
    // Without the feed's digest there is nothing to verify the download
    // against, and an unverified bundle must never be unpacked over the app.
    throw new Error("The update feed did not publish a checksum for this package.");
  }
  return asset;
}

/** Download URL of one asset attached to the `v<version>` release. */
function releaseAssetUrl(version, assetName) {
  const tag = encodeURIComponent(`v${version}`);
  return `${RELEASE_ASSET_PREFIX}${tag}/${encodeURIComponent(assetName)}`;
}

/** Streams `url` to `destPath`, returning the base64 SHA-512 of what arrived. */
function downloadAsset(url, destPath, expectedSize, onProgress) {
  const { net } = electron();
  if (!url.startsWith(RELEASE_ASSET_PREFIX)) {
    return Promise.reject(new Error("Refusing to download an update from an unexpected host."));
  }

  return new Promise((resolvePromise, rejectPromise) => {
    const request = net.request({ method: "GET", url, redirect: "follow" });
    const hash = createHash("sha512");
    const file = fs.createWriteStream(destPath);
    const limit = expectedSize ?? MAX_UNKNOWN_DOWNLOAD_BYTES;
    const startedAt = Date.now();
    let received = 0;
    let lastReport = 0;
    let settled = false;

    const fail = (err) => {
      if (settled) return;
      settled = true;
      file.destroy();
      request.abort();
      rejectPromise(err instanceof Error ? err : new Error(String(err)));
    };

    file.on("error", fail);
    request.on("error", fail);

    request.on("response", (response) => {
      if (response.statusCode !== 200) {
        fail(new Error(`Download failed (HTTP ${response.statusCode}).`));
        return;
      }

      // Electron's IncomingMessage is a Readable at runtime but its typings
      // omit the flow controls; a large asset arriving faster than the disk
      // drains would otherwise pile up in the write stream's buffer.
      const flow = response;

      response.on("data", (chunk) => {
        if (settled) return;
        received += chunk.length;
        // The feed states the exact size; anything longer is not the asset the
        // checksum describes, so stop rather than filling the disk.
        if (received > limit) {
          fail(new Error("The update package is larger than the feed declared."));
          return;
        }
        hash.update(chunk);
        if (!file.write(chunk)) {
          flow.pause();
          file.once("drain", () => flow.resume());
        }
        const now = Date.now();
        if (now - lastReport >= PROGRESS_INTERVAL_MS) {
          lastReport = now;
          const elapsed = Math.max(now - startedAt, 1) / 1000;
          onProgress(expectedSize ? (received / expectedSize) * 100 : 0, received / elapsed);
        }
      });

      response.on("error", fail);

      response.on("end", () => {
        if (settled) return;
        if (expectedSize !== undefined && received !== expectedSize) {
          fail(new Error("The update package download ended early."));
          return;
        }
        file.end(() => {
          if (settled) return;
          settled = true;
          resolvePromise(hash.digest("base64"));
        });
      });
    });

    request.end();
  });
}

/** Reads one key out of an Info.plist. Returns null if the key is absent. */
async function readPlistValue(bundlePath, key) {
  try {
    const { stdout } = await execFileAsync(
      "/usr/bin/plutil",
      ["-extract", key, "raw", "-o", "-", path.join(bundlePath, "Contents", "Info.plist")],
      { timeout: 10000 },
    );
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Refuse to install anything that is not the expected Stiva Browser release.
 *
 * The digest already proves the zip is the artifact the feed describes; this
 * catches the feed itself pointing at the wrong thing — a mismatched version,
 * or a bundle belonging to some other application.
 */
async function assertReplacementIsStivaBrowser(candidate, expectedVersion) {
  const candidateId = await readPlistValue(candidate, "CFBundleIdentifier");
  if (candidateId !== APP_ID)
    throw new Error("The downloaded package is not a Stiva Browser build.");

  const candidateVersion = await readPlistValue(candidate, "CFBundleShortVersionString");
  if (candidateVersion !== expectedVersion) {
    throw new Error(
      `The downloaded package is version ${candidateVersion ?? "unknown"}, not ${expectedVersion}.`,
    );
  }
}

/**
 * Download, verify and unpack the update, leaving it ready to swap in.
 *
 * Nothing outside the temp stage directory is touched here — the installed
 * bundle is only replaced by `applyStagedUpdate`, after the user asks for it
 * or on quit.
 */
async function stageUpdate(info, onProgress) {
  if (staged && staged.version === info.version) return staged;
  await discardStagedUpdate();

  const asset = selectMacAsset(info);
  const stageDir = await fsp.mkdtemp(path.join(os.tmpdir(), STAGE_PREFIX));

  try {
    const zipPath = path.join(stageDir, "update.zip");
    const digest = await downloadAsset(
      releaseAssetUrl(info.version, asset.url),
      zipPath,
      asset.size,
      onProgress,
    );

    if (digest !== asset.sha512) {
      throw new Error("The update package failed its checksum check and was discarded.");
    }

    const unpackDir = path.join(stageDir, "unpacked");
    // `ditto -x -k` is the only unzip on macOS that preserves symlinks and the
    // extended attributes a signed bundle needs; `unzip` corrupts frameworks.
    await execFileAsync("/usr/bin/ditto", ["-x", "-k", zipPath, unpackDir], {
      timeout: 300000,
    });
    await fsp.rm(zipPath, { force: true });

    const entries = await fsp.readdir(unpackDir);
    const appName = entries.find((entry) => entry.endsWith(".app"));
    if (!appName) throw new Error("The update package did not contain an app bundle.");

    const appPath = path.join(unpackDir, appName);
    await assertReplacementIsStivaBrowser(appPath, info.version);

    staged = { version: info.version, appPath, stageDir };
    armApplyOnQuit();
    console.info(`[SelfUpdate] Staged v${info.version} at ${appPath}`);
    return staged;
  } catch (err) {
    await fsp.rm(stageDir, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
}

/** Single-quote a path for safe interpolation into the apply script. */
function shellQuote(value) {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** Where the detached script leaves its trace when a swap goes wrong. */
function applyLogPath() {
  try {
    const directory = electron().app.getPath("logs");
    fs.mkdirSync(directory, { recursive: true });
    return path.join(directory, "update-apply.log");
  } catch {
    return path.join(os.tmpdir(), "stiva-browser-update-apply.log");
  }
}

/**
 * The swap, as a shell script run by a process that outlives us.
 *
 * It has to happen from outside: the bundle being replaced is the one this
 * process is executing from, so the move can only be safe once we have exited.
 * The script therefore waits on our PID, keeps the old bundle aside until the
 * copy has succeeded so a failure rolls back to a working app, and clears the
 * quarantine attributes an ad-hoc build would otherwise be blocked by.
 */
function buildApplyScript(
  pid,
  stagedAppPath,
  targetPath,
  stageDir,
  relaunch,
  logFile = applyLogPath(),
) {
  const source = shellQuote(stagedAppPath);
  const target = shellQuote(targetPath);
  const stage = shellQuote(stageDir);
  const log = shellQuote(logFile);

  return `#!/bin/bash
set -u
exec >>${log} 2>&1
echo "[stiva-browser-update] $(date '+%Y-%m-%dT%H:%M:%S') applying update"

# Wait for Stiva Browser to exit (up to 30s) — the bundle cannot be moved while it runs.
i=0
while /bin/kill -0 ${pid} 2>/dev/null && [ $i -lt 300 ]; do
  /bin/sleep 0.1
  i=$((i+1))
done
if /bin/kill -0 ${pid} 2>/dev/null; then
  echo "[stiva-browser-update] app is still running; aborting"
  /bin/rm -rf ${stage}
  exit 1
fi
/bin/sleep 0.5

BACKUP=${target}.old-$$
if ! /bin/mv ${target} "$BACKUP"; then
  echo "[stiva-browser-update] could not move the installed app aside"
  /bin/rm -rf ${stage}
  exit 1
fi
if ! /usr/bin/ditto ${source} ${target}; then
  echo "[stiva-browser-update] copy failed; rolling back"
  /bin/rm -rf ${target}
  /bin/mv "$BACKUP" ${target}
  /bin/rm -rf ${stage}
  exit 1
fi
/usr/bin/xattr -cr ${target} || true
/bin/rm -rf "$BACKUP"
/bin/rm -rf ${stage}
echo "[stiva-browser-update] done"
${relaunch ? `/usr/bin/open ${target}` : ""}
`;
}

/**
 * Hand the staged update to a detached process and let it finish after we go.
 *
 * Returns false when there is nothing staged or the swap cannot be attempted,
 * so callers can fall back to sending the user to GitHub.
 */
function applyStagedUpdate({ relaunch }) {
  if (!staged || applying) return false;
  const target = getBundlePath();
  if (!target) return false;

  applying = true;
  const script = buildApplyScript(process.pid, staged.appPath, target, staged.stageDir, relaunch);

  try {
    // Detached with no stdio: the script must survive this process exiting,
    // which is the entire point — it cannot do its job until we are gone.
    const child = spawn("/bin/bash", ["-c", script], { detached: true, stdio: "ignore" });
    child.unref();
    console.info(
      `[SelfUpdate] Apply helper started for v${staged.version} (relaunch=${relaunch}).`,
    );
    return true;
  } catch (err) {
    applying = false;
    console.error("[SelfUpdate] Could not start the apply helper:", err.message);
    return false;
  }
}

/**
 * Apply on quit, mirroring electron-updater's `autoInstallOnAppQuit`.
 *
 * Without this the UI's "Restart to finish" would be a lie for these builds: a
 * user who quits normally instead of pressing the button would come back to the
 * old version and a discarded download. No relaunch here — the user asked to
 * quit.
 */
function armApplyOnQuit() {
  if (quitHookArmed) return;
  quitHookArmed = true;
  electron().app.on("will-quit", () => {
    applyStagedUpdate({ relaunch: false });
  });
}

/** Drops the staged download. Safe to call when nothing is staged. */
async function discardStagedUpdate() {
  if (!staged) return;
  const { stageDir } = staged;
  staged = null;
  await fsp.rm(stageDir, { recursive: true, force: true }).catch(() => {});
}

/**
 * Sweep stage directories a previous run left behind — an update downloaded
 * but never applied, or an apply that died before its cleanup. They are whole
 * app bundles, so leaving them around costs hundreds of megabytes each.
 *
 * Directories touched in the last few minutes are left alone: a detached apply
 * helper from the previous run may still be copying from one, and deleting it
 * would turn a successful quit-and-install into a failed update.
 */
async function cleanupStaleStageDirs() {
  if (process.platform !== "darwin") return;
  const cutoff = Date.now() - 10 * 60 * 1000;
  try {
    const temp = os.tmpdir();
    const entries = await fsp.readdir(temp);
    await Promise.all(
      entries
        .filter((entry) => entry.startsWith(STAGE_PREFIX))
        .filter((entry) => path.join(temp, entry) !== staged?.stageDir)
        .map(async (entry) => {
          const directory = path.join(temp, entry);
          const stats = await fsp.stat(directory).catch(() => null);
          if (!stats || stats.mtimeMs > cutoff) return;
          await fsp.rm(directory, { recursive: true, force: true }).catch(() => {});
        }),
    );
  } catch (err) {
    console.warn("[SelfUpdate] Could not sweep stale update directories:", err.message);
  }
}

module.exports = {
  APP_ID,
  STAGE_PREFIX,
  buildApplyScript,
  cleanupStaleStageDirs,
  discardStagedUpdate,
  getBundlePath,
  hasStagedUpdate,
  isSelfInstallSupported,
  releaseAssetUrl,
  selectMacAsset,
  stageUpdate,
  applyStagedUpdate,
};
