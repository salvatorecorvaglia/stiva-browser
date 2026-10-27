import { cp, readFile, rm } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const pkg = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
const desktop = JSON.parse(await readFile(new URL("desktop/package.json", root), "utf8"));
if (pkg.version !== desktop.version) throw new Error("Root and desktop versions must match");
for (const [name, version] of Object.entries(desktop.dependencies)) {
  if (name === "electron-updater") continue;
  if (pkg.dependencies[name] !== version) throw new Error(`Desktop dependency drift: ${name}`);
}
await rm(new URL("desktop/runtime/", root), { recursive: true, force: true });
await cp(new URL("dist/", root), new URL("desktop/runtime/", root), { recursive: true });
