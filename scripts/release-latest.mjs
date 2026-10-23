import { appendFileSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const stablePattern = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export function mayPublishLatest(tag, refs) {
  const candidate = stablePattern.exec(tag);
  if (!candidate) return false;
  const version = candidate.slice(1).map(BigInt);
  let found = false;
  for (const ref of refs) {
    const name = ref.replace(/^refs\/tags\//, "");
    if (name === tag) found = true;
    const match = stablePattern.exec(name);
    if (!match) continue;
    const other = match.slice(1).map(BigInt);
    for (let i = 0; i < version.length; i++) {
      if (other[i] > version[i]) return false;
      if (other[i] < version[i]) break;
    }
  }
  // Fail closed if the API response does not include the release being published.
  if (!found) throw new Error(`Release tag ${tag} was not returned by GitHub.`);
  return true;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const refs = readFileSync(process.argv[2], "utf8").trim().split(/\r?\n/);
  const publish = mayPublishLatest(process.env.RELEASE_TAG, refs);
  appendFileSync(process.env.GITHUB_OUTPUT, `publish=${publish}\n`);
  console.log(`${process.env.RELEASE_TAG}: update latest = ${publish}`);
}
