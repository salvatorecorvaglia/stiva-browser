import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

const name = `stiva-smoke-${randomUUID().slice(0, 12)}`;
const volume = `${name}-data`;
const image = process.env.CONTAINER_IMAGE || "stiva-browser:1.0.0";
const platform = process.env.CONTAINER_PLATFORM;
const docker = (...args) =>
  execFileSync("docker", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
let created = false;
let volumeCreated = false;
try {
  docker("volume", "create", volume);
  volumeCreated = true;
  docker(
    "run",
    ...(platform ? ["--platform", platform] : []),
    "-d",
    "--name",
    name,
    "--init",
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "-p",
    "127.0.0.1::3000",
    "-v",
    `${volume}:/data`,
    image,
  );
  created = true;
  let base = `http://${docker("port", name, "3000/tcp").split("\n")[0]}`;
  async function ready() {
    for (let i = 0; i < 240; i++) {
      try {
        if ((await fetch(`${base}/api/health/ready`)).ok) return;
      } catch {
        /* startup */
      }
      await delay(250);
    }
    throw new Error("Container did not become ready");
  }
  await ready();
  assert.equal(docker("exec", name, "id", "-u"), "1000");
  if (platform) {
    assert.equal(
      docker("exec", name, "node", "-p", "process.arch"),
      platform === "linux/amd64" ? "x64" : "arm64",
    );
  }
  const html = await (await fetch(base)).text();
  assert.ok(html.includes("Stiva Browser"));
  const config = {
    name: "Persistent fixture",
    endpoint_url: "http://example.invalid",
    region: "us-east-1",
    access_key: "smoke-access",
    secret_key: "smoke-secret",
    force_path_style: true,
  };
  const response = await fetch(`${base}/api/servers`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(config),
  });
  assert.equal(response.status, 201);
  const saved = await response.json();
  assert.ok(saved.id);
  assert.equal(saved.secret_key, undefined);
  docker("restart", "-t", "5", name);
  base = `http://${docker("port", name, "3000/tcp").split("\n")[0]}`;
  await ready();
  const list = await (await fetch(`${base}/api/servers`)).json();
  assert.equal(list[0].id, saved.id);
  assert.equal(
    docker(
      "exec",
      name,
      "node",
      "-e",
      "const fs=require('fs'); const key=fs.statSync('/data/master.key'); if((key.mode&511)!==384)process.exit(1); const K=require('knex'); const db=K({client:'better-sqlite3',connection:{filename:'/data/stiva.sqlite'},useNullAsDefault:true}); db('s3_servers').first().then(r=>{if(!r.secret_key.startsWith('v1:')||r.secret_key.includes('smoke-secret')||r.access_key.includes('smoke-access'))process.exitCode=1;return db.destroy()}).then(()=>console.log('encrypted'))",
    ),
    "encrypted",
  );
  console.log(
    "Container smoke passed: non-root, read-only root filesystem, static UI, health, encrypted credentials, and volume persistence.",
  );
} catch (error) {
  if (created) console.error(docker("logs", "--tail", "20", name));
  throw error;
} finally {
  if (created) docker("rm", "-f", name);
  if (volumeCreated) docker("volume", "rm", volume);
}
