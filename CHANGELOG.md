# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.3.0] - 2026-11-01

### Added

- Add controlled Compose image updates with health checks, a persistent image journal, and recovery to previous images.
- Add Kubernetes updates with explicit context, immutable image digests, readiness checks, and automatic rollout recovery.
- Add desktop update checks, download and restart dialogs, verified in-place macOS updates, and release update feeds for macOS, Windows, and Linux AppImage.
- Add a standalone Electron desktop app with local SQLite storage and a private authenticated backend.
- Build macOS Apple Silicon/Intel, Windows x64, and Linux x64 installers, with desktop smoke tests and release attachments.
- Add light and dark workspace visual checks, browser coverage for upload queues and persistent deletion results, and CI checks for documentation links and desktop dependency vulnerabilities.

### Changed

- Split CI into independent workflow validation, quality, dependency audit, integration, browser and container checks, with a final required aggregate check.
- Cache Docker builds and scan CI and native release images for high and critical vulnerabilities before publication.
- Update AWS SDK, Lucide and Biome dependencies and refresh the project logo.
- Extract workspace navigation, upload scheduling, and folder deletion into dedicated hooks and components.
- Cache bucket listings briefly per server configuration, tighten workspace spacing, and consolidate dark theme surface colors.

### Fixed

- Update the Docker `latest` tag and GitHub latest-release marker only for the highest stable version, preventing older releases from replacing them.
- Limit uploads to four active workers, confirm replacement of existing objects, and reject stale server configurations before contacting storage.
- Keep complete partial-deletion failures available in a dialog until dismissed and retain error notifications until dismissed.
- Reject missing or repeated object pagination tokens and handle missing object size and content type safely in metadata and previews.
- Keep request cancellation scoped to each S3 request without modifying the underlying client, while allowing multipart cleanup after disconnection.
- Preserve website redirects and server-side encryption settings when restoring object versions with a single copy.
- Validate desktop update readiness before stopping the backend, relaunch if the installer fails to start, and stop stalled or interrupted macOS update downloads.

## [1.2.0] - 2026-10-26

### Added

- Add light, dark, and system themes with a persistent preference and live updates when the system theme changes.

### Changed

- Group sidebar buckets by server and switch connections automatically when opening a bucket from another server.

### Fixed

- Preserve the browser's Host header through the Vite development proxy so same-origin API changes are accepted.
- Close the server manager after saving and select the saved server in the workspace.

## [1.1.0] - 2026-10-24

### Added

- Support PostgreSQL configuration storage through `DB_URI`, with migrations and SQLite retained as the default.
- Add recursive folder deletion with a bounded preview, typed confirmation, and partial-failure reporting.
- Browse object versions and delete markers, download historical versions, restore them as new current versions, and permanently delete specific versions with typed confirmation.
- Restore objects larger than 5 GiB with multipart copy while preserving metadata and tags and cleaning up failed copies.
- Add a tag-triggered release workflow that validates the package version, extracts changelog release notes, and runs CI before publishing.
- Build and smoke-test Linux amd64 and arm64 container images on native runners, then publish multi-platform images from the tested digests to Docker Hub and GHCR.

### Fixed

- Preserve raw upload bytes across accepted route variants; settle multipart work and confirm cleanup on failure or cancellation.
- Retain partial deletion results, bound request sizes, and prevent stale credential updates.
- Enforce upstream deadlines, disconnect cancellation, API throttling, and operation concurrency limits.
- Preserve active transfers on bucket refresh; repair mobile focus, contrast, copied S3 URIs, and lazy previews.
- Preserve opaque S3 version markers, including MinIO pagination state, and order delete markers with their history.
- Repair native dialog keyboard containment, accessible inspector tabs, active-navigation contrast, and Safari local HTTP asset loading.
- Apply a shared per-client rate limit to static assets and dashboard fallback routes before filesystem access.

### Changed

- Adopt pnpm with a pinned package-manager version and Biome for linting, formatting, and import checks.
- Extract shared contracts, transfer services, credential encryption, schema migrations, workspace components, file-drop handling, and feature styles.
- Enforce a warning-free lint gate; scan representative UI states with axe across three browser engines.
- Add bounded-label Prometheus metrics, tested alert rules, and an isolated HTTPS staging drill for concurrent transfer performance, cleanup faults, and SQLite/PostgreSQL rollback.
- Add conditional configuration updates, configurable proxy trust and resource limits, coverage gates, and disposable S3 integration fixtures.

## [1.0.0] - 2026-10-23

### Added

- First implementation of Stiva Browser.
