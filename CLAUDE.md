# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

A minimal relay connecting Telegram to Claude Code CLI. Messages come in via Telegram, the relay spawns `claude -p`, and sends the response back. It's a reference implementation — a pattern to customize, not a turnkey solution.

## Commands

```bash
# Install dependencies
bun install

# Run the relay
bun run src/relay.ts

# Run with file watching (dev mode)
bun run dev

# Run example scripts standalone
bun run examples/morning-briefing.ts
bun run examples/smart-checkin.ts
```

## Architecture

**Runtime**: Bun (can also run on Node.js 18+)
**Bot framework**: [grammY](https://grammy.dev/) (`grammy` package)
**Core pattern**: Telegram message → `Bun.spawn(["claude", "-p", prompt])` → response back to Telegram

### `src/relay.ts` — The entire relay in one file

The relay is structured in labeled sections:

1. **Configuration** — env vars, directories, session file path
2. **Session Management** — persists `sessionId` to `~/.claude-relay/session.json` for `--resume` support
3. **Lock File** — PID-based lock at `~/.claude-relay/bot.lock` prevents multiple instances
4. **Security Middleware** — grammY middleware that checks `ctx.from.id` against `TELEGRAM_USER_ID`
5. **`callClaude()`** — spawns `claude -p` with optional `--resume`, parses session ID from output
6. **Message Handlers** — text, voice (stub), photo (downloads → passes file path), document (same pattern)
7. **Helpers** — `buildPrompt()` adds time context; `sendResponse()` chunks messages at 4000 chars (Telegram limit is 4096)

### `examples/` — Standalone enhancement patterns

These are not imported by the relay — they're independent scripts showing patterns to integrate:

- **`memory.ts`** — local JSON or Supabase persistence for facts/goals, with intent-detection pattern where Claude manages memory via tags like `[REMEMBER: ...]`
- **`morning-briefing.ts`** — one-shot script sending a daily summary via Telegram API (schedule with cron/launchd)
- **`smart-checkin.ts`** — one-shot script where Claude decides IF and WHAT to proactively message, based on context (goals, time since last message, calendar)
- **`supabase-schema.sql`** — tables for messages, memory, logs with optional pgvector semantic search

### `daemon/` — OS-level process management configs

- `launchagent.plist` — macOS LaunchAgent
- `claude-relay.service` — Linux systemd unit

## Key Design Decisions

- **CLI spawn per message** (not API direct) — gives full Claude Code capabilities: tools, MCP servers, context. Trade-off is ~1-2s overhead per message.
- **Single-file relay** — intentionally monolithic. Users should read and customize `relay.ts`, not configure an abstraction layer.
- **Session continuity via `--resume`** — session ID extracted from Claude output via regex, persisted to JSON file.
- **No test suite** — reference implementation, not a library.

## Environment Variables

Required: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_USER_ID`
Optional: `CLAUDE_PATH` (default: `claude`), `RELAY_DIR` (default: `~/.claude-relay`)
