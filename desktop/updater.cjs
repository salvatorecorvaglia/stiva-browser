const { execFile } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { posix } = require("node:path");
const { promisify } = require("node:util");
const {
  applyStagedUpdate,
  cleanupStaleStageDirs,
  getBundlePath,
  hasStagedUpdate,
  isSelfInstallSupported,
  stageUpdate,
} = require("./mac-self-update.cjs");

const execFileAsync = promisify(execFile);

/**
 * Auto-updates for the Stiva Browser desktop app.
 *
 * The feed is the `latest*.yml` manifest electron-builder writes into every
 * release. It is fetched through GitHub's stable `releases/latest/download`
 * URL, which needs no API token and has none of the API's rate limits:
 *
 *   https://github.com/salvatorecorvaglia/stiva-browser/releases/latest/download/latest-mac.yml
 *
 * How a build installs an update depends on what it is running from:
 *
 *  - `squirrel` — Windows, Linux AppImage, and macOS builds with a real
 *    Developer ID. electron-updater drives the platform installer.
 *  - `self`     — unsigned macOS builds. Squirrel rejects those bundles, so
 *    `mac-self-update.cjs` swaps the app in place.
 *  - `manual`   — Homebrew/Scoop/deb installs (the package manager owns the
 *    files) and macOS bundles this user cannot write. Stiva Browser still checks the
 *    feed and says a version exists, but sends the user to their package
 *    manager or GitHub instead of fighting it.
 *
 * Updates are never downloaded without the user pressing the button:
 * `autoDownload` is off. The startup check only asks whether a newer version
 * exists.
 */

const OWNER = "salvatorecorvaglia";
const REPO = "stiva-browser";

/** Human-facing page: the fallback when a build cannot update itself. */
const RELEASES_URL = `https://github.com/${OWNER}/${REPO}/releases/latest`;

const MANUAL_MESSAGES = {
  unsigned:
    "This macOS build cannot install updates itself. Download the latest version from GitHub.",
  "read-only":
    "Stiva Browser cannot write to its install location. Download the latest version from GitHub.",
  "system-package":
    "This copy is managed by your system package manager. Update it with your package manager.",
  development: "Updates are available only in packaged builds.",
};

/** How long after launch the silent check runs. */
const STARTUP_CHECK_DELAY_MS = 5000;

const state = {
  status: "idle",
  currentVersion: "",
  version: null,
  percent: 0,
  bytesPerSecond: null,
  error: null,
  mode: "manual",
  canCheck: false,
  canInstall: false,
  reason: null,
  packageManager: null,
  command: null,
  checkedAt: null,
};

let onStateChange = () => {};
let initialized = false;
let updater = null;
let inFlightCheck = null;
let manualCheck = false;
let downloadInFlight = false;
let selfInstallInFlight = false;
let pendingUpdate = null;
let squirrelDownloaded = false;
let autoInstallSupport = null;

function electron() {
  return require("electron");
}

function snapshot() {
  return { ...state };
}

function emit() {
  try {
    onStateChange(snapshot());
  } catch (err) {
    console.error("[Updater] State listener failed:", err.message);
  }
}

function setState(patch) {
  Object.assign(state, patch);
  emit();
}

/**
 * Detects an install owned by a package manager.
 *
 * These must not be updated in place: Homebrew and Scoop keep their own
 * metadata and would reinstall the old version on the next `upgrade`/`update`.
 * The checks are deliberately narrow — a Scoop path, or a cask receipt plus a
 * bundle in an Applications folder — so a normal drag-installed app is not
 * mistaken for a managed one.
 */
function detectPackageManager({
  platform = process.platform,
  execPath = process.execPath,
  bundlePath = getBundlePath(platform, execPath),
  exists = fs.existsSync,
  home = os.homedir(),
} = {}) {
  if (platform === "win32") {
    if (/[\\/]scoop[\\/]apps[\\/]stiva-browser[\\/]/i.test(execPath)) {
      return { kind: "scoop", command: "scoop update stiva-browser" };
    }
    return null;
  }

  if (platform === "darwin" && bundlePath) {
    const inApplications =
      bundlePath.startsWith("/Applications/") ||
      bundlePath.startsWith(posix.join(home, "Applications") + "/");

    const prefixes = [
      process.env.HOMEBREW_PREFIX && posix.join(process.env.HOMEBREW_PREFIX, "Caskroom"),
      "/opt/homebrew/Caskroom",
      "/usr/local/Caskroom",
    ].filter(Boolean);
    // The bundle normally lives in /Applications and is tracked by a Caskroom
    // receipt. Some setups launch it from the receipt itself; both are managed.
    const inCaskroom = prefixes.some(
      (prefix) =>
        bundlePath === posix.join(prefix, "stiva-browser") ||
        bundlePath.startsWith(posix.join(prefix, "stiva-browser") + "/"),
    );
    if (
      inCaskroom ||
      (inApplications && prefixes.some((prefix) => exists(posix.join(prefix, "stiva-browser"))))
    ) {
      return { kind: "homebrew", command: "brew upgrade --cask stiva-browser" };
    }
  }

  return null;
}

