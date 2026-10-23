# Stiva Browser 🖼️

**A shared internal dashboard for AWS S3, MinIO, and other S3-compatible servers**

**Stiva Browser** is a self-hosted web dashboard for managing files on AWS S3, MinIO, and other S3-compatible storage servers.

## Run locally

Requires Node.js 24 or later and pnpm 11.23.0 (`corepack enable` enables the pinned package manager).

```sh
pnpm install --frozen-lockfile
pnpm dev
```

Open http://localhost:5173. Vite proxies `/api` to Express on port 3000. Select **Manage servers**, enter your endpoint, region, access key and secret key, test the connection, and save. AWS endpoints usually use virtual-host addressing; disable path style if your provider requires it. MinIO usually uses path-style addressing.

```sh
pnpm check
pnpm typecheck
pnpm test
pnpm build
pnpm start
```

Production serves both the dashboard and API at http://localhost:3000. Runtime settings are `PORT` (default `3000`), `DATA_DIR` (default `./data`), and optional `DB_URI` for PostgreSQL. Without `DB_URI`, SQLite is used. The encryption key always remains in the data directory, including with PostgreSQL.

## Resource limits and proxy configuration

The shared workspace still requires an authentication proxy protecting both the dashboard and `/api`.
Configure `TRUST_PROXY` with the proxy's exact IP addresses or CIDRs (comma-separated) so throttling
uses the visitor's IP. It defaults to disabled; `true` is rejected. Ensure the proxy overwrites
forwarded headers and preserves the public Host header. Health probes are excluded from throttling.

| Setting                   | Default | Behavior                                  |
| ------------------------- | ------- | ----------------------------------------- |
| `API_RATE_LIMIT`          | `600`   | API requests per client IP per minute     |
| `MAX_CONCURRENT_UPLOADS`  | `4`     | Active backend uploads per process        |
| `MAX_CONCURRENT_RESTORES` | `2`     | Active version restores per process       |
| `MAX_CONCURRENT_PREVIEWS` | `2`     | Active recursive folder scans per process |

Limits must be positive integers. Excess work returns 429 with `Retry-After`; it is not queued.
Static assets retain a separate 300-request-per-minute budget. Keep one replica: limits and deletion
snapshots are process-local. Tune limits against available memory and monitor 429 responses before
raising them. Backend uploads use two concurrent parts, with 8–16 MiB parts selected from
Content-Length: known-length uploads support up to 156.25 GiB; unknown-length uploads up to
78.125 GiB. Larger files are rejected with an explicit limit error. An inactive connection closes
after 60 seconds; individual upstream requests enforce a 120-second deadline. Multipart failure or
cancellation settles active parts and attempts cleanup with an independent 15-second deadline.
Cleanup failures explicitly ask operators to inspect incomplete uploads. Shutdown stops accepting requests, closes remaining HTTP connections after 15 seconds, and waits for storage cleanup before closing the database. Kubernetes allows 45 seconds for this drain.

`GET /api/metrics` exports Prometheus request histograms, admission outcomes, cleanup failures,
process memory and uptime. Protect it with the same authentication boundary as the API or scrape
through a restricted internal network. See [monitoring](monitoring/README.md) for alert rules.

Production logs contain route templates, status codes, operation durations, and admission activity;
they omit keys, endpoint URLs, credentials, request bodies, and presigned URLs.

## Files and transfers

- Browse buckets and folders, paginate objects, create folder markers, inspect metadata, preview text/raster images, download, copy expiring links, and delete selected objects.
- Browser uploads use presigned PUT URLs by default. The endpoint must be reachable by the browser, use a compatible HTTP/HTTPS scheme, and allow your dashboard origin through its bucket CORS policy.
- Select **Transfer through backend** for private endpoints or buckets without CORS. Failed uploads offer an explicit backend retry. Retrying an upload can overwrite the same key, so the UI checks for existing objects and asks before replacement. This check is advisory and does not prevent concurrent writers.
- Download buttons use the backend stream. **Copy presigned URL** provides direct S3 downloads; signed URLs grant temporary bearer access and expire after 15 minutes by default.
- Proxy uploads stream with bounded memory and multipart cleanup. Direct PUT uploads are limited by your provider's single-PUT limits; use proxy mode for large objects. Configure ingress upload limits and timeouts for your expected files.
- Text previews show at most 1 MiB. Raster image previews are limited to 1 MiB. HTML and SVG are never rendered inline. Preview is intentionally unavailable for other formats.
- Search filters the current page. Counters and sizes describe that page, not the entire bucket.
- Deletion uses normal S3 semantics, including delete markers for versioned buckets. Folder rows offer recursive deletion with an object-count/size preview and exact typed prefix confirmation. A preview covers at most 10,000 current objects, expires after five minutes, is bound to the selected server configuration, and can be submitted once. Only keys captured in that preview are deleted; keys added afterward are excluded. Existing keys overwritten after preview are still addressed by their key, so avoid concurrent writers during deletion. Partial failures are reported, and historical versions are retained. Split larger folders into smaller subfolders.
- **Versions** lists historical data and delete markers for the current location, including objects hidden from the normal listing. Search by exact object key, load more history, download old versions, restore an old version as a new current version, or permanently delete a specific version/marker. Restore and permanent deletion require typing the complete key. Deleting the current delete marker can make older contents visible again. Version permissions and S3 Object Lock rules still apply. Restore uses server-side copy, including bounded multipart copy for objects larger than 5 GiB; multipart restore preserves metadata and tags and cleans up failed copies.
- Static long-lived S3 credentials are supported. Session tokens, bucket creation, ACL editing, and lifecycle management are outside this version. Authentication changes and deployment to a live Kubernetes cluster remain deferred at your request.

