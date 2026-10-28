import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { verifyArchive } from "../scripts/verified-image.mjs";

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "verified-image-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const metadata = {
    arch: "arm64",
    os: "linux",
    commit: "a".repeat(40),
    source: "stiva-browser:ci",
    id: `sha256:${"b".repeat(64)}`,
    sha256: createHash("sha256").update("archive").digest("hex"),
  };
  writeFileSync(join(directory, "image.tar.gz"), "archive");
  writeFileSync(join(directory, "image.json"), JSON.stringify(metadata));
  return { directory, metadata };
}
test("verified bytes retain their native architecture and commit", async (t) => {
  const { directory, metadata } = fixture(t);
  assert.deepEqual(await verifyArchive(directory, "arm64", "a".repeat(40)), metadata);
});
test("tampered archives, wrong architectures and wrong commits are rejected", async (t) => {
  const { directory } = fixture(t);
  await assert.rejects(verifyArchive(directory, "amd64", "a".repeat(40)), /identity/);
  await assert.rejects(verifyArchive(directory, "arm64", "c".repeat(40)), /identity/);
  writeFileSync(join(directory, "image.tar.gz"), "changed");
  await assert.rejects(verifyArchive(directory, "arm64", "a".repeat(40)), /checksum/);
});