/** True when Squirrel can replace this build: Windows, Linux, or a signed Mac. */
async function detectAutoInstallSupport() {
  if (process.platform !== "darwin") return true;

  const bundlePath = getBundlePath();
  if (!bundlePath) return false;

  try {
    // A real Developer ID is what Squirrel checks for. An ad-hoc signature
    // (`identity: '-'`) shows as "Signature=adhoc" and can never satisfy it.
    // codesign writes its report to stderr, not stdout.
    const { stdout, stderr } = await execFileAsync(
      "/usr/bin/codesign",
      ["--display", "--verbose=2", bundlePath],
      { timeout: 10000 },
    );
    const report = `${stdout}\n${stderr}`;
    return /^Authority=/m.test(report) && !/^Signature=adhoc$/m.test(report);
  } catch {
    return false;
  }
}

function isAutoInstallSupported() {
  autoInstallSupport ??= detectAutoInstallSupport().catch(() => false);
  return autoInstallSupport;
}

/** Pure mode decision, separated so the platform rules stay testable. */
function decideUpdateMode({
  isPackaged,
  platform,
  packageManager = null,
  autoInstall = false,
  selfInstall = false,
  appImage = null,
  appImageWritable = true,
}) {
  if (!isPackaged) return { mode: "manual", reason: "development" };

  if (packageManager) {
    return {
      mode: "manual",
      reason: "package-manager",
      packageManager: packageManager.kind,
      command: packageManager.command,
    };
  }

  if (platform === "darwin") {
    // Squirrel.Mac replaces the bundle in place exactly like the self-updater:
    // if the user cannot write to the install location (or the app is running
    // translocated), no automatic route can succeed.
    if (!selfInstall) return { mode: "manual", reason: "read-only" };
    return { mode: autoInstall ? "squirrel" : "self" };
  }

  if (platform === "linux") {
    if (!appImage) {
      // A .deb/.rpm install is root-owned and must go through the package
      // manager. Only an AppImage (which sets APPIMAGE) is self-contained.
      return {
        mode: "manual",
        reason: "system-package",
        packageManager: "deb",
        command: "Update Stiva Browser with your system package manager.",
      };
    }
    if (!appImageWritable) return { mode: "manual", reason: "read-only" };
  }

  return { mode: "squirrel" };
}

/** Resolves how this build can take an update, plus the manual fallback text. */
async function resolveUpdateMode() {
  const { app } = electron();
  const isPackaged = app.isPackaged;
  const platform = process.platform;
  if (!isPackaged) return decideUpdateMode({ isPackaged, platform });

  const packageManager = detectPackageManager();
  let autoInstall = false;
  let selfInstall = false;
  if (platform === "darwin" && !packageManager) {
    autoInstall = await isAutoInstallSupported();
    selfInstall = await isSelfInstallSupported();
  }

  let appImage = null;
  let appImageWritable = true;
  if (platform === "linux") {
    appImage = process.env.APPIMAGE || null;
    if (appImage) {
      try {
        fs.accessSync(appImage, fs.constants.W_OK);
        fs.accessSync(path.dirname(appImage), fs.constants.W_OK);
      } catch {
        appImageWritable = false;
      }
    }
  }

  return decideUpdateMode({
    isPackaged,
    platform,
    packageManager,
    autoInstall,
    selfInstall,
    appImage,
    appImageWritable,
  });
}

/** Applies the current mode to the public state and returns it. */
async function refreshMode() {
  const mode = await resolveUpdateMode();
  if (updater) updater.autoInstallOnAppQuit = mode.mode === "squirrel";
  setState({
    mode: mode.mode,
    reason: mode.reason ?? null,
    packageManager: mode.packageManager ?? null,
    command: mode.command ?? null,
    canCheck: electron().app.isPackaged,
    canInstall: mode.mode !== "manual",
  });
  return mode;
}

