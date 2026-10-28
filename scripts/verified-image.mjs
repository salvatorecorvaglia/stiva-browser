import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

async function digest(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
export async function verifyArchive(directory, arch, commit) {
  const metadata = JSON.parse(readFileSync(join(directory, "image.json"), "utf8"));
  if (
    !["amd64", "arm64"].includes(arch) ||
    metadata.arch !== arch ||
    metadata.commit !== commit ||
    metadata.os !== "linux"
  )
    throw new Error("Image build identity mismatch");
  if (!/^sha256:[a-f0-9]{64}$/.test(metadata.id) || !/^[a-z0-9./:_-]+$/.test(metadata.source))
    throw new Error("Invalid image identity");
  if ((await digest(join(directory, "image.tar.gz"))) !== metadata.sha256)
    throw new Error("Image archive checksum mismatch");
  return metadata;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, directory, arch, source] = process.argv.slice(2);
  if (command === "record") {
    const image = JSON.parse(
      execFileSync("docker", ["image", "inspect", source], { encoding: "utf8" }),
    )[0];
    if (image.Os !== "linux" || image.Architecture !== arch)
      throw new Error("Wrong native image platform");
    writeFileSync(
      join(directory, "image.json"),
      JSON.stringify({
        source,
        id: image.Id,
        os: image.Os,
        arch,
        commit: process.env.GITHUB_SHA,
        sha256: await digest(join(directory, "image.tar.gz")),
      }),
    );
  } else if (command === "load") {
    const metadata = await verifyArchive(directory, arch, process.env.GITHUB_SHA);
    execFileSync("docker", ["load", "--input", join(directory, "image.tar.gz")], {
      stdio: "inherit",
    });
    const actual = JSON.parse(
      execFileSync("docker", ["image", "inspect", metadata.source], { encoding: "utf8" }),
    )[0];
    if (actual.Id !== metadata.id || actual.Architecture !== arch || actual.Os !== "linux")
      throw new Error("Loaded image differs from the tested image");
    for (const image of ["corvaglia91/stiva-browser", process.env.GHCR_IMAGE]) {
      execFileSync("docker", ["tag", metadata.id, `${image}:${process.env.BUILD_TAG}`], {
        stdio: "inherit",
      });
    }
  } else throw new Error("Expected record or load");
}
