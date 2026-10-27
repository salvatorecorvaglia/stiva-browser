const assert = require("node:assert/strict");
const test = require("node:test");
const {
  decideUpdateMode,
  describeUpdateError,
  detectPackageManager,
} = require("../desktop/updater.cjs");
const {
  buildApplyScript,
  getBundlePath,
  releaseAssetUrl,
  selectMacAsset,
} = require("../desktop/mac-self-update.cjs");

test("finds the macOS bundle two levels above the executable", () => {
  assert.equal(
    getBundlePath("darwin", "/Applications/Stiva Browser.app/Contents/MacOS/Stiva Browser"),
    "/Applications/Stiva Browser.app",
  );
  assert.equal(getBundlePath("linux", "/opt/Stiva Browser/stiva-browser"), null);
  assert.equal(getBundlePath("darwin", "/usr/local/bin/stiva-browser"), null);
});

test("picks only the zip for the running architecture", () => {
  const info = {
    version: "1.2.0",
    files: [
      { url: "stiva-browser_1.2.0_mac_arm64.dmg", sha512: "dmg-arm" },
      { url: "stiva-browser_1.2.0_mac_arm64.zip", sha512: "arm" },
      { url: "stiva-browser_1.2.0_mac_x64.zip", sha512: "intel" },
    ],
  };
  assert.equal(selectMacAsset(info, "arm64").sha512, "arm");
  assert.equal(selectMacAsset(info, "x64").sha512, "intel");
});

test("accepts the default electron-builder arch spelling too", () => {
  const info = {
    version: "1.2.0",
    files: [{ url: "stiva-browser-1.2.0-mac-arm64.zip", sha512: "arm" }],
  };
  assert.equal(selectMacAsset(info, "arm64").sha512, "arm");
});

test("refuses an update without a checksum or a matching package", () => {
  assert.throws(
    () =>
      selectMacAsset(
        { version: "1.2.0", files: [{ url: "stiva-browser_1.2.0_mac_arm64.zip" }] },
        "arm64",
      ),
    /checksum/,
  );
  assert.throws(
    () =>
      selectMacAsset(
        { version: "1.2.0", files: [{ url: "stiva-browser_1.2.0_mac_x64.zip", sha512: "x" }] },
        "arm64",
      ),
    /arm64/,
  );
});

test("builds a release asset URL that cannot escape the release path", () => {
  assert.equal(
    releaseAssetUrl("1.2.0", "stiva-browser_1.2.0_mac_arm64.zip"),
    "https://github.com/salvatorecorvaglia/stiva-browser/releases/download/v1.2.0/stiva-browser_1.2.0_mac_arm64.zip",
  );
  assert.ok(releaseAssetUrl("1.2.0", "../evil").includes("..%2Fevil"));
});

test("detects Homebrew installs only for bundles in an Applications folder", () => {
  const caskroom = "/opt/homebrew/Caskroom";
  const base = {
    platform: "darwin",
    home: "/Users/example",
    exists: (file) => file === `${caskroom}/stiva-browser`,
  };
  assert.deepEqual(
    detectPackageManager({
      ...base,
      bundlePath: "/Applications/Stiva Browser.app",
    }),
    { kind: "homebrew", command: "brew upgrade --cask stiva-browser" },
  );
  assert.equal(
    detectPackageManager({
      ...base,
      bundlePath: "/Users/example/Downloads/Stiva Browser.app",
    }),
    null,
  );
  assert.deepEqual(
    detectPackageManager({
      ...base,
      bundlePath: "/opt/homebrew/Caskroom/stiva-browser/1.1.0/Stiva Browser.app",
    }),
    { kind: "homebrew", command: "brew upgrade --cask stiva-browser" },
  );
});