function manualMessage() {
  if (state.reason === "package-manager") {
    return state.command
      ? `This copy is installed with ${state.packageManager === "homebrew" ? "Homebrew" : "Scoop"}. Update it with: ${state.command}`
      : "This copy is managed by a package manager. Update it with your package manager.";
  }
  return MANUAL_MESSAGES[state.reason] ?? "Download the latest version from GitHub.";
}

/** Turns electron-updater's errors into something a person can act on. */
function describeUpdateError(err, platform = process.platform) {
  const message = err instanceof Error ? err.message : String(err);
  const lower = message.toLowerCase();
  if (
    platform === "darwin" &&
    (lower.includes("code signature at url") ||
      lower.includes("did not pass validation") ||
      lower.includes("could not get code signature"))
  ) {
    return MANUAL_MESSAGES.unsigned;
  }
  if (
    lower.includes("net::err") ||
    lower.includes("enotfound") ||
    lower.includes("econn") ||
    lower.includes("etimedout")
  ) {
    return "Could not reach the update server. Check your connection and try again.";
  }
  return message;
}

function markChecked() {
  return { checkedAt: new Date().toISOString() };
}

/**
 * Wires electron-updater's events into our state.
 *
 * Called once, after the window exists and the app is ready. In development it
 * only marks the updater unavailable — importing/running electron-updater from
 * `electron .` would look for an app-update.yml that a packaged build has and
 * a dev run does not.
 */
function initAutoUpdater({ onState } = {}) {
  if (initialized) return;
  initialized = true;

  const { app } = electron();
  onStateChange = typeof onState === "function" ? onState : () => {};
  state.currentVersion = app.getVersion();
  state.canCheck = app.isPackaged;

  if (!app.isPackaged) {
    setState({ reason: "development" });
    return;
  }

  try {
    ({ autoUpdater: updater } = require("electron-updater"));
  } catch (err) {
    console.error("[Updater] electron-updater is unavailable:", err.message);
    setState({ status: "error", error: "The updater is unavailable in this build." });
    return;
  }

  void refreshMode().catch((err) => {
    console.error("[Updater] Could not resolve the update mode:", err.message);
  });
  void cleanupStaleStageDirs();

  updater.autoDownload = false;
  // An update staged for install-on-quit hits the same Squirrel validation as
  // an explicit install, so arm it only where installing can succeed. The
  // self-update path arms its own hook after a package is staged.
  updater.autoInstallOnAppQuit = false;
  updater.allowDowngrade = false;
  updater.allowPrerelease = false;
  updater.disableDifferentialDownload = true;

  updater.on("update-available", (info) => {
    if (squirrelDownloaded && pendingUpdate?.version !== info.version) {
      // Do not let an install action apply the previous version's download.
      squirrelDownloaded = false;
    }
    pendingUpdate = {
      version: info.version,
      files: Array.isArray(info.files) ? info.files : [],
    };
    // Resolve the mode before publishing "available": the UI must not offer a
    // Download button for a Homebrew install and take it away a moment later.
    void refreshMode()
      .catch((err) => {
        console.error("[Updater] Could not resolve the update mode:", err.message);
      })
      .then(() => {
        if (pendingUpdate?.version !== info.version) return;
        if (
          (state.status === "downloading" || state.status === "ready") &&
          state.version === info.version
        ) {
          return;
        }
        setState({
          status: "available",
          version: info.version,
          percent: 0,
          bytesPerSecond: null,
          error: null,
          ...markChecked(),
        });
      });
  });

  updater.on("update-not-available", () => {
    pendingUpdate = null;
    squirrelDownloaded = false;
    setState({
      status: "idle",
      version: null,
      percent: 0,
      bytesPerSecond: null,
      error: null,
      ...markChecked(),
    });
  });

  updater.on("download-progress", (progress) => {
    setState({
      status: "downloading",
      percent: Math.max(0, Math.min(100, progress.percent || 0)),
      bytesPerSecond: Math.round(progress.bytesPerSecond || 0),
      error: null,
    });
  });

  updater.on("update-downloaded", () => {
    squirrelDownloaded = true;
    setState({
      status: "ready",
      percent: 100,
      bytesPerSecond: null,
      error: null,
      ...markChecked(),
    });
  });

  updater.on("error", (err) => {
    const message = describeUpdateError(err);
    console.error("[Updater]", message);
    // A failed startup check is usually just "offline". Do not greet the user
    // with a red banner for it; a failed manual check or download is worth it.
    if (
      manualCheck ||
      downloadInFlight ||
      selfInstallInFlight ||
      state.status === "downloading" ||
      state.status === "ready"
    ) {
      setState({ status: "error", error: message, ...markChecked() });
    } else {
      setState({ status: "idle", error: null, ...markChecked() });
    }
  });

  if (process.env.STIVA_DISABLE_UPDATE_CHECK !== "1") {
    const timer = setTimeout(() => {
      void checkForUpdate({ manual: false });
    }, STARTUP_CHECK_DELAY_MS);
    if (typeof timer.unref === "function") timer.unref();
  }
}

