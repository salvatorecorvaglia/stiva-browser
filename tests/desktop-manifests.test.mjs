import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { writeUpdateManifests } from "../scripts/desktop-update-manifests.mjs";

async function fixtures(t) {
  const directory = await mkdtemp(path.join(tmpdir(), "stiva-feeds-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const suffix of ["mac_arm64.zip", "mac_x64.zip", "win_x64.exe", "linux_x64.AppImage"]) {
    await writeFile(path.join(directory, `stiva-browser_1.3.0_${suffix}`), `installer-${suffix}`);
  }
  return directory;
}

test("release feeds contain both Mac architectures and actual artifact hashes and sizes", async (t) => {
  const directory = await fixtures(t);
  await writeUpdateManifests(directory, "1.3.0");
  for (const name of ["latest-mac.yml", "latest.yml", "latest-linux.yml"]) {
    const feed = JSON.parse(await readFile(path.join(directory, name), "utf8"));
    assert.equal(feed.version, "1.3.0");
    assert.equal(feed.files.length, name === "latest-mac.yml" ? 2 : 1);
    assert.equal(feed.path, feed.files[0].url);
    for (const file of feed.files) {
      const content = await readFile(path.join(directory, file.url));
      assert.equal(file.size, content.length);
      assert.equal(file.sha512, createHash("sha512").update(content).digest("base64"));
    }
  }
});

test("missing or empty installers prevent publishing any update feed", async (t) => {
  const directory = await fixtures(t);
  const linux = path.join(directory, "stiva-browser_1.3.0_linux_x64.AppImage");
  await rm(linux);
  await assert.rejects(writeUpdateManifests(directory, "1.3.0"), /ENOENT/);
  assert.equal(
    (await readdir(directory)).some((name) => name.endsWith(".yml")),
    false,
  );
  await writeFile(linux, "");
  await assert.rejects(writeUpdateManifests(directory, "1.3.0"), /Empty/);
  await assert.rejects(writeUpdateManifests(directory, "../invalid"), /release version/);
});
