/**
 * Claude Code Telegram Relay
 *
 * Minimal relay that connects Telegram to Claude Code CLI.
 * Customize this for your own needs.
 *
 * Run: bun run src/relay.ts
 */

import { Bot, Context } from "grammy";
import { spawn } from "bun";
import { writeFile, mkdir, readFile, unlink } from "fs/promises";
import { join } from "path";

// ============================================================
// CONFIGURATION
// ============================================================

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const ALLOWED_USER_ID = process.env.TELEGRAM_USER_ID || "";
const CLAUDE_PATH = process.env.CLAUDE_PATH || "claude";
const RELAY_DIR = process.env.RELAY_DIR || join(process.env.HOME || "~", ".claude-relay");

// Directories
const TEMP_DIR = join(RELAY_DIR, "temp");
const UPLOADS_DIR = join(RELAY_DIR, "uploads");

// Session tracking for conversation continuity
const SESSION_FILE = join(RELAY_DIR, "session.json");

interface SessionState {
  sessionId: string | null;
  lastActivity: string;
}

interface RelayConfig {
  model: string;
  systemPrompt: string | null;
  maxBudget: number | null;
}

interface UsageStats {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  totalCostUsd: number;
  numTurns: number;
  contextWindow: number;
  maxOutputTokens: number;
}

const CONFIG_FILE = join(RELAY_DIR, "config.json");
const START_TIME = Date.now();

// ============================================================
// SESSION MANAGEMENT
// ============================================================

async function loadSession(): Promise<SessionState> {
  try {
    const content = await readFile(SESSION_FILE, "utf-8");
    return JSON.parse(content);
  } catch {
    return { sessionId: null, lastActivity: new Date().toISOString() };
  }
}

async function saveSession(state: SessionState): Promise<void> {
  await writeFile(SESSION_FILE, JSON.stringify(state, null, 2));
}

let session = await loadSession();

// ============================================================
// CONFIG MANAGEMENT
// ============================================================

const DEFAULT_CONFIG: RelayConfig = {
  model: "sonnet",
  systemPrompt: null,
  maxBudget: null,
};

