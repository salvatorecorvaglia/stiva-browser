<p align="center">
  <img src="resources/stiva-browser.svg" alt="Stiva Browser logo" width="96" height="96">
</p>

# Stiva Browser 🖼️

**A shared internal dashboard for AWS S3, MinIO, and other S3-compatible servers**

**Stiva Browser** is a self-hosted web dashboard for managing files on AWS S3, MinIO, and other S3-compatible storage servers.

## Desktop app (macOS, Windows, Linux)

Stiva Browser also runs as a standalone Electron application. The installers bundle
both the web interface and a private local backend; Node.js, Docker, and an
external database are not required on the end user's machine.

| Platform | Architecture            | Packages            |
| -------- | ----------------------- | ------------------- |
| macOS    | Apple Silicon and Intel | `.dmg`, `.zip`      |
| Windows  | x64                     | `.exe` installer    |
| Linux    | x64                     | `.AppImage`, `.deb` |

Install development dependencies for both runtimes, then start the desktop app:

```sh
pnpm install --frozen-lockfile
pnpm --dir desktop install --frozen-lockfile
pnpm desktop:dev
```

## Run locally

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
through a restricted internal network. See [monitoring](monitoring/alerts.yml) for alert rules.

Production logs contain route templates, status codes, operation durations, and admission activity;
they omit keys, endpoint URLs, credentials, request bodies, and presigned URLs.

## Docker

```sh
docker pull corvaglia91/stiva-browser
docker volume create stiva-data
docker run --name stiva-browser --init -p 127.0.0.1:3000:3000 -v stiva-data:/data corvaglia91/stiva-browser
```

The image runs as UID 1000 and serves on port 3000. For bind mounts, pre-create a writable data directory for UID 1000. The host machine's `localhost` is not an S3 server inside a container: use a Docker-network service name, an accessible hostname, or `host.docker.internal` where supported.

## Kubernetes

The deployment uses `corvaglia91/stiva-browser`; you can also use the corresponding GHCR image. Change the ingress hostname and attach your existing authentication middleware and HTTPS configuration. Then:

```sh
kubectl apply -f k8s/
```

The manifests use a 2 GiB ReadWriteOnce PVC, a single replica, `Recreate` upgrades, ClusterIP port 3000, and a standard Ingress using the Traefik ingress class. Choose your cluster's ingress class and storage class as needed. SQLite requires local-filesystem-compatible locking; do not use unsuitable network filesystems or scale replicas against one SQLite volume. There is no S3 credential Secret manifest. `/api/health/live` reports process health; `/api/health/ready` checks database access.

---

## Contributing 🤝

Contributions are welcome! Please see [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## Changelog 📜

Detailed release history and version changes can be found in [CHANGELOG.md](CHANGELOG.md).

## Security 🔐

If you discover a security vulnerability, please see our [Security Policy](SECURITY.md).

## License 📝

Distributed under the MIT License. See [LICENSE](LICENSE) for more information.

## Author ✍️

[Salvatore Corvaglia](https://github.com/salvatorecorvaglia)
