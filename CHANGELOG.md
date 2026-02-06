# Changelog

## 2026-02-05

#### 22:56

### Added
- 10 Telegram bot commands: `/ping`, `/status`, `/context`, `/sonnet`, `/opus`, `/haiku`, `/reset`, `/system`, `/budget`, `/help`
- Config persistence (`~/.claude-relay/config.json`) for model, system prompt, and budget cap
- Usage stats capture from Claude CLI JSON output — tokens, cost, cache, context window fill
- Telegram command menu via `setMyCommands` — commands appear when tapping `/`
- `--model` flag always passed explicitly to Claude CLI (defaults to sonnet)
- `--append-system-prompt` and `--max-budget-usd` flags driven by persisted config

---

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
