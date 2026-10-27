// Native dialogs keep update privileges in the main process, outside the web UI.
export function createUpdateUI({ updater, showDialog, refreshMenu, prepareInstall }) {
  let previousStatus;
  let dialogOpen = false;
  let pending;
  let manual = false;

  async function present(state) {
    if (dialogOpen) {
      pending = state;
      return;
    }
    dialogOpen = true;
    try {
      if (state.status === "available") {
        const { response } = await showDialog({
          type: "info",
          message: `Stiva Browser ${state.version} is available`,
          detail: state.canInstall
            ? "Download the update now? Your workspace stays in the application data directory."
            : updater.manualMessage(),
          buttons: ["Later", state.canInstall ? "Download" : "Open releases"],
          defaultId: 0,
          cancelId: 0,
        });
        if (response === 1) {
          if (state.canInstall) await updater.installUpdate();
          else await updater.openReleasePage();
        }
      } else if (state.status === "ready") {
        const { response } = await showDialog({
          type: "info",
          message: "The update is ready",
          detail:
            "Restart to finish installing. If you choose Later, it will be installed when you quit.",
          buttons: ["Later", "Restart now"],
          defaultId: 0,
          cancelId: 0,
        });
        if (response === 1) {
          await prepareInstall();
          await updater.installUpdate();
        }
      } else if (state.status === "error") {
        await showDialog({
          type: "error",
          message: "Could not update Stiva Browser",
          detail: state.error,
        });
      } else if (state.status === "idle") {
        await showDialog({ type: "info", message: "Stiva Browser is up to date" });
      }
    } catch (error) {
      await showDialog({
        type: "error",
        message: "Could not update Stiva Browser",
        detail: error.message,
      });
    } finally {
      dialogOpen = false;
      if (pending) {
        const next = pending;
        pending = undefined;
        void present(next);
      }
    }
  }

  function onState(state) {
    refreshMenu(state);
    const changed = state.status !== previousStatus;
    previousStatus = state.status;
    if (changed && ["available", "ready", "error"].includes(state.status)) {
      void present(state);
    } else if (changed && state.status === "idle" && manual) {
      void present(state);
    }
  }

  async function check() {
    const state = updater.getUpdateState();
    if (["available", "ready"].includes(state.status)) {
      await present(state);
      return;
    }
    if (manual || ["checking", "downloading"].includes(state.status)) return;
    manual = true;
    try {
      await updater.checkForUpdate();
    } finally {
      manual = false;
    }
  }

  return { onState, check };
}