Example development-only bucket CORS policy (replace the origin in production):

```json
{
  "CORSRules": [
    {
      "AllowedOrigins": ["http://localhost:5173"],
      "AllowedMethods": ["PUT", "GET", "HEAD"],
      "AllowedHeaders": ["*"],
      "ExposeHeaders": ["ETag"]
    }
  ]
}
```

## Credential encryption and backups

Both credential fields use AES-256-GCM with a unique nonce and authenticated, versioned ciphertext. A 32-byte `master.key` is created atomically on first startup with mode `0600`. It is persisted beside `stiva.sqlite`, not stored in the database, image, environment, or repository. Startup fails when credentials exist but the key is missing, invalid, or does not decrypt them.

Back up the **database and matching key together**. The local key protects credentials in a database-only leak; access to the complete data volume permits decryption. Protect volume backups accordingly. There is no automatic key rotation in this release.

For a consistent offline backup, stop the process/container, copy the entire data directory (including any SQLite WAL/SHM files), and restart it. Restore that directory to the persistent volume with ownership readable/writable by UID/GID 1000 and mode `0600` on `master.key`. Do not copy a running SQLite database without SQLite's backup tooling. Do not generate a replacement key for existing records.

## Docker

```sh
docker pull corvaglia91/stiva-browser:1.1.0
docker volume create stiva-data
docker run --name stiva-browser --init -p 127.0.0.1:3000:3000 -v stiva-data:/data corvaglia91/stiva-browser:1.1.0
```

The image runs as UID 1000 and serves on port 3000. For bind mounts, pre-create a writable data directory for UID 1000. The host machine's `localhost` is not an S3 server inside a container: use a Docker-network service name, an accessible hostname, or `host.docker.internal` where supported.

## Kubernetes

The deployment uses `corvaglia91/stiva-browser:1.1.0`; you can also use the corresponding GHCR image. Change the ingress hostname and attach your existing authentication middleware and HTTPS configuration. Then:

```sh
kubectl apply -f k8s/
```

The manifests use a 2 GiB ReadWriteOnce PVC, a single replica, `Recreate` upgrades, ClusterIP port 3000, and a standard Ingress using the Traefik ingress class. Choose your cluster's ingress class and storage class as needed. SQLite requires local-filesystem-compatible locking; do not use unsuitable network filesystems or scale replicas against one SQLite volume. There is no S3 credential Secret manifest. `/api/health/live` reports process health; `/api/health/ready` checks database access.

## REST API

JSON errors have `{ "error": { "code": "…", "message": "…" } }`. Server responses omit secrets and mask access keys. They include an opaque `revision`. To reject stale edits, send `If-Match: "<revision>"` on server updates; a changed configuration returns 412 and a deleted configuration returns 404. The UI uses conditional updates. Clients omitting the header retain compatibility, and omitted credentials are retained from the current row transactionally. Supply actual credentials only on creation/replacement; omit either field during updates to retain it.

