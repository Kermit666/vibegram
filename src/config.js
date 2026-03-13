import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import dotenv from "dotenv";

dotenv.config();

function requireEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function parseChatIds(rawValue) {
  return new Set(
    rawValue
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  );
}

function parseJsonArray(rawValue, name) {
  if (!rawValue?.trim()) {
    return [];
  }

  let parsed;
  try {
    parsed = JSON.parse(rawValue);
  } catch (error) {
    throw new Error(`${name} must be a JSON array string.`);
  }

  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
    throw new Error(`${name} must be a JSON array of strings.`);
  }

  return parsed;
}

function parsePositiveInt(rawValue, fallback) {
  if (!rawValue?.trim()) {
    return fallback;
  }

  const parsed = Number.parseInt(rawValue, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Expected a positive integer, received "${rawValue}".`);
  }

  return parsed;
}

function parseBoolean(rawValue, fallback) {
  if (!rawValue?.trim()) {
    return fallback;
  }

  const normalized = rawValue.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }

  throw new Error(`Expected a boolean value, received "${rawValue}".`);
}

function parseChoice(rawValue, name, allowedValues, fallback) {
  if (!rawValue?.trim()) {
    return fallback;
  }

  const normalized = rawValue.trim().toLowerCase();
  if (allowedValues.includes(normalized)) {
    return normalized;
  }

  throw new Error(`${name} must be one of: ${allowedValues.join(", ")}.`);
}

function parseOptionalUrl(rawValue, name) {
  if (!rawValue?.trim()) {
    return "";
  }

  let parsed;
  try {
    parsed = new URL(rawValue.trim());
  } catch {
    throw new Error(`${name} must be a valid absolute URL.`);
  }

  if (!/^https?:$/i.test(parsed.protocol)) {
    throw new Error(`${name} must use http or https.`);
  }

  return parsed.toString();
}

function parseOptionalDirectory(rawValue, name) {
  if (!rawValue?.trim()) {
    return "";
  }

  const resolved = path.resolve(rawValue.trim());
  if (fs.existsSync(resolved) && !fs.statSync(resolved).isDirectory()) {
    throw new Error(`${name} must point to a directory path.`);
  }

  return resolved;
}

const telegramToken = requireEnv("TELEGRAM_BOT_TOKEN");
const allowedChatIds = parseChatIds(requireEnv("TELEGRAM_ALLOWED_CHAT_IDS"));
const codexCommand = process.env.CODEX_COMMAND?.trim() || "codex";
const codexExtraArgs = parseJsonArray(process.env.CODEX_EXTRA_ARGS, "CODEX_EXTRA_ARGS");
const voiceToCodexEnabled = parseBoolean(process.env.VOICE_TO_CODEX_ENABLED, true);
const voiceMaxDurationSeconds = parsePositiveInt(process.env.VOICE_MAX_DURATION_SECONDS, 180);
const voiceMaxFileBytes = parsePositiveInt(process.env.VOICE_MAX_FILE_BYTES, 20 * 1024 * 1024);
const voiceTempDir = parseOptionalDirectory(process.env.VOICE_TEMP_DIR, "VOICE_TEMP_DIR");
const ffmpegCommand = process.env.FFMPEG_COMMAND?.trim() || "ffmpeg";
const whisperCommand = process.env.WHISPER_COMMAND?.trim() || "whisper";
const whisperModel = process.env.WHISPER_MODEL?.trim() || "base";
const whisperLanguage = process.env.WHISPER_LANGUAGE?.trim() || "";
const whisperDevice = parseChoice(
  process.env.WHISPER_DEVICE,
  "WHISPER_DEVICE",
  ["auto", "cpu", "cuda"],
  "auto",
);
const whisperTask = parseChoice(
  process.env.WHISPER_TASK,
  "WHISPER_TASK",
  ["transcribe", "translate"],
  "transcribe",
);
const whisperTimeoutMs = parsePositiveInt(process.env.WHISPER_TIMEOUT_MS, 180000);
const whisperFp16 = parseBoolean(process.env.WHISPER_FP16, false);
const configuredWorkdir = process.env.CODEX_WORKDIR?.trim()
  ? path.resolve(process.env.CODEX_WORKDIR)
  : process.cwd();

if (!fs.existsSync(configuredWorkdir) || !fs.statSync(configuredWorkdir).isDirectory()) {
  throw new Error(`CODEX_WORKDIR is not a directory: ${configuredWorkdir}`);
}

export const config = {
  telegramToken,
  allowedChatIds,
  codexCommand,
  codexExtraArgs,
  voiceToCodexEnabled,
  voiceMaxDurationSeconds,
  voiceMaxFileBytes,
  voiceTempDir,
  ffmpegCommand,
  whisperCommand,
  whisperModel,
  whisperLanguage,
  whisperDevice,
  whisperTask,
  whisperTimeoutMs,
  whisperFp16,
  defaultWorkdir: configuredWorkdir,
  outputFlushMs: parsePositiveInt(process.env.OUTPUT_FLUSH_MS, 1200),
  maxBufferedChars: parsePositiveInt(process.env.MAX_BUFFERED_CHARS, 16000),
  repoPathPromptTimeoutMs: parsePositiveInt(process.env.REPO_PATH_PROMPT_TIMEOUT_MS, 120000),
  menuWebAppUrl: parseOptionalUrl(process.env.TELEGRAM_MENU_WEBAPP_URL, "TELEGRAM_MENU_WEBAPP_URL"),
};