async function loadConfig(): Promise<RelayConfig> {
  try {
    const content = await readFile(CONFIG_FILE, "utf-8");
    return { ...DEFAULT_CONFIG, ...JSON.parse(content) };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

async function saveConfig(cfg: RelayConfig): Promise<void> {
  await writeFile(CONFIG_FILE, JSON.stringify(cfg, null, 2));
}

let config = await loadConfig();
let lastUsage: UsageStats | null = null;

// ============================================================
// LOCK FILE (prevent multiple instances)
// ============================================================

const LOCK_FILE = join(RELAY_DIR, "bot.lock");

async function acquireLock(): Promise<boolean> {
  try {
    const existingLock = await readFile(LOCK_FILE, "utf-8").catch(() => null);

    if (existingLock) {
      const pid = parseInt(existingLock);
      try {
        process.kill(pid, 0); // Check if process exists
        console.log(`Another instance running (PID: ${pid})`);
        return false;
      } catch {
        console.log("Stale lock found, taking over...");
      }
    }

    await writeFile(LOCK_FILE, process.pid.toString());
    return true;
  } catch (error) {
    console.error("Lock error:", error);
    return false;
  }
}

async function releaseLock(): Promise<void> {
  await unlink(LOCK_FILE).catch(() => {});
}

// Cleanup on exit
process.on("exit", () => {
  try {
    require("fs").unlinkSync(LOCK_FILE);
  } catch {}
});
process.on("SIGINT", async () => {
  await releaseLock();
  process.exit(0);
});
process.on("SIGTERM", async () => {
  await releaseLock();
  process.exit(0);
});

// ============================================================
// SETUP
// ============================================================

if (!BOT_TOKEN) {
  console.error("TELEGRAM_BOT_TOKEN not set!");
  console.log("\nTo set up:");
  console.log("1. Message @BotFather on Telegram");
  console.log("2. Create a new bot with /newbot");
  console.log("3. Copy the token to .env");
  process.exit(1);
}

// Create directories
await mkdir(TEMP_DIR, { recursive: true });
await mkdir(UPLOADS_DIR, { recursive: true });

// Acquire lock
if (!(await acquireLock())) {
  console.error("Could not acquire lock. Another instance may be running.");
  process.exit(1);
}

const bot = new Bot(BOT_TOKEN);

// ============================================================
// SECURITY: Only respond to authorized user
// ============================================================

bot.use(async (ctx, next) => {
  const userId = ctx.from?.id.toString();

  // If ALLOWED_USER_ID is set, enforce it
  if (ALLOWED_USER_ID && userId !== ALLOWED_USER_ID) {
    console.log(`Unauthorized: ${userId}`);
    await ctx.reply("This bot is private.");
    return;
  }

  await next();
});

// ============================================================
// BOT COMMANDS
// ============================================================

bot.command("ping", async (ctx) => {
  await ctx.reply("Pong.");
});

bot.command("status", async (ctx) => {
  const uptimeMs = Date.now() - START_TIME;
  const uptimeH = Math.floor(uptimeMs / 3_600_000);
  const uptimeM = Math.floor((uptimeMs % 3_600_000) / 60_000);
  const uptime = uptimeH > 0 ? `${uptimeH}h ${uptimeM}m` : `${uptimeM}m`;

  const sessionDisplay = session.sessionId
    ? session.sessionId.substring(0, 12) + "..."
    : "none";

  const lines = [
    "Status",
    "",
    `Model: ${config.model}`,
    `Session: ${sessionDisplay}`,
    `Uptime: ${uptime}`,
    `Last activity: ${session.lastActivity}`,
  ];

  if (config.systemPrompt) {
    const display =
      config.systemPrompt.length > 80
        ? config.systemPrompt.substring(0, 80) + "..."
        : config.systemPrompt;
    lines.push(`System prompt: ${display}`);
  }

  if (config.maxBudget !== null) {
    lines.push(`Budget cap: $${config.maxBudget.toFixed(2)}`);
  }

  await ctx.reply(lines.join("\n"));
});

bot.command("context", async (ctx) => {
  if (!lastUsage) {
    await ctx.reply("No context yet — send a message first.");
    return;
  }

  const u = lastUsage;
  const totalInput = u.inputTokens + u.cacheReadTokens + u.cacheCreationTokens;
  const fillPct =
    u.contextWindow > 0
      ? ((totalInput / u.contextWindow) * 100).toFixed(1)
      : "?";

  const fmt = (n: number) => n.toLocaleString("en-US");

  const lines = [
    "Context (last response)",
    "",
    `Model: ${config.model}`,
    `Tokens: ${fmt(u.inputTokens)} in / ${fmt(u.outputTokens)} out`,
    `Cache: ${fmt(u.cacheReadTokens)} read / ${fmt(u.cacheCreationTokens)} created`,
    `Context window: ${fmt(totalInput)} / ${fmt(u.contextWindow)} (${fillPct}%)`,
    `Cost: $${u.totalCostUsd.toFixed(4)}`,
    `Turns: ${u.numTurns}`,
  ];

  await ctx.reply(lines.join("\n"));
});

bot.command("sonnet", async (ctx) => {
  config.model = "sonnet";
  await saveConfig(config);
  await ctx.reply("Switched to Sonnet.");
});

bot.command("opus", async (ctx) => {
  config.model = "opus";
  await saveConfig(config);
  await ctx.reply("Switched to Opus.");
});

bot.command("haiku", async (ctx) => {
  config.model = "haiku";
  await saveConfig(config);
  await ctx.reply("Switched to Haiku.");
});

bot.command("reset", async (ctx) => {
  session.sessionId = null;
  await saveSession(session);
  await ctx.reply("Session cleared.");
});

bot.command("system", async (ctx) => {
  const text = ctx.match as string;

  if (!text) {
    if (config.systemPrompt) {
      await ctx.reply(`Current system prompt:\n\n${config.systemPrompt}`);
    } else {
      await ctx.reply("No system prompt set. Usage: /system <text> or /system clear");
    }
    return;
  }

  if (text === "clear") {
    config.systemPrompt = null;
    await saveConfig(config);
    await ctx.reply("System prompt cleared.");
    return;
  }

  config.systemPrompt = text;
  await saveConfig(config);
  await ctx.reply(`System prompt set:\n\n${text}`);
});

bot.command("budget", async (ctx) => {
  const text = ctx.match as string;

  if (!text) {
    if (config.maxBudget !== null) {
      await ctx.reply(`Current budget cap: $${config.maxBudget.toFixed(2)}`);
    } else {
      await ctx.reply("No budget cap set. Usage: /budget <amount> or /budget clear");
    }
    return;
  }

  if (text === "clear") {
    config.maxBudget = null;
    await saveConfig(config);
    await ctx.reply("Budget cap removed.");
    return;
  }

  const amount = parseFloat(text);
  if (isNaN(amount) || amount <= 0) {
    await ctx.reply("Invalid amount. Use a positive number, e.g. /budget 0.50");
    return;
  }

  config.maxBudget = amount;
  await saveConfig(config);
  await ctx.reply(`Budget cap set: $${amount.toFixed(2)} per call.`);
});

bot.command("help", async (ctx) => {
  const lines = [
    "Commands",
    "",
    "/ping — Alive check",
    "/status — Model, session, uptime",
    "/context — Token usage & context window",
    "/sonnet — Switch to Sonnet",
    "/opus — Switch to Opus",
    "/haiku — Switch to Haiku",
    "/reset — Start fresh conversation",
    "/system [text] — Set/show/clear system prompt",
    "/budget [amount] — Set/show/clear cost cap",
    "/help — This message",
  ];
  await ctx.reply(lines.join("\n"));
});

// ============================================================
// CORE: Call Claude CLI
// ============================================================

async function callClaude(
  prompt: string,
  options?: { resume?: boolean; imagePath?: string }
): Promise<string> {
  const args = [CLAUDE_PATH, "-p", prompt];

  // Resume previous session if available and requested
  if (options?.resume && session.sessionId) {
    args.push("--resume", session.sessionId);
  }

  args.push("--output-format", "json");

  // Config-driven flags
  args.push("--model", config.model);

  if (config.systemPrompt) {
    args.push("--append-system-prompt", config.systemPrompt);
  }

  if (config.maxBudget !== null) {
    args.push("--max-budget-usd", config.maxBudget.toString());
  }

  console.log(`Calling Claude (${config.model}): ${prompt.substring(0, 50)}...`);

  try {
    const proc = spawn(args, {
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
      },
    });

    const output = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();

    const exitCode = await proc.exited;

    if (exitCode !== 0) {
      console.error("Claude error:", stderr);
      return `Error: ${stderr || "Claude exited with code " + exitCode}`;
    }

    // Parse JSON output to extract response text and session ID
    try {
      const json = JSON.parse(output);

      if (json.session_id) {
        session.sessionId = json.session_id;
        session.lastActivity = new Date().toISOString();
        await saveSession(session);
      }

      // Capture usage stats
      if (json.usage) {
        const modelKeys = json.modelUsage ? Object.keys(json.modelUsage) : [];
        const modelInfo = modelKeys.length > 0 ? json.modelUsage[modelKeys[0]] : {};

        lastUsage = {
          inputTokens: json.usage.input_tokens || 0,
          outputTokens: json.usage.output_tokens || 0,
          cacheReadTokens: json.usage.cache_read_input_tokens || 0,
          cacheCreationTokens: json.usage.cache_creation_input_tokens || 0,
          totalCostUsd: json.total_cost_usd || 0,
          numTurns: json.num_turns || 0,
          contextWindow: modelInfo.contextWindow || 0,
          maxOutputTokens: modelInfo.maxOutputTokens || 0,
        };
      }

      return (json.result || output).trim();
    } catch {
      // Fallback if JSON parsing fails
      return output.trim();
    }
  } catch (error) {
    console.error("Spawn error:", error);
    return `Error: Could not run Claude CLI`;
  }
}

// ============================================================
// MESSAGE HANDLERS
// ============================================================

// Text messages
bot.on("message:text", async (ctx) => {
  const text = ctx.message.text;
  console.log(`Message: ${text.substring(0, 50)}...`);

  await ctx.replyWithChatAction("typing");

  // Add any context you want here
  const enrichedPrompt = buildPrompt(text);

  const response = await callClaude(enrichedPrompt, { resume: true });
  await sendResponse(ctx, response);
});

// Voice messages (optional - requires transcription)
bot.on("message:voice", async (ctx) => {
  console.log("Voice message received");
  await ctx.replyWithChatAction("typing");

  // To handle voice, you need a transcription service
  // Options: Whisper API, Gemini, AssemblyAI, etc.
  //
  // Example flow:
  // 1. Download the voice file
  // 2. Send to transcription service
  // 3. Pass transcription to Claude
  //
  // const transcription = await transcribe(voiceFile);
  // const response = await callClaude(`[Voice]: ${transcription}`);

  await ctx.reply(
    "Voice messages require a transcription service. " +
      "Add Whisper, Gemini, or similar to handle voice."
  );
});

// Photos/Images
bot.on("message:photo", async (ctx) => {
  console.log("Image received");
  await ctx.replyWithChatAction("typing");

  try {
    // Get highest resolution photo
    const photos = ctx.message.photo;
    const photo = photos[photos.length - 1];
    const file = await ctx.api.getFile(photo.file_id);

    // Download the image
    const timestamp = Date.now();
    const filePath = join(UPLOADS_DIR, `image_${timestamp}.jpg`);

    const response = await fetch(
      `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`
    );
    const buffer = await response.arrayBuffer();
    await writeFile(filePath, Buffer.from(buffer));

    // Claude Code can see images via file path
    const caption = ctx.message.caption || "Analyze this image.";
    const prompt = `[Image: ${filePath}]\n\n${caption}`;

    const claudeResponse = await callClaude(prompt, { resume: true });

    // Cleanup after processing
    await unlink(filePath).catch(() => {});

    await sendResponse(ctx, claudeResponse);
  } catch (error) {
    console.error("Image error:", error);
    await ctx.reply("Could not process image.");
  }
});

// Documents
bot.on("message:document", async (ctx) => {
  const doc = ctx.message.document;
  console.log(`Document: ${doc.file_name}`);
  await ctx.replyWithChatAction("typing");

  try {
    const file = await ctx.getFile();
    const timestamp = Date.now();
    const fileName = doc.file_name || `file_${timestamp}`;
    const filePath = join(UPLOADS_DIR, `${timestamp}_${fileName}`);

    const response = await fetch(
      `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`
    );
    const buffer = await response.arrayBuffer();
    await writeFile(filePath, Buffer.from(buffer));

    const caption = ctx.message.caption || `Analyze: ${doc.file_name}`;
    const prompt = `[File: ${filePath}]\n\n${caption}`;

    const claudeResponse = await callClaude(prompt, { resume: true });

    await unlink(filePath).catch(() => {});

    await sendResponse(ctx, claudeResponse);
  } catch (error) {
    console.error("Document error:", error);
    await ctx.reply("Could not process document.");
  }
});

// ============================================================
// HELPERS
// ============================================================

function buildPrompt(userMessage: string): string {
  // Add context to every prompt
  // Customize this for your use case

  const now = new Date();
  const timeStr = now.toLocaleString("en-US", {
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

  return `
You are responding via Telegram. Keep responses concise.

Current time: ${timeStr}

User: ${userMessage}
`.trim();
}

async function sendResponse(ctx: Context, response: string): Promise<void> {
  // Telegram has a 4096 character limit
  const MAX_LENGTH = 4000;

  if (response.length <= MAX_LENGTH) {
    await ctx.reply(response);
    return;
  }

  // Split long responses
  const chunks = [];
  let remaining = response;

  while (remaining.length > 0) {
    if (remaining.length <= MAX_LENGTH) {
      chunks.push(remaining);
      break;
    }

    // Try to split at a natural boundary
    let splitIndex = remaining.lastIndexOf("\n\n", MAX_LENGTH);
    if (splitIndex === -1) splitIndex = remaining.lastIndexOf("\n", MAX_LENGTH);
    if (splitIndex === -1) splitIndex = remaining.lastIndexOf(" ", MAX_LENGTH);
    if (splitIndex === -1) splitIndex = MAX_LENGTH;

    chunks.push(remaining.substring(0, splitIndex));
    remaining = remaining.substring(splitIndex).trim();
  }

  for (const chunk of chunks) {
    await ctx.reply(chunk);
  }
}

// ============================================================
// START
// ============================================================

console.log("Starting Claude Telegram Relay...");
console.log(`Authorized user: ${ALLOWED_USER_ID || "ANY (not recommended)"}`);
console.log(`Model: ${config.model}`);

try {
  await bot.api.setMyCommands([
    { command: "status", description: "Model, session, uptime" },
    { command: "context", description: "Token usage & context window" },
    { command: "sonnet", description: "Switch to Sonnet" },
    { command: "opus", description: "Switch to Opus" },
    { command: "haiku", description: "Switch to Haiku" },
    { command: "reset", description: "Start fresh conversation" },
    { command: "system", description: "Set system prompt" },
    { command: "budget", description: "Set cost cap per call" },
    { command: "ping", description: "Alive check" },
    { command: "help", description: "List commands" },
  ]);
} catch (err) {
  console.error("Failed to set bot commands menu:", err);
}

bot.start({
  onStart: () => {
    console.log("Bot is running!");
  },
});
