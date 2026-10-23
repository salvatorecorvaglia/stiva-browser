import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import {
  AbortMultipartUploadCommand,
  CreateBucketCommand,
  DeleteObjectsCommand,
  ListBucketsCommand,
  ListMultipartUploadsCommand,
  S3Client,
} from "@aws-sdk/client-s3";

const root = process.cwd();
const suffix = randomUUID().slice(0, 12);
const prefix = `stiva-stage-${suffix}`;
const candidate = process.env.CONTAINER_IMAGE ?? "stiva-browser:1.0.0";
const storageImage = process.env.STIVA_TEST_S3_IMAGE ?? "stiva-s3-fixture:2025-10-15";
const prometheusImage =
  process.env.STIVA_PROMETHEUS_IMAGE ??
  "prom/prometheus:v3.7.3@sha256:49214755b6153f90a597adcbff0252cc61069f8ab69ce8411285cd4a560e8038";
const temporary = await mkdtemp(path.join(os.tmpdir(), "stiva-staging-"));
const containers = new Set();
const volumes = [];
const networks = [];
const network = `${prefix}-network`;
const auth = randomUUID();
const controlToken = randomUUID();
const report = {
  candidate,
  baseline: "",
  baselineRef: "",
  environment: "isolated local Docker staging",
  profiles: [],
  benchmarks: {},
  checks: [],
};
let ownedBaseline;
let agent;
let appName;
let storageClient;
const docker = (...args) =>
  execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const run = (name, args) => {
  docker(
    "run",
    "-d",
    "--name",
    name,
    "--label",
    `stiva.staging=${suffix}`,
    "--network",
    network,
    ...args,
  );
  containers.add(name);
  return name;
};
const volume = (name) => {
  docker("volume", "create", "--label", `stiva.staging=${suffix}`, name);
  volumes.push(name);
  return name;
};
const port = (name, containerPort, scheme = "http") =>
  `${scheme}://${docker("port", name, `${containerPort}/tcp`).split("\n")[0]}`;
