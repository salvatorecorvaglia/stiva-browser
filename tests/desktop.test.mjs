import assert from "node:assert/strict";
import test from "node:test";
import { isExternal, isLocal } from "../desktop/policy.mjs";

test("desktop navigation only trusts the exact private origin", () => {
  const origin = "http://127.0.0.1:34123";
  assert.ok(isLocal(`${origin}/api/servers`, origin));
  for (const url of [
    "http://127.0.0.1:34124/",
    "http://localhost:34123/",
    "https://example.com/",
    "file:///etc/passwd",
    "javascript:alert(1)",
    "invalid",
  ]) {
    assert.equal(isLocal(url, origin), false);
  }
});
test("external browser links reject privileged protocols and embedded credentials", () => {
  assert.ok(isExternal("https://example.com/object?signature=test"));
  assert.ok(isExternal("http://localhost:9000/object"));
  for (const url of [
    "file:///etc/passwd",
    "javascript:alert(1)",
    "data:text/html,test",
    "https://user:secret@example.com/",
    "invalid",
  ]) {
    assert.equal(isExternal(url), false);
  }
});
