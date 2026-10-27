import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

// JSON is a YAML subset, accepted by electron-updater's manifest parser.
// Build one macOS feed from both architectures after collecting the installers.
export async function writeUpdateManifests(directory, version) {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error("Expected a release version without the v prefix");
  }
  const targets = {
    "latest-mac.yml": [`mac_arm64.zip`, `mac_x64.zip`],
    "latest.yml": [`win_x64.exe`],
    "latest-linux.yml": [`linux_x64.AppImage`],
  };
  const manifests = [];
  for (const [name, suffixes] of Object.entries(targets)) {
    const files = [];
    for (const suffix of suffixes) {
      const url = `stiva-browser_${version}_${suffix}`;
      const asset = path.join(directory, url);
      const metadata = await stat(asset);
      if (!metadata.isFile() || metadata.size === 0)
        throw new Error(`Empty or invalid installer: ${url}`);
      const hash = createHash("sha512");
      for await (const chunk of createReadStream(asset)) hash.update(chunk);
      files.push({ url, sha512: hash.digest("base64"), size: metadata.size });
    }
    manifests.push([
      name,
      {
        version,
        files,
        path: files[0].url,
        sha512: files[0].sha512,
        releaseDate: new Date().toISOString(),
      },
    ]);
  }
  // Validate every platform before writing any feed.
  for (const [name, manifest] of manifests) {
    await writeFile(path.join(directory, name), `${JSON.stringify(manifest, null, 2)}\n`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await writeUpdateManifests(process.argv[2], process.argv[3]?.replace(/^v/, ""));
}
