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

## PostgreSQL and migration

Set `DB_URI` to a `postgresql://` or `postgres://` connection URI before starting the server. Use a dedicated database and a database account that can run the initial schema migrations. PostgreSQL connection and TLS options follow the `pg` driver's URI configuration. S3 credentials remain encrypted in the database and are still entered through the UI; `DB_URI` contains database connection settings only.

Keep `/data` persisted when using PostgreSQL: losing `master.key` still prevents decryption. Continue using one application replica unless all instances are provisioned with the same key and appropriate shared storage. Deletion previews are process-local and expire on restart.

To move an existing SQLite installation to an **empty** PostgreSQL database:
1. Stop the application and back up the existing data directory.
2. Set `DATA_DIR` to that directory and `DB_URI` to the destination database.
3. Run `pnpm build`, then `node dist/server/migrate.js` (inside Docker, use the same image, environment, and data mount, overriding the command).
4. Start the application with `DB_URI` and the same `DATA_DIR`.

The migration copies encrypted records in a transaction, retains their IDs and timestamps, and does not delete SQLite or replace the key. It refuses a nonempty destination. Selecting PostgreSQL without running this migration opens a separate database; configurations are not transferred automatically. For PostgreSQL backups, retain a database backup such as `pg_dump` **and** the matching master key.

## Access model

This deployment is a shared workspace, as selected during planning. There are no application accounts, isolated tenants, or per-user S3 permissions. Every visitor can manage all registered servers and use their credentials through the API. Put both the UI **and `/api`** behind your existing authentication proxy or authenticated ingress before exposing the application. Use HTTPS and restrict outbound access to the S3 endpoints your operators need; endpoint management intentionally supports private network addresses.

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
docker build -t stiva-browser:1.0.0 .
docker volume create stiva-data
docker run --name stiva-browser --init -p 127.0.0.1:3000:3000 -v stiva-data:/data stiva-browser:1.0.0
```

The image runs as UID 1000 and serves on port 3000. For bind mounts, pre-create a writable data directory for UID 1000. The host machine's `localhost` is not an S3 server inside a container: use a Docker-network service name, an accessible hostname, or `host.docker.internal` where supported.

## Kubernetes

Build/push the image to your registry, change the deployment image and ingress hostname, and attach your existing authentication middleware and HTTPS configuration. Then:

```sh
kubectl apply -f k8s/
```

The manifests use a 2 GiB ReadWriteOnce PVC, a single replica, `Recreate` upgrades, ClusterIP port 3000, and a standard Ingress using the Traefik ingress class. Choose your cluster's ingress class and storage class as needed. SQLite requires local-filesystem-compatible locking; do not use unsuitable network filesystems or scale replicas against one SQLite volume. There is no S3 credential Secret manifest. `/api/health/live` reports process health; `/api/health/ready` checks database access.

## REST API

JSON errors have `{ "error": { "code": "…", "message": "…" } }`. Server responses omit secrets and mask access keys. Supply actual credentials only on creation/replacement; omit either field during updates to retain it.

| Method | Route                                   | Input / behavior                                                                                      |
| ------ | --------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| GET    | `/api/servers`                          | Sanitized registered configurations                                                                   |
| POST   | `/api/servers`                          | `name`, `endpoint_url`, `region`, `access_key`, `secret_key`, `force_path_style`                      |
| PUT    | `/api/servers/:id`                      | Same configuration; omitted credential fields are retained                                            |
| DELETE | `/api/servers/:id`                      | Removes configuration only                                                                            |
| POST   | `/api/servers/test`                     | Draft configuration; optional `id` reuses stored credentials; never saves                             |
| GET    | `/api/buckets`                          | Lists buckets                                                                                         |
| GET    | `/api/buckets/:bucket/objects`          | `prefix`, `delimiter=/`, optional `continuationToken`; returns `objects`, `prefixes`, `next_token`    |
| GET    | `/api/buckets/:bucket/objects/metadata` | Query `key`                                                                                           |
| POST   | `/api/buckets/:bucket/folders`          | `{ "key": "folder/" }`                                                                                |
| DELETE | `/api/buckets/:bucket/objects`          | `{ "keys": ["key"] }`; up to 10,000 keys, chunks of 1,000; returns deleted keys and individual errors |
| POST   | `/api/presigned-url/download`           | `bucket`, `key`, optional `expiresIn` (60–3600 seconds; default 900)                                  |
| POST   | `/api/presigned-url/upload`             | Same, plus optional `contentType`; returns `url`, `expires_at`, `required_headers`                    |
| GET    | `/api/stream/download`                  | Query `bucket`, `key`; optional `preview=true` for bounded safe previews                              |
| PUT    | `/api/stream/upload`                    | Query `bucket`, `key`; raw file body and its Content-Type                                             |

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

Existing React hook dependencies, button types, and static-element interaction findings are temporarily reported as warnings in `biome.json`; the remaining recommended rules keep their default severity.

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
