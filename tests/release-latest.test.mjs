import assert from "node:assert/strict";
import { test } from "node:test";
import { mayPublishLatest } from "../scripts/release-latest.mjs";

test("the highest stable tag may publish latest, including on a rerun", () => {
  assert.equal(mayPublishLatest("v1.10.0", ["refs/tags/v1.9.9", "refs/tags/v1.10.0"]), true);
  assert.equal(mayPublishLatest("v2.0.0", ["v1.99.99", "v2.0.0"]), true);
});

test("older releases cannot downgrade latest across major, minor, or patch versions", () => {
  for (const [older, newer] of [
    ["v1.9.9", "v1.10.0"],
    ["v1.99.99", "v2.0.0"],
    ["v1.0.9", "v1.0.10"],
    ["v1.0.9007199254740992", "v1.0.9007199254740993"],
  ]) {
    assert.equal(mayPublishLatest(older, [older, newer]), false);
  }
});

test("prereleases and malformed tags never publish latest", () => {
  for (const tag of ["v2.0.0-rc.1", "v2.0.0+build.1", "v01.0.0", "1.0.0"]) {
    assert.equal(mayPublishLatest(tag, [tag]), false);
  }
});

test("newer prerelease and unrelated refs do not prevent a stable release", () => {
  assert.equal(mayPublishLatest("v1.0.0", ["v1.0.0", "v2.0.0-rc.1", "vnext"]), true);
});

test("an absent release tag fails closed", () => {
  assert.throws(() => mayPublishLatest("v1.0.0", []), /not returned by GitHub/);
});