async function poll(runCheck, description, timeout = 30000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try {
      const result = await runCheck();
      if (result) return result;
    } catch (error) {
      last = error;
    }
    await delay(150);
  }
  throw new Error(`Timed out: ${description}${last ? ` (${last.message})` : ""}`);
}
function stopApp() {
  if (!appName) return;
  docker("stop", "-t", "40", appName);
  docker("rm", appName);
  containers.delete(appName);
  appName = undefined;
}
function copyVolume(from, to) {
  assert.ok(
    volumes.includes(from) && volumes.includes(to),
    "Only this run's volumes may be restored",
  );
  docker(
    "run",
    "--rm",
    "--network",
    "none",
    "-v",
    `${from}:/from:ro`,
    "-v",
    `${to}:/to`,
    "node:24-alpine",
    "node",
    "-e",
    "const fs=require('fs');for(const n of fs.readdirSync('/to'))fs.rmSync('/to/'+n,{recursive:true,force:true});fs.cpSync('/from/.','/to',{recursive:true});function own(p){fs.chownSync(p,1000,1000);if(fs.statSync(p).isDirectory())for(const n of fs.readdirSync(p))own(p+'/'+n)}own('/to')",
  );
}
function startApp(image, dataVolume, db = "") {
  const name = `${prefix}-app-${randomUUID().slice(0, 6)}`;
  run(name, [
    "--network-alias",
    "app",
    "--init",
    "--read-only",
    "--memory",
    "512m",
    "--cpus",
    "1",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "-e",
    `TRUST_PROXY=${proxyAddress}`,
    "-e",
    "API_RATE_LIMIT=10000",
    "-e",
    `DB_URI=${db}`,
    "-v",
    `${dataVolume}:/data`,
    image,
  ]);
  appName = name;
  return name;
}
function request(base, route, options = {}) {
  const started = performance.now();
  return new Promise((resolve, reject) => {
    const req = https.request(
      new URL(route, base),
      {
        method: options.method ?? "GET",
        agent,
        signal: options.signal ?? AbortSignal.timeout(120000),
        headers: {
          ...(options.auth === false ? {} : { Authorization: `Bearer ${auth}` }),
          ...options.headers,
        },
      },
      async (res) => {
        try {
          const hash = options.hash ? createHash("sha256") : undefined;
          const chunks = [];
          let size = 0;
          for await (const chunk of res) {
            size += chunk.length;
            if (hash) hash.update(chunk);
            else chunks.push(chunk);
          }
          resolve({
            status: res.statusCode,
            headers: res.headers,
            text: hash ? "" : Buffer.concat(chunks).toString(),
            hash: hash?.digest("hex"),
            bytes: size,
            ms: performance.now() - started,
          });
        } catch (error) {
          reject(error);
        }
      },
    );
    req.on("error", reject);
    if (options.body instanceof Readable) {
      options.body.on("error", (error) => req.destroy(error));
      options.body.pipe(req);
    } else req.end(options.body);
  });
}
async function json(base, route, options = {}) {
  const response = await request(base, route, options);
  assert.equal(
    response.status,
    options.status ?? 200,
    `${options.method ?? "GET"} ${route}: ${response.text}`,
  );
  return JSON.parse(response.text);
}
async function control(values) {
  const response = await fetch(`${controlBase}/`, {
    method: values ? "POST" : "GET",
    headers: { Authorization: `Bearer ${controlToken}` },
    body: values ? JSON.stringify(values) : undefined,
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(response.status, 200);
  return response.json();
}
function metric(text, name, operation) {
  const line = text
    .split("\n")
    .find((line) => line.startsWith(`${name}${operation ? `{operation="${operation}"}` : " "}`));
  return Number(line?.trim().split(" ").at(-1));
}
async function metrics() {
  const result = await request(base, "/api/metrics");
  assert.equal(result.status, 200);
  return result.text;
}
async function query(expression) {
  const response = await fetch(
    `${prometheusBase}/api/v1/query?${new URLSearchParams({ query: expression })}`,
    { signal: AbortSignal.timeout(5000) },
  );
  const body = await response.json();
  assert.equal(body.status, "success");
  return body.data.result;
}
async function ready() {
  await poll(
    async () =>
      (await request(base, "/api/health/ready", { signal: AbortSignal.timeout(2000) })).status ===
      200,
    "application readiness",
  );
}
function contents(sizeMiB, seed) {
  const chunk = Buffer.alloc(1024 ** 2, seed);
  return Readable.from(
    (async function* () {
      for (let i = 0; i < sizeMiB; i++) yield chunk;
    })(),
  );
}
function digest(sizeMiB, seed) {
  const hash = createHash("sha256");
  const chunk = Buffer.alloc(1024 ** 2, seed);
  for (let i = 0; i < sizeMiB; i++) hash.update(chunk);
  return hash.digest("hex");
}
function stats(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    count: values.length,
    p50_ms: sorted[Math.floor(sorted.length * 0.5)],
    p95_ms: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))],
    mean_ms: values.reduce((a, b) => a + b, 0) / values.length,
  };
}
async function profile(id, sizeMiB, label) {
  await control({ hold: true });
  const started = performance.now();
  const keys = Array.from({ length: 4 }, (_, i) => `${label}/file-${i}`);
  const pending = keys.map((key, i) =>
    request(base, `/api/stream/upload?${new URLSearchParams({ serverId: id, bucket, key })}`, {
      method: "PUT",
      headers: {
        "Content-Length": String(sizeMiB * 1024 ** 2),
        "Content-Type": "application/octet-stream",
      },
      body: contents(sizeMiB, i + 1),
    }),
  );
  // Attach rejection handlers immediately, retaining the error for the final assertion.
  const settled = Promise.allSettled(pending);
  await poll(
    async () => (await control()).pendingParts >= 8,
    "eight bounded in-flight upload parts",
  );
  const held = await metrics();
  assert.equal(metric(held, "stiva_storage_active", "upload"), 4);
  assert.equal(metric(held, "stiva_storage_peak", "upload"), 4);
  const rejected = await request(
    base,
    `/api/stream/upload?${new URLSearchParams({ serverId: id, bucket, key: `${label}/rejected` })}`,
    { method: "PUT", body: "rejected" },
  );
  assert.equal(rejected.status, 429);
  assert.ok(rejected.headers["retry-after"]);
  const latencies = [];
  for (let i = 0; i < 12; i++) {
    const health = await request(base, "/api/health/ready");
    assert.equal(health.status, 200);
    const listing = await request(
      base,
      `/api/buckets/${bucket}/objects?${new URLSearchParams({ serverId: id })}`,
    );
    assert.equal(listing.status, 200);
    latencies.push(listing.ms);
  }
  await control({ hold: false });
  const results = await settled;
  for (const result of results) {
    assert.equal(result.status, "fulfilled");
    assert.equal(result.value.status, 201);
  }
  const duration = (performance.now() - started) / 1000;
  for (let i = 0; i < keys.length; i++) {
    const downloaded = await request(
      base,
      `/api/stream/download?${new URLSearchParams({ serverId: id, bucket, key: keys[i] })}`,
      { hash: true },
    );
    assert.equal(downloaded.status, 200);
    assert.equal(downloaded.hash, digest(sizeMiB, i + 1));
    assert.equal(downloaded.bytes, sizeMiB * 1024 ** 2);
  }
  const after = await metrics();
  assert.equal(metric(after, "stiva_storage_active", "upload"), 0);
  const memoryPeak = Number(docker("exec", appName, "cat", "/sys/fs/cgroup/memory.peak"));
  if (!Number.isFinite(memoryPeak))
    throw new Error("The staging memory test requires cgroup v2 memory.peak");
  const memoryLimit = 512 * 1024 ** 2;
  assert.ok(
    memoryPeak < 480 * 1024 ** 2,
    `Peak memory ${memoryPeak} exceeded the 480 MiB headroom gate`,
  );
  assert.equal(docker("inspect", "--format", "{{.State.OOMKilled}}", appName), "false");
  const read = stats(latencies);
  assert.ok(read.p95_ms < 1000, `Read p95 ${read.p95_ms} ms exceeded 1 s during saturated uploads`);
  report.profiles.push({
    label,
    concurrency: 4,
    file_mib: sizeMiB,
    total_mib: sizeMiB * 4,
    throughput_mib_s: (sizeMiB * 4) / duration,
    peak_memory_bytes: memoryPeak,
    memory_limit_bytes: memoryLimit,
    reads: read,
    rejected_excess_upload: true,
    sha256_verified: true,
  });
  await storageClient.send(
    new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: keys.map((Key) => ({ Key })) } }),
  );
}

