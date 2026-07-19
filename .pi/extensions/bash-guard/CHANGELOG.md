# Changelog

## [Unreleased]

### Added

- `--bash-guard-disable` flag and `BASH_GUARD_DISABLE` env var to completely disable bash-guard
  (no prompting or blocking) in both main-session and subagent modes. The env var is the
  convenient way to disable it in spawned subagent sessions where flags are harder to pass.
