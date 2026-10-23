# Contributing to Stiva Browser 🖼️

Thanks for helping improve Stiva Browser. Bug reports, features, documentation, and tests are welcome.

## Local setup

1. Fork the repository and clone your fork.
2. Install Node.js 24 or later and pnpm 11.23.0, as pinned in `package.json`.
3. Create a branch for your change, then install dependencies and start development:

```sh
git switch -c fix/describe-your-change
pnpm install --frozen-lockfile
pnpm dev
```

Open http://localhost:5173. Vite proxies `/api` requests to Express on port 3000.
Use disposable S3 buckets and development credentials when testing uploads, restores, or deletion.

The default database is SQLite in `./data`. Set `DATA_DIR` to use a separate development data
directory, or `DB_URI` to use PostgreSQL. Keep credentials, database files, `master.key`, and presigned
URLs out of commits, logs, issue reports, and screenshots.

## Project layout

- `web/`: React interface, styles, and API client.
- `server/`: Express API, S3 services, resource admission, persistence, encryption, and versioned migrations.
- `shared/`: API contracts and validation shared between frontend and backend.
- `tests/`: API, persistence, integration, and browser tests.
- `k8s/` and `Dockerfile`: deployment configuration.
- `.github/workflows/`: CI and release automation.

## Making changes

Keep each pull request focused and follow the surrounding TypeScript patterns. Biome controls
formatting, lint rules, and import organization; use `pnpm check:fix` for safe automatic fixes.
Review the resulting diff and avoid unrelated formatting changes. The check command rejects warnings;
keep any necessary suppressions narrow and explain their behavior.

Add or update tests for behavior changes, especially credential handling, persistence, S3 operations,
and destructive actions. Update the README when configuration, API behavior, or user workflows change.
For dependency changes, use pnpm and commit the updated `pnpm-lock.yaml` with `package.json`.

## Validation

Run the core checks before submitting code changes:

```sh
pnpm check
pnpm typecheck
pnpm test:coverage
pnpm build
```

For interface changes, install all three browser engines and run the browser suite. Playwright builds and starts its
own production test server on port 4173:

```sh
pnpm exec playwright install chromium firefox webkit
pnpm test:browser
```

On Linux, Playwright may also require system dependencies via
`pnpm exec playwright install --with-deps chromium firefox webkit`.
For a reproducible Linux environment on another host, run:

```sh
docker build -f tests/browser/Dockerfile -t stiva-browser:test-engines .
docker run --rm --init --ipc=host stiva-browser:test-engines
```

This image contains test browsers and compiler tools and is separate from the production image.

CI also runs the following Docker-backed checks. These require a running Docker daemon:

```sh
node tests/run-postgres.mjs
pnpm test:s3
docker build --tag stiva-browser:1.1.0 .
node tests/container-smoke.mjs
pnpm test:staging
```

The PostgreSQL runner provisions a temporary database and tests persistence and migration. The
container smoke test checks security and persistence using the image built above. Staging measures
concurrent transfers and read latency, exercises monitoring fault injection, and verifies promotion,
rollback and backup restoration with production images. Keep two revisions available in shallow
checkouts (`git fetch --depth=2`) or provide an explicit baseline image.

Some tests are conditional: PostgreSQL tests require `STIVA_TEST_DB_URI` (set by the runner), and live
versioned S3 tests require `STIVA_TEST_VERSIONED_S3`, with optional `STIVA_TEST_ACCESS_KEY` and
`STIVA_TEST_SECRET_KEY`. Use a disposable endpoint for live tests; they create and delete resources.
Mention skipped or unavailable checks in your pull request.

## Pull requests

Open a pull request against `main` and complete the repository's pull request template. Include:
- The problem and the resulting behavior, with a related issue link when available.
- Tests and manual checks performed, including any limitations.
- Screenshots for visible interface changes.
- Any compatibility, configuration, migration, or deployment impact.

Review your diff for accidental secrets and generated files before submitting. Keep discussion
respectful, respond to review feedback, and ensure CI passes before merge.

---

Happy coding! 🖼️