function getUpdateState() {
  return snapshot();
}

/**
 * Asks the feed for a newer version. `manual` controls whether a failure is
 * surfaced: the background check at launch stays quiet, the button does not.
 */
async function checkForUpdate({ manual = true } = {}) {
  if (!updater) return snapshot();
  if (state.status === "ready") return snapshot();
  if (inFlightCheck) return inFlightCheck;
  if (downloadInFlight || selfInstallInFlight) return snapshot();

  await refreshMode();
  manualCheck = manual;
  setState({ status: "checking", error: null });

  inFlightCheck = (async () => {
    try {
      await updater.checkForUpdates();
      if (state.status === "checking" && !pendingUpdate) {
        // update-not-available normally handles this, but a provider that
        // resolves without emitting would otherwise leave the UI spinning. Do
        // not clobber an update-available event whose mode refresh is still in
        // flight: pendingUpdate is set synchronously by that handler.
        setState({
          status: "idle",
          version: null,
          percent: 0,
          ...markChecked(),
        });
      }
    } catch (err) {
      const message = describeUpdateError(err);
      if (manual) setState({ status: "error", error: message, ...markChecked() });
      else if (state.status === "checking") {
        setState({ status: "idle", error: null, ...markChecked() });
      }
    } finally {
      inFlightCheck = null;
      manualCheck = false;
    }
    return snapshot();
  })();

  return inFlightCheck;
}

/** Downloads the update, or applies one that is already downloaded/staged. */
async function installUpdate() {
  if (!updater) return false;

  const mode = await refreshMode();
  if (mode.mode === "manual") {
    // The UI should never offer this, but a stale window or a menu action can.
    setState({
      status: state.status === "available" ? "available" : "error",
      error: manualMessage(),
    });
    return false;
  }

  if (mode.mode === "self") {
    await installBySelfReplace();
    return true;
  }

  if (squirrelDownloaded) {
    updater.quitAndInstall(false, true);
    return true;
  }
  if (downloadInFlight) return false;

  downloadInFlight = true;
  setState({ status: "downloading", percent: 0, bytesPerSecond: null, error: null });
  try {
    await updater.downloadUpdate();
  } catch (err) {
    setState({ status: "error", error: describeUpdateError(err), ...markChecked() });
  } finally {
    downloadInFlight = false;
  }
  return true;
}

async function installBySelfReplace() {
  if (hasStagedUpdate()) {
    if (!applyStagedUpdate({ relaunch: true })) {
      setState({
        status: "error",
        error: "The update is ready, but Stiva Browser could not start the installer.",
      });
      return;
    }
    electron().app.quit();
    return;
  }

  if (selfInstallInFlight) return;
  if (!pendingUpdate) {
    setState({
      status: "error",
      error: "No update is ready. Check for updates again.",
      ...markChecked(),
    });
    return;
  }

  selfInstallInFlight = true;
  setState({ status: "downloading", percent: 0, bytesPerSecond: null, error: null });
  try {
    await stageUpdate(pendingUpdate, (percent, bytesPerSecond) => {
      setState({
        status: "downloading",
        percent: Math.max(0, Math.min(100, percent)),
        bytesPerSecond: Math.round(bytesPerSecond),
        error: null,
      });
    });
    setState({
      status: "ready",
      percent: 100,
      bytesPerSecond: null,
      error: null,
      ...markChecked(),
    });
  } catch (err) {
    setState({
      status: "error",
      error: err instanceof Error ? err.message : String(err),
      ...markChecked(),
    });
  } finally {
    selfInstallInFlight = false;
  }
}

/** Opens the GitHub releases page in the user's browser. */
async function openReleasePage() {
  await electron().shell.openExternal(RELEASES_URL);
  return true;
}

module.exports = {
  RELEASES_URL,
  checkForUpdate,
  decideUpdateMode,
  describeUpdateError,
  detectPackageManager,
  getUpdateState,
  initAutoUpdater,
  installUpdate,
  manualMessage,
  openReleasePage,
};
