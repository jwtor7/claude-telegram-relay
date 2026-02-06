# Changelog

## 2026-02-05

### Added
- LaunchAgent wrapper script pattern for macOS — loads secrets from keychain at runtime
- ASCII logo and shields.io badges to README
- Upstream credit to original author (Goda/godagoo)
- CLAUDE.md project instructions

### Changed
- LaunchAgent plist uses wrapper script instead of static EnvironmentVariables dict
- README personalized with clone URL, session continuity examples, and keychain security note

### Fixed
- Session continuity across Telegram messages — switched `--output-format` from `text` to `json` so `session_id` is captured and `--resume` maintains conversation context
