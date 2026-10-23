# Incremental remediation and validation

Changes are grouped in dependency order so each phase can be reviewed and validated separately.
The application remains a single-process shared workspace behind an authentication proxy.

| Phase                          | Implemented scope                                                                                                                                                                | Regression checks                                                                                                                                                    |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Correctness and security    | Raw upload routing, safe preview bounds, encrypted credentials, conditional configuration updates, partial deletion acknowledgments, origin checks                               | API, persistence, network and failure-path tests; PostgreSQL migration and concurrent update checks                                                                  |
| 2. Resource safety             | Bounded multipart uploads/copies, cancellation and cleanup, request deadlines, operation admission, throttling, graceful shutdown                                                | Cancellation/failure tests, real S3 integration, memory-limited production container                                                                                 |
| 3. Maintainability             | Shared contracts, encryption and migrations, deletion and transfer services, workspace components/hooks, feature CSS                                                             | Strict frontend/server/test type checks; warning-free Biome gate; build and existing behavior tests                                                                  |
| 4. Usability and accessibility | Native dialogs with keyboard containment, inspector tabs, navigation focus, reduced motion, contrast, lazy previews, transfer retry and stale-result protection                  | Three browser projects; axe scans of welcome, workspace, management, preview, creation, deletion, versions, errors and mobile states; actual HTTP upload-byte checks |
| 5. Performance                 | Four concurrent uploads at two file sizes, overload admission, reads under saturation, memory headroom, fresh/reused S3 client benchmark                                         | Isolated HTTPS staging, SHA-256 verification, cgroup peak under 480 MiB of a 512 MiB limit, listing p95 under 1 second                                               |
| 6. Operations                  | Prometheus metrics and alert rules, injected cleanup failure, promotion and binary rollback, consistent offline SQLite backup and PostgreSQL dump restoration with matching keys | Promtool rule tests, real firing alert, two distinct production images, SQLite/PostgreSQL credentials and data checks                                                |

CI executes the gates in this order: lint/types/coverage, PostgreSQL, live disposable S3, browsers,
production image and container smoke, then staging. Staging reports contain measurements and baseline
revision/image identifiers and are uploaded even on failure. They contain no credentials.

Client reuse is benchmarked rather than introduced speculatively. Request-scoped S3 clients keep
credential changes and multipart cleanup ownership explicit; the staging report records both modes.
Revisit reuse if deployment measurements show request setup materially affects its latency objective.

The local staging drill validates repository behavior with a test authentication proxy and generated
TLS certificate. It does not deploy to an external cluster, validate a site's identity provider or
certificate chain, or send production notifications. Before deploying, configure the actual ingress,
authentication, exact proxy trust, persistent storage and notification receiver. Repeat the drill
against the intended previous image, back up the database together with its matching master key,
and verify your site's authentication and alert delivery. No external target is configured here.

Automated accessibility checks cover representative states and keyboard behavior; they do not
replace assistive-technology testing with users. Performance figures describe the measured local
Docker workload, not a throughput guarantee for every S3 provider or deployment.

## Local validation record (2026-10-23)

Backend checks passed: 40 tests, 97.53% line coverage and 86.30% branch coverage. The three
conditionally skipped integration cases passed separately through the PostgreSQL and S3 runners.
The full production and development dependency audit reported no known vulnerabilities. Lint/formatting, type checks,
production build and non-root/read-only container smoke passed.

All 45 Chromium, Firefox and WebKit regression/accessibility checks passed in the pinned Linux test
image. Chromium and WebKit also passed all 30 checks natively on macOS. The local macOS Firefox
binary failed before browser startup with a profile-folder error; the Linux run verified the full
Firefox suite without skipping tests.

The final staging drill passed against baseline revision `a6f00af51b1d2a56f60af3a105d00c43d33b6795`.
Every profile ran four concurrent uploads, rejected a fifth upload, verified SHA-256 downloads and
kept the application container within its 512 MiB limit:

| Database / file size  | Peak cgroup memory | Listing p95 during saturated uploads | Aggregate throughput |
| --------------------- | ------------------ | ------------------------------------ | -------------------- |
| sqlite-small / 16 MiB | 144.2 MiB          | 6.7 ms                               | 114.7 MiB/s          |
| sqlite-large / 64 MiB | 246.5 MiB          | 6.6 ms                               | 192.2 MiB/s          |
| postgres / 16 MiB     | 126.5 MiB          | 9.1 ms                               | 114.1 MiB/s          |

These are local Docker measurements, including deliberate part-response holds to force admission
saturation. They are intended as regression evidence. The complete generated report is
`test-results/staging-report.json`; CI publishes it as the `staging-report` artifact.