let base;
let controlBase;
let prometheusBase;
let proxyAddress;
const bucket = `stiva-stage-${suffix}`;
try {
  let baseline = process.env.STIVA_BASELINE_IMAGE;
  if (!baseline) {
    const dirty = execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim();
    const ref = process.env.STIVA_BASELINE_REF ?? (dirty ? "HEAD" : "HEAD^");
    report.baselineRef = execFileSync("git", ["rev-parse", ref], { encoding: "utf8" }).trim();
    const directory = path.join(temporary, "baseline");
    await mkdir(directory);
    const archive = path.join(temporary, "baseline.tar");
    await writeFile(archive, execFileSync("git", ["archive", ref]));
    execFileSync("tar", ["-xf", archive, "-C", directory]);
    baseline = `${prefix}-baseline:local`;
    ownedBaseline = baseline;
    execFileSync("docker", ["build", "-t", baseline, directory], { stdio: "inherit" });
  }
  report.baseline = baseline;
  assert.notEqual(
    docker("image", "inspect", "--format", "{{.Id}}", candidate),
    docker("image", "inspect", "--format", "{{.Id}}", baseline),
    "Rollback requires a distinct baseline image",
  );
  docker("network", "create", "--label", `stiva.staging=${suffix}`, network);
  networks.push(network);
  const working = volume(`${prefix}-data`);
  const backup = volume(`${prefix}-backup`);
  await cp(path.join(root, "tests/staging/gateway.mjs"), path.join(temporary, "gateway.mjs"));
  await cp(
    path.join(root, "tests/staging/storage-gate.mjs"),
    path.join(temporary, "storage-gate.mjs"),
  );
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      path.join(temporary, "key.pem"),
      "-out",
      path.join(temporary, "cert.pem"),
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=DNS:localhost,IP:127.0.0.1",
      "-days",
      "1",
    ],
    { stdio: "ignore" },
  );
  agent = new https.Agent({
    keepAlive: true,
    ca: await readFile(path.join(temporary, "cert.pem")),
  });
  const proxy = run(`${prefix}-proxy`, [
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "-e",
    `AUTH_TOKEN=${auth}`,
    "-v",
    `${temporary}:/harness:ro`,
    "-p",
    "127.0.0.1::8443",
    "node:24-alpine",
    "node",
    "/harness/gateway.mjs",
  ]);
  proxyAddress = docker(
    "inspect",
    "--format",
    `{{(index .NetworkSettings.Networks "${network}").IPAddress}}`,
    proxy,
  );
  base = port(proxy, 8443, "https");
  const storage = run(`${prefix}-storage`, [
    "--network-alias",
    "storage",
    "--read-only",
    "--tmpfs",
    "/data:rw,uid=1000,gid=1000,size=768m",
    "--tmpfs",
    "/tmp:rw,uid=1000,gid=1000,size=64m",
    "-e",
    "MINIO_ROOT_USER=fixture-access",
    "-e",
    "MINIO_ROOT_PASSWORD=fixture-secret",
    "-p",
    "127.0.0.1::9000",
    storageImage,
  ]);
  const storageBase = port(storage, 9000);
  await poll(async () => (await fetch(`${storageBase}/minio/health/ready`)).ok, "S3 readiness");
  const gate = run(`${prefix}-gate`, [
    "--network-alias",
    "storage-gate",
    "--read-only",
    "--cap-drop",
    "ALL",
    "-e",
    `CONTROL_TOKEN=${controlToken}`,
    "-v",
    `${temporary}:/harness:ro`,
    "-p",
    "127.0.0.1::9000",
    "-p",
    "127.0.0.1::9001",
    "node:24-alpine",
    "node",
    "/harness/storage-gate.mjs",
  ]);
  controlBase = port(gate, 9001);
  await poll(async () => Boolean(await control()), "storage gate readiness");
  storageClient = new S3Client({
    endpoint: storageBase,
    region: "us-east-1",
    forcePathStyle: true,
    credentials: { accessKeyId: "fixture-access", secretAccessKey: "fixture-secret" },
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  });
  await storageClient.send(new CreateBucketCommand({ Bucket: bucket }));
  startApp(baseline, working);
  await ready();
  for (const route of ["/", "/api/servers", "/api/metrics"])
    assert.equal((await request(base, route, { auth: false })).status, 401);
  const draft = {
    name: "Baseline configuration",
    endpoint_url: "http://storage-gate:9000",
    region: "us-east-1",
    access_key: "fixture-access",
    secret_key: "fixture-secret",
    force_path_style: true,
  };
  const saved = await json(base, "/api/servers", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(draft),
    status: 201,
  });
  const fingerprint = docker(
    "exec",
    appName,
    "node",
    "-e",
    "console.log(require('crypto').createHash('sha256').update(require('fs').readFileSync('/data/master.key')).digest('hex'))",
  );
  stopApp();
  copyVolume(working, backup);
  startApp(candidate, working);
  await ready();
  assert.equal((await json(base, "/api/servers"))[0].id, saved.id);
  assert.equal(
    (await json(base, `/api/buckets?serverId=${saved.id}`)).buckets.some(
      (item) => item.name === bucket,
    ),
    true,
  );
  assert.equal(
    (
      await request(base, "/api/servers", {
        method: "POST",
        headers: { Origin: "https://attacker.invalid", "Content-Type": "application/json" },
        body: JSON.stringify(draft),
      })
    ).status,
    403,
  );
  report.checks.push(
    "HTTPS authentication protects UI and API",
    "baseline data promotes with matching master key",
    "cross-origin changes rejected",
  );

  const promConfig = `global:\n  scrape_interval: 1s\n  evaluation_interval: 1s\nrule_files:\n  - /rules/alerts.yml\nscrape_configs:\n  - job_name: stiva\n    metrics_path: /api/metrics\n    static_configs:\n      - targets: ['app:3000']\n`;
  await writeFile(path.join(temporary, "prometheus.yml"), promConfig);
  docker(
    "run",
    "--rm",
    "--network",
    "none",
    "--entrypoint",
    "promtool",
    "-v",
    `${path.join(root, "monitoring")}:/rules:ro`,
    "-w",
    "/rules",
    prometheusImage,
    "test",
    "rules",
    "alerts.test.yml",
  );
  const prometheus = run(`${prefix}-prometheus`, [
    "--read-only",
    "--tmpfs",
    "/prometheus:rw,uid=65534,gid=65534,size=64m",
    "-v",
    `${path.join(temporary, "prometheus.yml")}:/etc/prometheus/prometheus.yml:ro`,
    "-v",
    `${path.join(root, "monitoring")}:/rules:ro`,
    "-p",
    "127.0.0.1::9090",
    prometheusImage,
  ]);
  prometheusBase = port(prometheus, 9090);
  await poll(
    async () => (await query('up{job="stiva"}'))[0]?.value[1] === "1",
    "Prometheus scrape",
  );
  await profile(saved.id, 16, "sqlite-small");
  await profile(saved.id, 64, "sqlite-large");

  // Same workload, alternating order, measures client creation/connection reuse without changing ownership semantics.
  const direct = port(gate, 9000);
  const credentials = { accessKeyId: "fixture-access", secretAccessKey: "fixture-secret" };
  const make = () =>
    new S3Client({
      endpoint: direct,
      region: "us-east-1",
      forcePathStyle: true,
      credentials,
      requestChecksumCalculation: "WHEN_REQUIRED",
    });
  const shared = make();
  const freshSamples = [];
  const reusedSamples = [];
  try {
    for (let i = 0; i < 35; i++)
      for (const reuse of i % 2 ? [true, false] : [false, true]) {
        const start = performance.now();
        const client = reuse ? shared : make();
        await client.send(new ListBucketsCommand({ MaxBuckets: 1000 }));
        if (!reuse) client.destroy();
        if (i >= 5) (reuse ? reusedSamples : freshSamples).push(performance.now() - start);
      }
  } finally {
    shared.destroy();
  }
  report.benchmarks = {
    samples_per_mode: 30,
    fresh_client: stats(freshSamples),
    reused_client: stats(reusedSamples),
    decision:
      "Retain request-scoped clients: saturated read SLO and memory gates pass; credential invalidation and multipart cleanup remain explicit. Reuse measurements are recorded for future workload-specific tuning.",
  };

  await control({ failComplete: true, failAbort: true });
  const failed = await request(
    base,
    `/api/stream/upload?${new URLSearchParams({ serverId: saved.id, bucket, key: "private-failure-key" })}`,
    { method: "PUT", headers: { "Content-Length": String(17 * 1024 ** 2) }, body: contents(17, 7) },
  );
  assert.equal(failed.status, 502);
  assert.equal(JSON.parse(failed.text).error.code, "MULTIPART_CLEANUP_FAILED");
  assert.equal(metric(await metrics(), "stiva_multipart_cleanup_failures_total"), 1);
  await poll(
    async () =>
      (await query('ALERTS{alertname="StivaMultipartCleanupFailed",alertstate="firing"}')).length >
      0,
    "cleanup alert firing",
  );
  await control({ failComplete: false, failAbort: false });
  const incomplete = await storageClient.send(new ListMultipartUploadsCommand({ Bucket: bucket }));
  for (const upload of incomplete.Uploads ?? [])
    await storageClient.send(
      new AbortMultipartUploadCommand({
        Bucket: bucket,
        Key: upload.Key,
        UploadId: upload.UploadId,
      }),
    );
  assert.equal(
    (await storageClient.send(new ListMultipartUploadsCommand({ Bucket: bucket }))).Uploads
      ?.length ?? 0,
    0,
  );
  const logResult = spawnSync("docker", ["logs", appName], { encoding: "utf8" });
  assert.equal(logResult.status, 0);
  const logs = logResult.stdout + logResult.stderr;
  assert.ok(logs.includes('"event":"multipart_cleanup_failed"'));
  for (const secret of ["fixture-secret", auth, "private-failure-key", "X-Amz-Signature"])
    assert.equal(logs.includes(secret), false);
  assert.equal((await metrics()).includes("private-failure-key"), false);
  report.checks.push(
    "four concurrent uploads stay below 480 MiB with valid SHA-256",
    "reads remain below 1 s p95 during saturated uploads",
    "fifth upload rejected before writes",
    "Prometheus scrapes metrics and cleanup alert fires",
    "logs and metric labels omit credentials and keys",
    "incomplete uploads recover through explicit operator cleanup",
  );

  const { access_key: _a, secret_key: _s, ...update } = draft;
  await json(base, `/api/servers/${saved.id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...update, name: "Candidate persisted" }),
  });
  stopApp();
  startApp(baseline, working);
  await ready();
  assert.equal((await json(base, "/api/servers"))[0].name, "Candidate persisted");
  await json(base, `/api/buckets?serverId=${saved.id}`);
  assert.equal(
    docker(
      "exec",
      appName,
      "node",
      "-e",
      "console.log(require('crypto').createHash('sha256').update(require('fs').readFileSync('/data/master.key')).digest('hex'))",
    ),
    fingerprint,
  );
  stopApp();
  copyVolume(backup, working);
  startApp(candidate, working);
  await ready();
  assert.equal((await json(base, "/api/servers"))[0].name, "Baseline configuration");
  await json(base, `/api/buckets?serverId=${saved.id}`);
  report.checks.push(
    "binary rollback retains candidate-written SQLite data and credentials",
    "offline SQLite backup restores with the matching key",
    "candidate re-promotion succeeds",
  );

  stopApp();
  const database = run(`${prefix}-postgres`, [
    "--network-alias",
    "database",
    "--tmpfs",
    "/var/lib/postgresql/data",
    "-e",
    "POSTGRES_HOST_AUTH_METHOD=trust",
    "-e",
    "POSTGRES_DB=stage",
    "postgres:17-alpine",
  ]);
  await poll(() => {
    try {
      return docker("exec", database, "pg_isready", "-U", "postgres").includes(
        "accepting connections",
      );
    } catch {
      return false;
    }
  }, "PostgreSQL readiness");
  const pgVolume = volume(`${prefix}-pg-key`);
  const uri = "postgresql://postgres@database/stage";
  startApp(baseline, pgVolume, uri);
  await ready();
  const pgSaved = await json(base, "/api/servers", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(draft),
    status: 201,
  });
  stopApp();
  const dump = docker("exec", database, "pg_dump", "-U", "postgres", "stage");
  startApp(candidate, pgVolume, uri);
  await ready();
  await json(base, `/api/buckets?serverId=${pgSaved.id}`);
  await profile(pgSaved.id, 16, "postgres");
  await json(base, `/api/servers/${pgSaved.id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...update, name: "PostgreSQL candidate" }),
  });
  stopApp();
  startApp(baseline, pgVolume, uri);
  await ready();
  assert.equal((await json(base, "/api/servers"))[0].name, "PostgreSQL candidate");
  await json(base, `/api/buckets?serverId=${pgSaved.id}`);
  stopApp();
  docker("exec", database, "createdb", "-U", "postgres", "stage_restore");
  execFileSync(
    "docker",
    [
      "exec",
      "-i",
      database,
      "psql",
      "-U",
      "postgres",
      "-d",
      "stage_restore",
      "--set",
      "ON_ERROR_STOP=1",
    ],
    { input: dump, stdio: ["pipe", "pipe", "pipe"] },
  );
  startApp(candidate, pgVolume, "postgresql://postgres@database/stage_restore");
  await ready();
  assert.equal((await json(base, "/api/servers"))[0].name, "Baseline configuration");
  await json(base, `/api/buckets?serverId=${pgSaved.id}`);
  report.checks.push(
    "PostgreSQL production images promote and roll back with preserved credentials",
    "pg_dump restores into an empty database using the matching key",
  );
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.failure = error.message;
  if (appName) console.error(docker("logs", "--tail", "15", appName));
  throw error;
} finally {
  storageClient?.destroy();
  agent?.destroy();
  await mkdir(path.join(root, "test-results"), { recursive: true });
  await writeFile(
    path.join(root, "test-results/staging-report.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  for (const name of [...containers].reverse()) {
    try {
      docker("rm", "-f", name);
    } catch {
      /* preserve the original failure */
    }
  }
  for (const name of volumes.reverse()) {
    try {
      docker("volume", "rm", name);
    } catch {
      /* cleanup evidence remains in Docker */
    }
  }
  for (const name of networks.reverse()) {
    try {
      docker("network", "rm", name);
    } catch {
      /* cleanup */
    }
  }
  if (ownedBaseline) {
    try {
      docker("image", "rm", ownedBaseline);
    } catch {
      /* cleanup */
    }
  }
  await rm(temporary, { recursive: true, force: true });
}
console.log(JSON.stringify(report, null, 2));
