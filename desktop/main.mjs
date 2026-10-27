import { randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, dialog, Menu, session, shell } from "electron";
import { isExternal, isLocal } from "./policy.mjs";
import { startDesktop } from "./runtime/server/desktop.js";
import { createUpdateUI } from "./update-ui.mjs";
import updater from "./updater.cjs";

// An explicit profile override also allows isolated tests of packaged applications.
if (process.env.STIVA_DESKTOP_DATA_DIR) {
  app.setPath("userData", path.resolve(process.env.STIVA_DESKTOP_DATA_DIR));
}
app.setName("Stiva Browser");
let backend;
let window;
let quitting = false;
let backendClose;
function closeBackend() {
  backendClose ??= backend?.close();
  return backendClose;
}
const updateUI = createUpdateUI({
  updater,
  showDialog: (options) =>
    window ? dialog.showMessageBox(window, options) : dialog.showMessageBox(options),
  prepareInstall: closeBackend,
  refreshMenu: (state) => {
    const item = Menu.getApplicationMenu()?.getMenuItemById("check-updates");
    if (!item) return;
    item.enabled = state.canCheck && !["checking", "downloading"].includes(state.status);
    item.label =
      state.status === "downloading"
        ? `Downloading update… ${Math.round(state.percent)}%`
        : state.status === "ready"
          ? "Restart to update…"
          : "Check for updates…";
  },
});
const locked = app.requestSingleInstanceLock();
if (!locked) app.quit();
else {
  app.on("second-instance", () => {
    if (window?.isMinimized()) window.restore();
    window?.show();
    window?.focus();
  });
  app.on("before-quit", (event) => {
    if (quitting || !backend) return;
    event.preventDefault();
    quitting = true;
    void closeBackend()
      .catch(() => {
        dialog.showErrorBox("Stiva Browser", "Could not finish storage cleanup before quitting.");
      })
      .finally(() => app.quit());
  });
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
  app.on("activate", () => {
    if (backend && !quitting && !window) void openWindow().catch(fail);
  });
  void app
    .whenReady()
    .then(async () => {
      const token = randomBytes(32).toString("hex");
      backend = await startDesktop(
        path.join(app.getPath("userData"), "storage"),
        fileURLToPath(new URL("./runtime/web/", import.meta.url)),
        token,
      );
      const desktopSession = session.fromPartition("stiva-desktop");
      desktopSession.setPermissionRequestHandler((_contents, _permission, callback) =>
        callback(false),
      );
      desktopSession.setPermissionCheckHandler(() => false);
      desktopSession.webRequest.onBeforeSendHeaders((details, callback) => {
        const headers = details.requestHeaders;
        // Never send the private session token to storage endpoints or redirects.
        for (const key of Object.keys(headers)) {
          if (key.toLowerCase() === "x-stiva-desktop-token") delete headers[key];
        }
        if (isLocal(details.url, backend.origin)) headers["x-stiva-desktop-token"] = token;
        callback({ requestHeaders: headers });
      });
      Menu.setApplicationMenu(
        Menu.buildFromTemplate([
          ...(process.platform === "darwin" ? [{ role: "appMenu" }] : []),
          { role: "fileMenu" },
          { role: "editMenu" },
          {
            label: "View",
            submenu: [
              { role: "reload" },
              { role: "resetZoom" },
              { role: "zoomIn" },
              { role: "zoomOut" },
              { role: "togglefullscreen" },
            ],
          },
          { role: "windowMenu" },
          {
            role: "help",
            submenu: [
              {
                id: "check-updates",
                label: "Check for updates…",
                click: () => void updateUI.check(),
              },
            ],
          },
        ]),
      );
      await openWindow();
      updater.initAutoUpdater({ onState: updateUI.onState });
    })
    .catch(fail);
}

function fail() {
  dialog.showErrorBox(
    "Stiva Browser",
    "Unable to start the desktop workspace. Check available disk space and permissions in the application data directory.",
  );
  app.quit();
}
async function openWindow() {
  window = new BrowserWindow({
    title: "Stiva Browser",
    icon: fileURLToPath(new URL("./assets/icon.png", import.meta.url)),
    width: 1280,
    height: 850,
    minWidth: 860,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      partition: "stiva-desktop",
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webviewTag: false,
    },
  });
  const contents = window.webContents;
  contents.on("will-attach-webview", (event) => event.preventDefault());
  for (const eventName of ["will-navigate", "will-redirect"]) {
    contents.on(eventName, (event, url) => {
      if (!isLocal(url, backend.origin)) event.preventDefault();
    });
  }
  contents.setWindowOpenHandler(({ url }) => {
    if (isLocal(url, backend.origin)) {
      // Download links use the existing authenticated stream endpoint.
      if (new URL(url).pathname === "/api/stream/download") contents.downloadURL(url);
    } else if (isExternal(url)) {
      void dialog
        .showMessageBox(window, {
          type: "question",
          message: "Open this link in your browser?",
          detail: new URL(url).origin,
          buttons: ["Cancel", "Open"],
          defaultId: 0,
          cancelId: 0,
        })
        .then(({ response }) => {
          if (response === 1) return shell.openExternal(url);
        })
        .catch(() => {});
    }
    return { action: "deny" };
  });
  window.once("ready-to-show", () => window?.show());
  window.on("closed", () => {
    window = undefined;
  });
  await window.loadURL(backend.origin);
}
