import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import { createUpdateUI } from "../desktop/update-ui.mjs";

function fixture(response = 0) {
  const dialogs = [];
  const actions = [];
  let state = { status: "idle", canCheck: true };
  const updater = {
    getUpdateState: () => state,
    checkForUpdate: async () => {
      ui.onState({ status: "checking" });
      ui.onState({ status: "idle" });
    },
    installUpdate: async () => actions.push("install"),
    openReleasePage: async () => actions.push("releases"),
    manualMessage: () => "Use your package manager",
  };
  const ui = createUpdateUI({
    updater,
    refreshMenu: (next) => {
      state = next;
    },
    prepareInstall: async () => actions.push("drain"),
    showDialog: async (options) => {
      dialogs.push(options);
      return { response };
    },
  });
  return { ui, dialogs, actions };
}

test("startup checks stay silent with no update; manual checks confirm the result", async () => {
  const { ui, dialogs } = fixture();
  ui.onState({ status: "idle" });
  assert.equal(dialogs.length, 0);
  await ui.check();
  assert.equal(dialogs[0].message, "Stiva Browser is up to date");
});

test("Later never downloads; repeated state notifications do not reopen the dialog", async () => {
  const { ui, dialogs, actions } = fixture();
  ui.onState({ status: "available", version: "1.3.0", canInstall: true });
  ui.onState({ status: "available", version: "1.3.0", canInstall: true });
  await setImmediate();
  assert.equal(dialogs.length, 1);
  assert.deepEqual(actions, []);
  await ui.check();
  assert.equal(dialogs.length, 2);
});

test("Download requires confirmation and manual installs open the releases page", async () => {
  for (const canInstall of [true, false]) {
    const { ui, dialogs, actions } = fixture(1);
    ui.onState({ status: "available", version: "1.3.0", canInstall });
    await setImmediate();
    assert.deepEqual(actions, [canInstall ? "install" : "releases"]);
    assert.equal(dialogs[0].buttons[1], canInstall ? "Download" : "Open releases");
  }
});

test("restart drains the private backend before invoking the installer", async () => {
  const { ui, actions } = fixture(1);
  ui.onState({ status: "ready" });
  await setImmediate();
  assert.deepEqual(actions, ["drain", "install"]);
});