| Method | Route                                   | Input / behavior                                                                                                                   |
| ------ | --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/api/servers`                          | Sanitized registered configurations                                                                                                |
| POST   | `/api/servers`                          | `name`, `endpoint_url`, `region`, `access_key`, `secret_key`, `force_path_style`                                                   |
| PUT    | `/api/servers/:id`                      | Same configuration; omitted credential fields are retained                                                                         |
| DELETE | `/api/servers/:id`                      | Removes configuration only                                                                                                         |
| POST   | `/api/servers/test`                     | Draft configuration; optional `id` reuses stored credentials; never saves                                                          |
| GET    | `/api/buckets`                          | Lists buckets                                                                                                                      |
| GET    | `/api/buckets/:bucket/objects`          | `prefix`, `delimiter=/`, optional `continuationToken`; returns `objects`, `prefixes`, `next_token`                                 |
| GET    | `/api/buckets/:bucket/objects/metadata` | Query `key`                                                                                                                        |
| POST   | `/api/buckets/:bucket/folders`          | `{ "key": "folder/" }`                                                                                                             |
| DELETE | `/api/buckets/:bucket/objects`          | `{ "keys": ["key"] }`; up to 10,000 keys within a 64 KiB JSON body, S3 chunks of 1,000; returns deleted keys and individual errors |
| POST   | `/api/presigned-url/download`           | `bucket`, `key`, optional `expiresIn` (60–3600 seconds; default 900)                                                               |
| POST   | `/api/presigned-url/upload`             | Same, plus optional `contentType`; returns `url`, `expires_at`, `required_headers`                                                 |
| GET    | `/api/stream/download`                  | Query `bucket`, `key`; optional `preview=true` for bounded safe previews                                                           |
| PUT    | `/api/stream/upload`                    | Query `bucket`, `key`; raw file body and its Content-Type                                                                          |

Additional object-management routes:

| Method | Route                                         | Input / behavior                                                                                                              |
| ------ | --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/api/buckets/:bucket/folders/delete-preview` | Query `prefix` ending in `/`; returns count, size, sample, `preview_token`, and expiration                                    |
| DELETE | `/api/buckets/:bucket/folders`                | JSON `prefix`, `confirmation` matching the complete prefix, and `preview_token`; returns deleted keys and individual failures |
| GET    | `/api/buckets/:bucket/versions`               | Query `prefix` or exact `key`; optional `keyMarker` and `versionIdMarker`; returns versions, delete markers, and next markers |
| DELETE | `/api/buckets/:bucket/versions`               | JSON `key`, `versionId`, `confirmation` matching the complete key; permanently deletes that version or marker                 |
| POST   | `/api/buckets/:bucket/versions/restore`       | Same JSON; copies that historical version into a new current version                                                          |

Metadata, backend download/preview, and presigned download routes also accept an optional `versionId`. Uploads always create a new current version and reject `versionId` in presigning requests. Historical versions cannot be overwritten in place.

All bucket/object/transfer routes require `x-s3-server-id: <id>` or `?serverId=<id>`. Conflicting identifiers are rejected. URL-encode bucket names and keys. HTTP(S) endpoints may include a base path but cannot embed credentials, query strings, or fragments.

Biome handles linting and formatting. Run `pnpm check` to check both, `pnpm lint` for linting only, `pnpm format:check` to verify formatting, or `pnpm format` to format files. `pnpm check:fix` applies safe lint, import, and formatting fixes.

`pnpm check` rejects lint warnings as well as errors. Intentional refresh dependencies and focusable
tab panels have narrowly documented suppressions. Run `pnpm test:coverage` for backend coverage
gates (85% lines and 65% branches), `pnpm test:browser` for Chromium, Firefox, WebKit, keyboard,
and axe accessibility regressions,
and `pnpm test:s3` for both live integration suites against disposable localhost-only S3 fixtures.
The S3 runner builds pinned MinIO community source because its historical binary registries are
unavailable; the first build needs network access and Docker. Set `STIVA_TEST_S3_IMAGE` to use an
existing compatible fixture image instead. Fixtures are removed after the run.

Before promotion, use disposable buckets, run PostgreSQL/S3/browser/container checks, and back up
the database with its matching master key. Retain the previous application image for rollback.
Monitor storage failures, cleanup failures, active work, latency, 429 responses, and container memory.
The database schema and credential encryption format remain compatible with existing installations.

Run `pnpm test:staging` after building the application and S3 fixture images. It provisions an isolated
local Docker environment with HTTPS, an authentication proxy, Prometheus, disposable S3 storage,
SQLite and PostgreSQL. It verifies four concurrent uploads under a 512 MiB memory limit, excess-work
rejection, read latency, SHA-256 integrity, cleanup alerting, redacted logs, image rollback, and backup
restoration. Measurements are written to `test-results/staging-report.json`; all owned containers,
volumes, networks, and temporary baseline image tags are removed afterward. It never uses a live
cluster or existing data volume. By default it builds the baseline from HEAD for a dirty working tree,
or HEAD^ for a clean checkout; set `STIVA_BASELINE_REF` or `STIVA_BASELINE_IMAGE` to test a specific
previous release. A baseline image must differ from the candidate. See [monitoring](monitoring/README.md)
and the [incremental implementation and validation record](docs/remediation.md).

---

## 🤝 Contributing

Contributions are welcome! Please see [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## 📜 Changelog

Detailed release history and version changes can be found in [CHANGELOG.md](CHANGELOG.md).

## 🔐 Security

If you discover a security vulnerability, please see our [Security Policy](SECURITY.md).

## 📝 License

Distributed under the MIT License. See [LICENSE](LICENSE) for more information.

---

**Author**: [Salvatore Corvaglia](https://github.com/salvatorecorvaglia)