test("detects Scoop installs from the executable path", () => {
  assert.deepEqual(
    detectPackageManager({
      platform: "win32",
      execPath: "C:\\Users\\example\\scoop\\apps\\stiva-browser\\current\\Stiva Browser.exe",
    }),
    { kind: "scoop", command: "scoop update stiva-browser" },
  );
  assert.equal(
    detectPackageManager({
      platform: "win32",
      execPath: "C:\\Program Files\\Stiva Browser\\Stiva Browser.exe",
    }),
    null,
  );
});

test("turns Squirrel signature failures into the manual-download message", () => {
  assert.match(
    describeUpdateError(new Error("Code signature at URL ... did not pass validation"), "darwin"),
    /macOS build cannot install updates itself/,
  );
  assert.equal(
    describeUpdateError(new Error("Code signature at URL ... did not pass validation"), "win32"),
    "Code signature at URL ... did not pass validation",
  );
  assert.match(describeUpdateError(new Error("net::ERR_INTERNET_DISCONNECTED")), /connection/);
  assert.equal(describeUpdateError(new Error("disk full")), "disk full");
});

test("resolves the install route for every platform and package manager", () => {
  const base = { isPackaged: true, platform: "linux", appImage: "/home/x/Stiva Browser.AppImage" };

  assert.deepEqual(decideUpdateMode({ ...base, isPackaged: false }), {
    mode: "manual",
    reason: "development",
  });
  assert.deepEqual(
    decideUpdateMode({
      ...base,
      platform: "darwin",
      packageManager: { kind: "homebrew", command: "brew upgrade --cask stiva-browser" },
    }),
    {
      mode: "manual",
      reason: "package-manager",
      packageManager: "homebrew",
      command: "brew upgrade --cask stiva-browser",
    },
  );
  assert.deepEqual(
    decideUpdateMode({
      ...base,
      platform: "darwin",
      autoInstall: true,
      selfInstall: true,
    }),
    { mode: "squirrel" },
  );
  assert.deepEqual(
    decideUpdateMode({
      ...base,
      platform: "darwin",
      autoInstall: true,
      selfInstall: false,
    }),
    { mode: "manual", reason: "read-only" },
  );
  assert.deepEqual(
    decideUpdateMode({ ...base, platform: "darwin", autoInstall: false, selfInstall: true }),
    { mode: "self" },
  );
  assert.deepEqual(decideUpdateMode({ ...base, platform: "darwin" }), {
    mode: "manual",
    reason: "read-only",
  });
  assert.deepEqual(decideUpdateMode({ ...base, appImage: null }), {
    mode: "manual",
    reason: "system-package",
    packageManager: "deb",
    command: "Update Stiva Browser with your system package manager.",
  });
  assert.deepEqual(decideUpdateMode({ ...base, appImageWritable: false }), {
    mode: "manual",
    reason: "read-only",
  });
  assert.deepEqual(decideUpdateMode(base), { mode: "squirrel" });
  assert.deepEqual(decideUpdateMode({ ...base, platform: "win32" }), { mode: "squirrel" });
  assert.deepEqual(
    decideUpdateMode({
      ...base,
      platform: "win32",
      packageManager: { kind: "scoop", command: "scoop update stiva-browser" },
    }),
    {
      mode: "manual",
      reason: "package-manager",
      packageManager: "scoop",
      command: "scoop update stiva-browser",
    },
  );
});

test("quotes paths in the detached apply script", () => {
  const script = buildApplyScript(
    4242,
    "/tmp/it's here/Stiva Browser.app",
    "/Applications/Stiva Browser.app",
    "/tmp/stiva-browser-update-abc",
    true,
    "/tmp/apply.log",
  );
  assert.ok(script.includes("'/tmp/it'\\''s here/Stiva Browser.app'"));
  assert.ok(script.includes("/bin/kill -0 4242"));
  assert.ok(script.includes("/usr/bin/ditto"));
  assert.ok(script.includes("/usr/bin/open"));
  assert.ok(script.includes("xattr -cr"));

  const quiet = buildApplyScript(1, "/tmp/a", "/tmp/b", "/tmp/c", false, "/tmp/apply.log");
  assert.equal(quiet.includes("/usr/bin/open"), false);
});
