# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- Preserve raw upload bytes across accepted route variants; settle multipart work and confirm cleanup on failure or cancellation.
- Retain partial deletion results, bound request sizes, and prevent stale credential updates.
- Enforce upstream deadlines, disconnect cancellation, API throttling, and operation concurrency limits.
- Preserve active transfers on bucket refresh; repair mobile focus, contrast, copied S3 URIs, and lazy previews.
- Preserve opaque S3 version markers, including MinIO pagination state, and order delete markers with their history.

- Repair native dialog keyboard containment, accessible inspector tabs, active-navigation contrast, and Safari local HTTP asset loading.

### Changed

- Extract shared contracts, transfer services, credential encryption, schema migrations, workspace components, file-drop handling, and feature styles.
- Enforce a warning-free lint gate; scan representative UI states with axe across three browser engines.
- Add bounded-label Prometheus metrics, tested alert rules, and an isolated HTTPS staging drill for concurrent transfer performance, cleanup faults, and SQLite/PostgreSQL rollback.
- Add conditional configuration updates, configurable proxy trust and resource limits, coverage gates, and disposable S3 integration fixtures.

## [1.0.0] - 2026-10-23

### Added

- First implementation of Stiva Browser.
