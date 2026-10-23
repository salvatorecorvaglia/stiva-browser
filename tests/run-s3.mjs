import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

const docker = (...args) =>
  execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const image = process.env.STIVA_TEST_S3_IMAGE ?? "stiva-s3-fixture:2025-10-15";
if (!process.env.STIVA_TEST_S3_IMAGE)
  execFileSync("docker", ["build", "-t", image, "tests/s3-fixture"], { stdio: "inherit" });
const names = [];
try {
  const endpoints = [];
  for (let i = 0; i < 2; i++) {
    const name = `stiva-s3-test-${randomUUID().slice(0, 12)}`;
    docker(
      "run",
      "-d",
      "--name",
      name,
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--read-only",
      "--tmpfs",
      "/data:rw,uid=1000,gid=1000,size=256m",
      "--tmpfs",
      "/tmp:rw,uid=1000,gid=1000,size=64m",
      "-e",
      "MINIO_ROOT_USER=fixture-access",
      "-e",
      "MINIO_ROOT_PASSWORD=fixture-secret",
      "-p",
      "127.0.0.1::9000",
      image,
    );
    names.push(name);
    const endpoint = `http://${docker("port", name, "9000/tcp").split("\n")[0]}`;
    let ready = false;
    for (let attempt = 0; attempt < 120; attempt++) {
      try {
        if (
          (await fetch(`${endpoint}/minio/health/ready`, { signal: AbortSignal.timeout(1000) })).ok
        ) {
          ready = true;
          break;
        }
      } catch {
        /* startup */
      }
      await delay(250);
    }
    if (!ready) throw new Error("S3 fixture did not become ready");
    endpoints.push(endpoint);
  }
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "--test", "tests/integration.test.ts", "tests/versions-live.test.ts"],
    {
      stdio: "inherit",
      env: {
        ...process.env,
        STIVA_TEST_S3_A: endpoints[0],
        STIVA_TEST_S3_B: endpoints[1],
        STIVA_TEST_VERSIONED_S3: endpoints[0],
        STIVA_TEST_ACCESS_KEY: "fixture-access",
        STIVA_TEST_SECRET_KEY: "fixture-secret",
      },
    },
  );
  process.exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 1));
  });
} catch (error) {
  for (const name of names) console.error(docker("logs", "--tail", "20", name));
  throw error;
} finally {
  for (const name of names) docker("rm", "-f", name);
}
