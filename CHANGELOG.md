# Changelog

## [Unreleased]

## [0.1.1] - 2026-10-29

### Added

- User-friendly environment health card with optional technical details.
- Pre/post-update package compatibility comparison.
- Optional, persisted rollback when an update introduces new dependency conflicts.
- Explicit verified, unverified, and failed recovery states.
- Per-Settings-modal cache that avoids repeated checks while navigating between sections.
- Global, non-dismissible update progress with restart detection and post-restart results.
- Compatibility-aware confirmation text for individual component updates.
- Automated Comfy Registry publishing when the project version changes on `main`.

### Changed

- Show the paired update card only when both Core and Frontend need updates.
- Keep release provenance in the component date labels instead of a redundant footer.

## [0.1.0] - 2026-10-29

### Added

- Native **Updates** Settings panel.
- Independent Core-only, Frontend-only, and recommended paired updates.
- Stable release checks, sourced release dates, update status badges, and compatibility warnings.
- Recovery branch, dependency snapshot, operation log, and automatic rollback.
