const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { setImmediate: tick } = require("node:timers/promises");
const vm = require("node:vm");

function fixture({ packaged = true, disable = "1" } = {}) {
  const engine = new EventEmitter();
  const actions = [];
  engine.checkForUpdates = async () => engine.emit("update-not-available");
  engine.downloadUpdate = async () => {
    actions.push("download");
    engine.emit("update-downloaded");
  };
  engine.quitAndInstall = () => actions.push("restart");
  const states = [];
  const timers = [];
  const app = { isPackaged: packaged, getVersion: () => "1.2.0" };
  const module = { exports: {} };
  let imports = 0;
  vm.runInNewContext(readFileSync(path.join(__dirname, "../desktop/updater.cjs"), "utf8"), {
    module,
    process: {
      platform: "win32",
      execPath: "C:\\Stiva Browser\\Stiva Browser.exe",
      env: { STIVA_DISABLE_UPDATE_CHECK: disable },
    },
    console: { error() {} },
    setTimeout: (callback) => {
      timers.push(callback);
      return { unref() {} };
    },
    require(name) {
      if (name === "electron") return { app };
      if (name === "electron-updater") {
        imports++;
        return { autoUpdater: engine };
      }
      if (name === "./mac-self-update.cjs")
        return {
          getBundlePath: () => null,
          cleanupStaleStageDirs: async () => {},
        };
      return require(name);
    },
  });
  const updater = module.exports;
  updater.initAutoUpdater({ onState: (state) => states.push(state) });
  return { updater, engine, states, actions, timers, imported: () => imports };
}

test("development never loads electron-updater or schedules a network check", async () => {
  const f = fixture({ packaged: false, disable: undefined });
  await f.updater.checkForUpdate();
  assert.equal(f.imported(), 0);
  assert.equal(f.timers.length, 0);
  assert.equal(f.updater.getUpdateState().canCheck, false);
});

test("startup schedules a check but never downloads without a user action", async () => {
  const f = fixture({ disable: "0" });
  assert.equal(f.timers.length, 1);
  assert.equal(f.engine.autoDownload, false);
  assert.equal(f.engine.allowDowngrade, false);
  assert.equal(f.engine.allowPrerelease, false);
  f.engine.checkForUpdates = async () =>
    f.engine.emit("update-available", { version: "1.3.0", files: [] });
  f.timers[0]();
  await tick();
  assert.equal(f.updater.getUpdateState().status, "available");
  assert.deepEqual(f.actions, []);
  await f.updater.installUpdate();
  assert.equal(f.updater.getUpdateState().status, "ready");
  assert.deepEqual(f.actions, ["download"]);
  await f.updater.installUpdate();
  assert.deepEqual(f.actions, ["download", "restart"]);
});

test("offline startup is quiet; manual checks report failure and can retry", async () => {
  const f = fixture();
  f.engine.checkForUpdates = async () => {
    throw new Error("net::ERR_INTERNET_DISCONNECTED");
  };
  await f.updater.checkForUpdate({ manual: false });
  assert.equal(f.updater.getUpdateState().status, "idle");
  assert.equal(f.updater.getUpdateState().error, null);
  await f.updater.checkForUpdate();
  assert.equal(f.updater.getUpdateState().status, "error");
  assert.match(f.updater.getUpdateState().error, /connection/);
  f.engine.checkForUpdates = async () => f.engine.emit("update-not-available");
  await f.updater.checkForUpdate();
  assert.equal(f.updater.getUpdateState().status, "idle");
});
