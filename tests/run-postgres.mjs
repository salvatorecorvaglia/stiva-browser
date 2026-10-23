import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

const name = `stiva-postgres-test-${randomUUID().slice(0, 12)}`;
const docker = (...args) =>
  execFileSync("docker", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
let created = false;
try {
  docker(
    "run",
    "-d",
    "--name",
    name,
    "--tmpfs",
    "/var/lib/postgresql/data",
    "-e",
    "POSTGRES_HOST_AUTH_METHOD=trust",
    "-p",
    "127.0.0.1::5432",
    "postgres:17-alpine",
  );
  created = true;
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      docker("exec", name, "pg_isready", "-U", "postgres");
      ready = true;
      break;
    } catch {
      await delay(250);
    }
  }
  if (!ready) throw new Error("PostgreSQL fixture did not start");
  const address = docker("port", name, "5432/tcp").split("\n")[0];
  const child = spawn(process.execPath, ["--import", "tsx", "--test", "tests/postgres.test.ts"], {
    stdio: "inherit",
    env: {
      ...process.env,
      STIVA_TEST_DB_URI: `postgresql://postgres@${address}/postgres`,
    },
  });
  process.exitCode = await new Promise((resolve) =>
    child.once("exit", (code) => resolve(code ?? 1)),
  );
} finally {
  if (created) docker("rm", "-f", name);
}
