import { createHash, randomInt } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { Bot, InlineKeyboard, Keyboard } from "grammy";
import { conversations, createConversation } from "@grammyjs/conversations";
import { Menu } from "@grammyjs/menu";
import { config } from "./config.js";
import { createChatStateStore } from "./chatStateStore.js";
import { CodexSession } from "./codexSession.js";
import { SessionHistoryStore } from "./sessionHistory.js";

const bot = new Bot(config.telegramToken);
const session = new CodexSession({
  command: config.codexCommand,
  extraArgs: config.codexExtraArgs,
});

const PROGRESS_TICK_MS = 1000;
const TYPING_ACTION_INTERVAL_MS = 4000;
const PROGRESS_FRAMES = ["loading", "loading.", "loading..", "loading..."];
const subscribers = new Set();
const {
  getChatState,
  getMenuState,
  getPanelMessageState,
  setPanelMessageState,
  clearPanelMessageState,
  pushRecentBotMessageId,
  popRecentBotMessageIds,
} = createChatStateStore();
let defaultWorkdir = config.defaultWorkdir;
let activeRequest = null;
let draftSupport = "unknown";
const PENDING_THREAD_TEXT = "pending (created on first prompt)";
const MAX_THREAD_LABEL_LENGTH = 90;
const MAX_THREAD_PREVIEW_LENGTH = 120;
const PANEL_THREAD_PAGE_SIZE = 6;
const PANEL_REPO_PAGE_SIZE = 7;
const MAX_INLINE_BUTTON_LABEL = 52;
const PANEL_TRANSCRIPT_TURN_LIMIT = 10;
const THREAD_REPLAY_TURN_LIMIT = 10;
const PANEL_CLEANUP_BOT_MESSAGES_LIMIT = 120;
const CLEAR_CHAT_BOT_MESSAGES_LIMIT = 200;
const SYSTEM_NOTICE_AUTODELETE_MS = 15000;
const THREAD_RECORDS_CACHE_TTL_MS = 3000;
const SESSION_SUMMARY_CACHE_MAX_ENTRIES = 512;
const REPO_PICK_TOKEN_PREFIX = "pick:repo:";
const THREAD_PICK_TOKEN_PREFIX = "pick:thread:";
const sessionHistory = new SessionHistoryStore({
  threadRecordsCacheTtlMs: THREAD_RECORDS_CACHE_TTL_MS,
  summaryCacheMaxEntries: SESSION_SUMMARY_CACHE_MAX_ENTRIES,
  maxThreadLabelLength: MAX_THREAD_LABEL_LENGTH,
  maxThreadPreviewLength: MAX_THREAD_PREVIEW_LENGTH,
});
let panelMainMenu = null;
let panelStatusMenu = null;
let panelRepoActionMenu = null;
const PUBLIC_BOT_COMMANDS = [
  { command: "panel", description: "Open interactive control panel" },
  { command: "chatid", description: "Show this chat ID" },
  { command: "help", description: "Show help and commands" },
];
const AUTHORIZED_IDLE_BOT_COMMANDS = [
  { command: "panel", description: "Open interactive control panel" },
  { command: "status", description: "Show Codex session status" },
  { command: "threads", description: "List recent thread IDs" },
  { command: "replay", description: "Replay recent turns from a thread" },
  { command: "clear_chat", description: "Delete recent bot messages" },
  { command: "start_codex", description: "Start a new Codex session" },
  { command: "resume_thread", description: "Resume an existing thread" },
  { command: "menu", description: "Show control keyboard" },
  { command: "hide_menu", description: "Hide control keyboard" },
  { command: "cwd", description: "Show current default directory" },
  { command: "setdir", description: "Set default working directory" },
  { command: "chatid", description: "Show this chat ID" },
  { command: "help", description: "Show help and commands" },
];
const AUTHORIZED_ACTIVE_BOT_COMMANDS = [
  { command: "panel", description: "Open interactive control panel" },
  { command: "status", description: "Show Codex session status" },
  { command: "threads", description: "List recent thread IDs" },
  { command: "replay", description: "Replay recent turns from a thread" },
  { command: "clear_chat", description: "Delete recent bot messages" },
  { command: "restart_codex", description: "Restart Codex session" },
  { command: "stop_codex", description: "Stop current Codex session" },
  { command: "ctrlc", description: "Interrupt the current request" },
  { command: "send", description: "Send a prompt to Codex" },
  { command: "resume_thread", description: "Resume an existing thread" },
  { command: "cwd", description: "Show current default directory" },
  { command: "setdir", description: "Set default working directory" },
  { command: "menu", description: "Show control keyboard" },
  { command: "hide_menu", description: "Hide control keyboard" },
  { command: "chatid", description: "Show this chat ID" },
  { command: "help", description: "Show help and commands" },
];

bot.api.config.use(async (prev, method, payload, signal) => {
  const result = await prev(method, payload, signal);
  if (method === "sendMessage") {
    const chatId = payload?.chat_id;
    const messageId = result?.message_id;
    if ((typeof chatId === "number" || typeof chatId === "string") && Number.isInteger(messageId)) {
      pushRecentBotMessageId(String(chatId), messageId);
    }
  }
  return result;
});

function normalizeFsPath(value) {
  if (typeof value !== "string" || !value.trim()) {
    return "";
  }

  try {
    return path.resolve(value).toLowerCase();
  } catch {
    return value.trim().toLowerCase();
  }
}

function shortPathLabel(value, maxLen = 50) {
  const clean = value.replace(/\s+/g, " ").trim();
  if (clean.length <= maxLen) {
    return clean;
  }

  const tail = clean.slice(-(maxLen - 4));
  return `...${tail}`;
}

function trimBuffer(buffer) {
  if (buffer.length <= config.maxBufferedChars) {
    return buffer;
  }

  return `[output truncated]\n${buffer.slice(-config.maxBufferedChars)}`;
}

function shouldAutoDeleteSystemNotice(text) {
  if (typeof text !== "string" || !text.trim()) {
    return false;
  }

  return text.includes("[codex ready]") || text.includes("[codex session ended]");
}

function scheduleMessageDeletion(chatId, messageId, delayMs = SYSTEM_NOTICE_AUTODELETE_MS) {
  if (!chatId || !messageId) {
    return;
  }

  setTimeout(() => {
    void safeDeleteMessage(chatId, messageId);
  }, delayMs);
}

function scheduleFlush(chatId) {
  const state = getChatState(chatId);
  if (state.timer) {
    return;
  }

  state.timer = setTimeout(() => {
    state.timer = null;
    void flushOutput(chatId);
  }, config.outputFlushMs);
}

async function flushOutput(chatId) {
  const state = getChatState(chatId);
  if (state.isSending || !state.buffer) {
    return;
  }

  const chunk = state.buffer.slice(0, 3500);
  state.buffer = state.buffer.slice(chunk.length);
  state.isSending = true;

  try {
    const sent = await bot.api.sendMessage(chatId, chunk, {
      disable_notification: true,
    });
    if (sent?.message_id && shouldAutoDeleteSystemNotice(chunk)) {
      scheduleMessageDeletion(chatId, sent.message_id);
    }
  } catch (error) {
    console.error(`Failed to deliver output to chat ${chatId}:`, error);
  } finally {
    state.isSending = false;
  }

  if (state.buffer) {
    scheduleFlush(chatId);
  }
}

function queueOutput(text, { partial = false } = {}) {
  if (typeof text !== "string" || text.length === 0) {
    return;
  }

  const normalized = partial ? text : text.trim();
  if (!partial && !normalized) {
    return;
  }

  for (const chatId of subscribers) {
    const state = getChatState(chatId);
    state.buffer = partial
      ? trimBuffer(`${state.buffer}${text}`)
      : trimBuffer(`${state.buffer}${normalized}\n\n`);
    scheduleFlush(chatId);
  }
}

async function callTelegramMethod(method, payload) {
  const response = await fetch(`https://api.telegram.org/bot${config.telegramToken}/${method}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const data = await response.json().catch(() => null);
  if (!response.ok || !data?.ok) {
    const error = new Error(data?.description || `Telegram API ${method} failed with HTTP ${response.status}.`);
    error.status = response.status;
    throw error;
  }

  return data.result;
}

async function updateDraft(chatId, draftId, payload) {
  if (draftSupport === "unsupported") {
    return false;
  }

  try {
    await callTelegramMethod("sendMessageDraft", {
      chat_id: chatId,
      draft_id: draftId,
      ...payload,
    });
    draftSupport = "supported";
    return true;
  } catch (error) {
    const message = String(error?.message ?? "");
    const unsupportedByMethod = error.status === 404 || /not found|method not found/i.test(message);
    const unsupportedByDraftId = error.status === 400 && /RANDOM_ID_INVALID/i.test(message);
    if (unsupportedByMethod || unsupportedByDraftId) {
      draftSupport = "unsupported";
      return false;
    }

    console.error(`Failed to update Telegram draft for chat ${chatId}:`, error);
    return false;
  }
}

async function removeDraft(chatId, draftId) {
  if (draftSupport === "unsupported") {
    return false;
  }

  try {
    return await updateDraft(chatId, draftId, { text: "Done.", remove: true });
  } catch {
    // updateDraft already logs non-capability failures.
    return false;
  }
}

function buildProgressText(startedAt, tick) {
  const elapsedSeconds = Math.max(1, Math.floor((Date.now() - startedAt) / 1000));
  const frame = PROGRESS_FRAMES[tick % PROGRESS_FRAMES.length];

  return [
    `${frame}`,
    `Elapsed: ${elapsedSeconds}s`,
    "Use /ctrlc to stop the current request.",
  ].join("\n");
}

async function startProgressIndicator(chatId) {
  const progress = {
    chatId,
    draftId: randomInt(1, 2_147_483_647),
    startedAt: Date.now(),
    tick: 0,
    timer: null,
    stopped: false,
    lastTypingAt: 0,
    inFlight: Promise.resolve(),
  };

  const pulse = async () => {
    if (progress.stopped) {
      return;
    }

    const text = buildProgressText(progress.startedAt, progress.tick);
    progress.tick += 1;

    progress.inFlight = (async () => {
      const didUpdateDraft = await updateDraft(chatId, progress.draftId, { text });
      if (progress.stopped) {
        return;
      }

      if (!didUpdateDraft) {
        const now = Date.now();
        if (now - progress.lastTypingAt >= TYPING_ACTION_INTERVAL_MS) {
          progress.lastTypingAt = now;
          try {
            await bot.api.sendChatAction(chatId, "typing");
          } catch (error) {
            console.error(`Failed to send typing action to chat ${chatId}:`, error);
          }
        }
      }
    })();
    await progress.inFlight;

    if (progress.stopped) {
      return;
    }

    progress.timer = setTimeout(() => {
      progress.timer = null;
      void pulse();
    }, PROGRESS_TICK_MS);
  };

  await pulse();
  return progress;
}

async function stopProgressIndicator(progress) {
  if (!progress) {
    return;
  }

  progress.stopped = true;
  if (progress.timer) {
    clearTimeout(progress.timer);
    progress.timer = null;
  }

  await progress.inFlight.catch(() => {});
  const removed = await removeDraft(progress.chatId, progress.draftId);
  if (!removed && draftSupport !== "unsupported") {
    await new Promise((resolve) => setTimeout(resolve, 250));
    await removeDraft(progress.chatId, progress.draftId);
  }
}

function parseCommandArg(text) {
  const firstSpace = text.indexOf(" ");
  if (firstSpace === -1) {
    return "";
  }

  return text.slice(firstSpace + 1).trim();
}

function buildControlKeyboard() {
  return new Keyboard()
    .text("/panel")
    .text("/status")
    .row()
    .text("/threads")
    .text("/replay 10")
    .row()
    .text("/clear_chat")
    .text("/menu")
    .row()
    .text("/start_codex")
    .text("/stop_codex")
    .row()
    .text("/resume_thread")
    .text("/restart_codex")
    .row()
    .text("/cwd")
    .text("/ctrlc")
    .row()
    .text("/help")
    .text("/hide_menu")
    .resized()
    .persistent();
}

function currentSessionState() {
  if (!session.isRunning) {
    return "stopped";
  }

  return session.isBusy ? "busy" : "ready";
}

function compactThreadId(threadId, head = 8, tail = 4) {
  if (!threadId) {
    return "none";
  }

  const clean = String(threadId).trim();
  if (clean.length <= head + tail + 3) {
    return clean;
  }

  return `${clean.slice(0, head)}...${clean.slice(-tail)}`;
}

function repoNameFromPath(repoPath) {
  if (typeof repoPath !== "string" || !repoPath.trim()) {
    return "Unknown";
  }

  const trimmed = repoPath.trim().replace(/[\\/]+$/, "");
  const basename = path.basename(trimmed);
  return basename || shortPathLabel(repoPath, 28);
}

function trimInlineLabel(value, maxLen = MAX_INLINE_BUTTON_LABEL) {
  const singleLine = String(value ?? "").replace(/\s+/g, " ").trim();
  if (singleLine.length <= maxLen) {
    return singleLine;
  }

  return `${singleLine.slice(0, maxLen - 3)}...`;
}

function shortStableToken(value, length = 12) {
  const digest = createHash("sha1")
    .update(String(value ?? ""))
    .digest("base64url");
  return digest.slice(0, Math.max(6, length));
}

function buildRepoTokenMappings(repos) {
  const tokenToPath = new Map();
  const pathToToken = new Map();

  for (const repo of repos) {
    const rawPath = String(repo?.path ?? "");
    if (!rawPath) {
      continue;
    }

    const normalized = normalizeFsPath(rawPath) || rawPath.toLowerCase();
    const baseToken = shortStableToken(normalized, 12);
    let token = baseToken;
    let suffix = 1;
    while (tokenToPath.has(token) && tokenToPath.get(token) !== rawPath) {
      suffix += 1;
      token = `${baseToken}-${suffix}`;
    }

    tokenToPath.set(token, rawPath);
    pathToToken.set(rawPath, token);
  }

  return {
    tokenToPath,
    pathToToken,
  };
}

function buildBreadcrumb(parts) {
  return parts.filter(Boolean).join(" > ");
}

function paginateItems(items, page, pageSize) {
  const list = Array.isArray(items) ? items : [];
  const size = Math.max(1, pageSize);
  const total = list.length;
  const totalPages = Math.max(1, Math.ceil(total / size));
  const safePage = Math.max(0, Math.min(page, totalPages - 1));
  const start = safePage * size;
  const pageItems = list.slice(start, start + size);
  const end = start + pageItems.length;

  return {
    total,
    totalPages,
    page: safePage,
    start,
    end,
    pageItems,
  };
}

function appendPaginationRow(keyboard, listType, pageInfo) {
  if (!pageInfo || pageInfo.totalPages <= 1) {
    return;
  }

  if (pageInfo.page > 0) {
    keyboard.text("Prev", `page:${listType}:${pageInfo.page - 1}`);
  }
  if (pageInfo.page < pageInfo.totalPages - 1) {
    keyboard.text("Next", `page:${listType}:${pageInfo.page + 1}`);
  }
  keyboard.row();
}

function panelHeaderLines(breadcrumb) {
  const status = currentSessionState();
  const activeThread = session.threadId
    ? compactThreadId(session.threadId)
    : (session.isRunning ? "pending" : "none");

  return [
    "Codex Control Center",
    breadcrumb,
    "",
    `Session: ${status}`,
    `Active thread: ${activeThread}`,
    `Default repo: ${shortPathLabel(defaultWorkdir, 72)}`,
  ];
}

function buildPanelMainKeyboard() {
  if (panelMainMenu) {
    return panelMainMenu;
  }

  return new InlineKeyboard()
    .text("Session", "panel:status")
    .text("Conversations", "panel:switch")
    .row()
    .text("New Chat", "panel:new")
    .text("Repositories", "panel:repos")
    .row()
    .text("Set Repo Path", "panel:setpath")
    .text("List Threads", "panel:threads");
}

function buildThreadPickerKeyboard(threads, { page = 0, backAction = "panel:main" } = {}) {
  const pageInfo = paginateItems(threads, page, PANEL_THREAD_PAGE_SIZE);
  const keyboard = new InlineKeyboard();
  for (let i = 0; i < pageInfo.pageItems.length; i += 1) {
    const thread = pageInfo.pageItems[i];
    const globalIndex = pageInfo.start + i;
    const repoPrefix = thread.repoName ? `[${thread.repoName}] ` : "";
    const buttonLabel = trimInlineLabel(`${globalIndex + 1}. ${repoPrefix}${thread.label}`);
    if (!thread.threadId) {
      continue;
    }
    keyboard.text(buttonLabel, `${THREAD_PICK_TOKEN_PREFIX}${thread.threadId}`).row();
  }

  appendPaginationRow(keyboard, "threads", pageInfo);
  keyboard.text("Back", backAction).text("Home", "panel:main");
  return {
    keyboard,
    pageInfo,
  };
}

function buildRepoPickerKeyboard(state, repos, { page = 0 } = {}) {
  const pageInfo = paginateItems(repos, page, PANEL_REPO_PAGE_SIZE);
  const { tokenToPath, pathToToken } = buildRepoTokenMappings(repos);
  state.repoTokenToPath = tokenToPath;
  const keyboard = new InlineKeyboard();
  for (let i = 0; i < pageInfo.pageItems.length; i += 1) {
    const repo = pageInfo.pageItems[i];
    const globalIndex = pageInfo.start + i;
    const buttonLabel = trimInlineLabel(`${globalIndex + 1}. ${repo.name}`);
    const token = pathToToken.get(repo.path);
    if (!token) {
      continue;
    }
    keyboard.text(buttonLabel, `${REPO_PICK_TOKEN_PREFIX}${token}`).row();
  }

  appendPaginationRow(keyboard, "repos", pageInfo);
  keyboard.text("Back", "panel:main").text("Set Path", "panel:setpath");
  return {
    keyboard,
    pageInfo,
  };
}

function buildRepoActionKeyboard() {
  if (panelRepoActionMenu) {
    return panelRepoActionMenu;
  }

  return new InlineKeyboard()
    .text("Start New Chat", "repo:action:new")
    .row()
    .text("Browse Conversations", "repo:action:switch")
    .row()
    .text("Set Default Repo", "repo:action:set")
    .row()
    .text("Back to Repos", "panel:repos")
    .text("Home", "panel:main");
}

function buildPanelNavKeyboard() {
  return new InlineKeyboard()
    .text("Home", "panel:main")
    .text("Conversations", "panel:switch")
    .row()
    .text("Repositories", "panel:repos")
    .text("Session", "panel:status");
}

function buildStatusKeyboard() {
  if (panelStatusMenu) {
    return panelStatusMenu;
  }

  return new InlineKeyboard()
    .text("Refresh", "panel:status")
    .text("Home", "panel:main")
    .row()
    .text("Conversations", "panel:switch")
    .text("Repositories", "panel:repos");
}

async function showPanelMessage(ctx, text, replyMarkup) {
  const chatId = ctx.chat?.id;
  if (!chatId) {
    return;
  }

  const chatKey = String(chatId);
  const knownPanel = getPanelMessageState(chatKey);
  const callbackMessageId = ctx.callbackQuery?.message?.message_id;
  const preferredMessageId = knownPanel?.messageId ?? null;
  let activePanelMessageId = preferredMessageId;
  if (preferredMessageId) {
    try {
      await bot.api.editMessageText(chatId, preferredMessageId, text, {
        reply_markup: replyMarkup,
      });
      setPanelMessageState(chatKey, preferredMessageId);
      if (callbackMessageId && callbackMessageId !== preferredMessageId) {
        await safeDeleteMessage(chatId, callbackMessageId);
      }
      return;
    } catch (error) {
      const description = String(error?.description ?? error?.message ?? "");
      if (/message is not modified/i.test(description)) {
        if (callbackMessageId && callbackMessageId !== preferredMessageId) {
          await safeDeleteMessage(chatId, callbackMessageId);
        }
        return;
      }
      // Fall back to sending a replacement panel message.
    }
  }

  const sent = await ctx.reply(text, {
    reply_markup: replyMarkup,
  });
  if (sent?.message_id) {
    setPanelMessageState(chatKey, sent.message_id);
    activePanelMessageId = sent.message_id;
  }

  if (callbackMessageId && callbackMessageId !== activePanelMessageId) {
    await safeDeleteMessage(chatId, callbackMessageId);
  }
}

function firstContentTextForTranscript(parts) {
  if (!Array.isArray(parts)) {
    return "";
  }

  for (const part of parts) {
    if (!part || typeof part !== "object") {
      continue;
    }

    if (typeof part.text === "string" && part.text.trim()) {
      return part.text;
    }
  }

  return "";
}

function looksLikeTranscriptBoilerplate(text) {
  if (!text || !text.trim()) {
    return true;
  }

  return [
    /^#\s*AGENTS\.md instructions/i,
    /^<environment_context>/i,
    /^<INSTRUCTIONS>/i,
    /^<collaboration_mode>/i,
    /^##\s*Skills/i,
    /^###\s*Available skills/i,
    /^###\s*How to use skills/i,
  ].some((pattern) => pattern.test(text.trim()));
}

function getThreadTranscriptTurns(filePath, limit = PANEL_TRANSCRIPT_TURN_LIMIT) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch {
    return [];
  }

  const turns = [];
  const lines = raw.split(/\r?\n/);
  for (const line of lines) {
    if (!line.trim()) {
      continue;
    }

    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }

    if (parsed.type !== "response_item" || parsed.payload?.type !== "message") {
      continue;
    }

    const role = parsed.payload?.role;
    if (role !== "user" && role !== "assistant") {
      continue;
    }

    const text = firstContentTextForTranscript(parsed.payload?.content);
    if (!text) {
      continue;
    }

    const firstLine = text.split(/\r?\n/).find((segment) => segment.trim()) || text;
    const normalizedLine = firstLine.replace(/\s+/g, " ").trim();
    if (!normalizedLine) {
      continue;
    }

    if (role === "user" && looksLikeTranscriptBoilerplate(normalizedLine)) {
      continue;
    }

    turns.push({
      role,
      text: summarizePreview(normalizedLine),
    });
  }

  return turns.slice(-Math.max(1, limit));
}

function getTranscriptTurnsForThreadId(threadId, limit = PANEL_TRANSCRIPT_TURN_LIMIT) {
  if (!threadId) {
    return [];
  }

  const thread = sessionHistory.findThreadById(threadId);
  if (!thread?.filePath) {
    return [];
  }

  return getThreadTranscriptTurns(thread.filePath, limit);
}

function transcriptPreviewForThreadId(threadId, { heading = "Recent conversation:" } = {}) {
  const turns = getTranscriptTurnsForThreadId(threadId, PANEL_TRANSCRIPT_TURN_LIMIT);
  if (turns.length === 0) {
    return "";
  }

  const lines = ["", heading];
  for (const turn of turns) {
    const speaker = turn.role === "assistant" ? "codex" : "you";
    lines.push(`${speaker}: ${turn.text}`);
  }
  return lines.join("\n");
}

async function sendTranscriptReplay(ctx, threadId, { limit = THREAD_REPLAY_TURN_LIMIT } = {}) {
  const turns = getTranscriptTurnsForThreadId(threadId, limit);
  if (turns.length === 0) {
    return 0;
  }

  await ctx.reply(`Loaded context (last ${turns.length} turns):`);
  for (const turn of turns) {
    const speaker = turn.role === "assistant" ? "codex" : "you";
    await ctx.reply(`${speaker}: ${turn.text}`);
  }
  return turns.length;
}

function activeThreadTranscriptPreview() {
  return transcriptPreviewForThreadId(session.threadId, { heading: "Recent conversation:" });
}

function panelMainText() {
  const transcript = activeThreadTranscriptPreview();
  return [
    ...panelHeaderLines("Home"),
    "",
    "Use the buttons to switch conversations and repos quickly.",
    transcript,
  ].join("\n");
}

async function safeDeleteMessage(chatId, messageId) {
  if (!chatId || !messageId) {
    return;
  }

  try {
    await bot.api.deleteMessage(chatId, messageId);
  } catch {
    // Ignore cleanup failures.
  }
}

async function cleanupRecentBotOutputForPanel(chatId) {
  const ids = popRecentBotMessageIds(chatId, PANEL_CLEANUP_BOT_MESSAGES_LIMIT);
  for (let i = ids.length - 1; i >= 0; i -= 1) {
    await safeDeleteMessage(chatId, ids[i]);
  }
}

function clearPendingOutputForChat(chatId) {
  const state = getChatState(chatId);
  state.buffer = "";
  state.isSending = false;
  if (state.timer) {
    clearTimeout(state.timer);
    state.timer = null;
  }
}

async function clearChatArtifacts(chatId, { deletePanel = true, botMessageLimit = CLEAR_CHAT_BOT_MESSAGES_LIMIT } = {}) {
  if (!chatId) {
    return 0;
  }

  clearPendingOutputForChat(chatId);

  let deleted = 0;
  if (deletePanel) {
    const knownPanel = getPanelMessageState(chatId);
    if (knownPanel?.messageId) {
      await safeDeleteMessage(chatId, knownPanel.messageId);
      clearPanelMessageState(chatId);
      deleted += 1;
    }
  }

  const rawIds = popRecentBotMessageIds(chatId, botMessageLimit);
  const uniqueIds = [...new Set(rawIds)];
  for (let i = uniqueIds.length - 1; i >= 0; i -= 1) {
    await safeDeleteMessage(chatId, uniqueIds[i]);
    deleted += 1;
  }

  return deleted;
}

function resolveReplayThreadForCurrentContext() {
  if (session.threadId) {
    return {
      threadId: session.threadId,
      source: "active session",
    };
  }

  const recentThreads = getRecentThreadIds(80);
  if (recentThreads.length === 0) {
    return null;
  }

  const preferredWorkdir = session.workdir ?? defaultWorkdir;
  const normalizedPreferred = normalizeFsPath(preferredWorkdir);
  if (normalizedPreferred) {
    const matchingRepoThread = recentThreads.find((thread) => normalizeFsPath(thread.cwd) === normalizedPreferred);
    if (matchingRepoThread?.threadId) {
      return {
        threadId: matchingRepoThread.threadId,
        source: `latest thread in ${preferredWorkdir}`,
      };
    }
  }

  return {
    threadId: recentThreads[0].threadId,
    source: "latest local thread",
  };
}

async function openPanelHome(ctx, { cleanup = false } = {}) {
  const chatId = ctx.chat?.id;
  if (!chatId) {
    return;
  }

  if (cleanup) {
    const knownPanel = getPanelMessageState(chatId);
    if (knownPanel?.messageId) {
      await safeDeleteMessage(chatId, knownPanel.messageId);
      clearPanelMessageState(chatId);
    }
    await cleanupRecentBotOutputForPanel(chatId);
    if (ctx.msg?.message_id) {
      await safeDeleteMessage(chatId, ctx.msg.message_id);
    }
  }

  await showPanelMessage(ctx, panelMainText(), buildPanelMainKeyboard());
}

function panelStatusText() {
  return [
    ...panelHeaderLines(buildBreadcrumb(["Home", "Session"])),
    `PID: ${session.pid ?? "n/a"}`,
    `Workdir: ${session.workdir ?? defaultWorkdir}`,
    `Authorized chats subscribed: ${subscribers.size}`,
  ].join("\n");
}

function panelRepoContextText(repoPath) {
  const normalizedSelected = normalizeFsPath(repoPath);
  const isDefault = normalizedSelected === normalizeFsPath(defaultWorkdir);

  return [
    ...panelHeaderLines(buildBreadcrumb(["Home", "Repositories", repoNameFromPath(repoPath)])),
    "",
    `Selected repo: ${repoNameFromPath(repoPath)}`,
    `Path: ${repoPath}`,
    `Default: ${isDefault ? "yes" : "no"}`,
    "",
    "Choose what to do next:",
  ].join("\n");
}

function panelThreadsText(threads, { filteredByPath = null, pageInfo = null } = {}) {
  const effectivePage = pageInfo ?? paginateItems(threads, 0, PANEL_THREAD_PAGE_SIZE);
  const breadcrumb = filteredByPath
    ? buildBreadcrumb(["Home", "Repositories", repoNameFromPath(filteredByPath), "Conversations"])
    : buildBreadcrumb(["Home", "Conversations"]);

  const lines = [];
  lines.push(...panelHeaderLines(breadcrumb));
  if (effectivePage.total === 0) {
    lines.push("Showing 0 of 0");
  } else {
    lines.push(
      `Showing ${effectivePage.start + 1}-${effectivePage.end} of ${effectivePage.total} (page ${effectivePage.page + 1}/${effectivePage.totalPages})`,
    );
  }
  if (filteredByPath && filteredByPath.trim()) {
    lines.push(`Repo path: ${shortPathLabel(filteredByPath, 72)}`);
  }
  lines.push("");

  if (effectivePage.total === 0) {
    lines.push("No conversations found.");
    return lines.join("\n");
  }

  for (let i = 0; i < effectivePage.pageItems.length; i += 1) {
    const thread = effectivePage.pageItems[i];
    const index = effectivePage.start + i + 1;
    const repoPrefix = thread.repoName ? `[${thread.repoName}] ` : "";
    lines.push(`${index}. ${summarizeLabel(`${repoPrefix}${thread.label}`)} (${thread.when})`);
    if (thread.latestMessage) {
      const roleTag = thread.latestRole === "assistant"
        ? "assistant"
        : (thread.latestRole === "user" ? "you" : "latest");
      lines.push(`   ${roleTag}: ${summarizePreview(thread.latestMessage)}`);
    }
  }

  return lines.join("\n");
}

function panelReposText(repos, { pageInfo = null } = {}) {
  const effectivePage = pageInfo ?? paginateItems(repos, 0, PANEL_REPO_PAGE_SIZE);
  const lines = [...panelHeaderLines(buildBreadcrumb(["Home", "Repositories"]))];
  if (effectivePage.total === 0) {
    lines.push("Showing 0 of 0");
  } else {
    lines.push(
      `Showing ${effectivePage.start + 1}-${effectivePage.end} of ${effectivePage.total} (page ${effectivePage.page + 1}/${effectivePage.totalPages})`,
    );
  }
  lines.push("");

  if (effectivePage.total === 0) {
    lines.push("No repositories found in local Codex history.");
    return lines.join("\n");
  }

  const normalizedDefault = normalizeFsPath(defaultWorkdir);
  for (let i = 0; i < effectivePage.pageItems.length; i += 1) {
    const repo = effectivePage.pageItems[i];
    const index = effectivePage.start + i + 1;
    const isDefault = normalizeFsPath(repo.path) === normalizedDefault;
    const defaultTag = isDefault ? " [default]" : "";
    lines.push(`${index}. ${repo.name}${defaultTag} (${repo.when})`);
    lines.push(`   ${shortPathLabel(repo.path, 70)}`);
  }

  return lines.join("\n");
}

function summarizeLabel(text) {
  const singleLine = text.replace(/\s+/g, " ").trim();
  if (singleLine.length <= MAX_THREAD_LABEL_LENGTH) {
    return singleLine;
  }

  return `${singleLine.slice(0, MAX_THREAD_LABEL_LENGTH - 1)}...`;
}

function summarizePreview(text) {
  const singleLine = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!singleLine) {
    return "";
  }

  if (singleLine.length <= MAX_THREAD_PREVIEW_LENGTH) {
    return singleLine;
  }

  return `${singleLine.slice(0, MAX_THREAD_PREVIEW_LENGTH - 3)}...`;
}

function getRecentThreadIds(limit = 10) {
  return sessionHistory.getRecentThreadIds(limit);
}

function getRecentRepos(limit = 12) {
  return sessionHistory.getRecentRepos(defaultWorkdir, limit);
}

function parseThreadAndOptionalPath(rawInput) {
  const trimmed = rawInput.trim();
  if (!trimmed) {
    return null;
  }

  const firstSpace = trimmed.indexOf(" ");
  if (firstSpace === -1) {
    const threadIdOnly = stripWrappingQuotes(trimmed);
    if (!threadIdOnly) {
      return null;
    }

    return {
      threadId: threadIdOnly,
      pathArg: "",
    };
  }

  const threadId = stripWrappingQuotes(trimmed.slice(0, firstSpace).trim());
  const pathArg = trimmed.slice(firstSpace + 1).trim();

  if (!threadId) {
    return null;
  }

  return {
    threadId,
    pathArg,
  };
}

function stripWrappingQuotes(value) {
  if (
    (value.startsWith("\"") && value.endsWith("\"")) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }

  return value;
}

function resolveWorkdir(rawInput) {
  const trimmed = stripWrappingQuotes(rawInput.trim());
  if (!trimmed) {
    return defaultWorkdir;
  }

  if (trimmed.startsWith("~")) {
    const relativeToHome = trimmed.replace(/^~[\\/]?/, "");
    return path.resolve(os.homedir(), relativeToHome);
  }

  if (path.isAbsolute(trimmed)) {
    return path.resolve(trimmed);
  }

  return path.resolve(defaultWorkdir, trimmed);
}

function ensureDirectory(candidatePath) {
  if (!candidatePath) {
    throw new Error("A directory path is required.");
  }

  if (!fs.existsSync(candidatePath) || !fs.statSync(candidatePath).isDirectory()) {
    throw new Error(`Directory does not exist: ${candidatePath}`);
  }

  return candidatePath;
}

function sessionStatusText() {
  const status = session.isRunning
    ? (session.isBusy ? "busy" : "ready")
    : "stopped";
  const threadText = session.threadId ?? (session.isRunning ? PENDING_THREAD_TEXT : "n/a");

  return [
    `Codex session: ${status}`,
    `PID: ${session.pid ?? "n/a"}`,
    `Thread ID: ${threadText}`,
    `Workdir: ${session.workdir ?? defaultWorkdir}`,
    `Authorized chats subscribed: ${subscribers.size}`,
  ].join("\n");
}

function helpText() {
  return [
    "Commands:",
    "/panel - open interactive control panel",
    "/clear_chat - delete recent bot output and panel messages",
    "/menu - show control keyboard",
    "/hide_menu - hide control keyboard",
    "/chatid - show the current Telegram chat ID",
    "/threads [n] - list recent local Codex thread IDs",
    "/replay [n] - replay recent turns from active/latest thread (default 10)",
    "/start_codex [path] - start a Codex session",
    "/resume_thread <thread_id> [path] - attach session to an existing Codex thread",
    "/stop_codex - stop the current session",
    "/restart_codex [path] - restart the session, optionally in another directory",
    "/status - show session status",
    "/cwd - show the current default working directory",
    "/setdir <path> - change the default working directory",
    "/send <text> - send a prompt to Codex",
    "/ctrlc - interrupt the current Codex request",
    "",
    "Any non-command text message is forwarded directly to the active Codex session.",
  ].join("\n");
}

function currentChatIdText(ctx) {
  return `Current chat ID: ${ctx.chat?.id ?? "unknown"}`;
}

function isAuthorizedChat(ctx) {
  const chatId = ctx.chat?.id;
  return chatId !== undefined && config.allowedChatIds.has(String(chatId));
}

async function forwardPrompt(ctx, promptText) {
  if (!session.isRunning) {
    await ctx.reply("Codex is not running. Use /start_codex first.");
    return;
  }

  if (session.isBusy) {
    await ctx.reply("Codex is busy. Wait for the current request to finish or use /ctrlc.");
    return;
  }

  const chatId = String(ctx.chat.id);
  const progress = await startProgressIndicator(chatId);
  activeRequest = {
    chatId,
    progress,
  };

  void session.send(promptText)
    .catch((error) => {
      if (error.message !== "Codex request interrupted.") {
        console.error("Codex request failed:", error);
      }
    })
    .finally(async () => {
      await stopProgressIndicator(progress);
      invalidateThreadHistoryCache();
      if (activeRequest?.progress === progress) {
        activeRequest = null;
      }
    });
}

async function startFreshSession(workdir) {
  const target = ensureDirectory(workdir);
  if (session.isRunning) {
    await session.stopAndWait();
  }
  await session.start(target);
  return target;
}

async function resumeExistingThread(threadId, workdir) {
  const target = ensureDirectory(workdir);
  if (session.isRunning) {
    await session.stopAndWait();
  }
  await session.start(target, { threadId });
  return target;
}

function invalidateThreadHistoryCache() {
  sessionHistory.invalidate();
}

function syncActiveRepoForChat(chatId, workdir, { clearThreadFilter = true } = {}) {
  if (chatId === undefined || chatId === null) {
    return;
  }

  const targetWorkdir = ensureDirectory(workdir);
  const state = getMenuState(chatId);
  state.selectedRepoPath = targetWorkdir;
  if (clearThreadFilter) {
    state.threadFilterRepoPath = null;
  }
}

function syncActiveConversationContext(chatId, workdir, { clearThreadFilter = true } = {}) {
  const targetWorkdir = ensureDirectory(workdir);
  defaultWorkdir = targetWorkdir;
  syncActiveRepoForChat(chatId, targetWorkdir, { clearThreadFilter });
  invalidateThreadHistoryCache();
  return targetWorkdir;
}

function resolveThreadResumeWorkdir(thread, state) {
  const candidates = [
    { source: "thread metadata", value: thread?.cwd },
    { source: "repo-scoped list", value: state?.threadFilterRepoPath },
    { source: "selected repo", value: state?.selectedRepoPath },
  ];

  for (const candidate of candidates) {
    const raw = typeof candidate.value === "string" ? candidate.value.trim() : "";
    if (!raw) {
      continue;
    }

    try {
      const resolved = ensureDirectory(raw);
      return {
        workdir: resolved,
        source: candidate.source,
      };
    } catch {
      continue;
    }
  }

  return null;
}

async function setRepoPathConversation(conversation, ctx) {
  const chatId = ctx.chat?.id;
  if (!chatId) {
    return;
  }

  await showPanelMessage(
    ctx,
    [
      ...panelHeaderLines(buildBreadcrumb(["Home", "Repositories", "Custom Path"])),
      "",
      "Send the repo path in your next message.",
      "Example: C:\\Users\\lucas\\Desktop\\project",
      "Example: .\\another-project",
      "",
      "Type cancel to abort.",
    ].join("\n"),
    new InlineKeyboard()
      .text("Back", "panel:repos")
      .text("Home", "panel:main"),
  );

  while (true) {
    const incoming = await conversation.waitFor("message:text", {
      otherwise: async (otherwiseCtx) => {
        await otherwiseCtx.reply("Send a text path, or type cancel.");
      },
    });
    const text = incoming.msg.text.trim();

    if (!text) {
      continue;
    }

    if (/^cancel$/i.test(text)) {
      await showPanelMessage(
        incoming,
        "Repo path selection cancelled.",
        buildPanelNavKeyboard(),
      );
      return;
    }

    try {
      const resolved = ensureDirectory(resolveWorkdir(text));
      const state = getMenuState(chatId);
      state.selectedRepoPath = resolved;
      state.threadFilterRepoPath = null;
      await showPanelMessage(
        incoming,
        panelRepoContextText(resolved),
        buildRepoActionKeyboard(),
      );
      return;
    } catch (error) {
      await incoming.reply(
        [
          `Invalid repo path: ${error.message}`,
          "Send another path, or type cancel.",
        ].join("\n"),
      );
    }
  }
}

async function enterSetRepoPathConversation(ctx) {
  const conversationId = "setRepoPathConversation";
  if (ctx.conversation.active(conversationId) > 0) {
    await ctx.conversation.exit(conversationId).catch(() => {});
  }
  await ctx.conversation.enter(conversationId);
}

async function renderThreadsPanel(ctx, state, { page = 0 } = {}) {
  if (!Array.isArray(state.threadChoices) || state.threadChoices.length === 0) {
    state.threadById = new Map();
    await showPanelMessage(ctx, "No local Codex threads found.", buildPanelNavKeyboard());
    return;
  }

  state.threadById = new Map(
    state.threadChoices
      .filter((thread) => thread?.threadId)
      .map((thread) => [thread.threadId, thread]),
  );
  const { keyboard, pageInfo } = buildThreadPickerKeyboard(state.threadChoices, {
    page,
    backAction: state.threadBackAction || "panel:main",
  });
  state.threadPage = pageInfo.page;
  await showPanelMessage(
    ctx,
    panelThreadsText(state.threadChoices, {
      filteredByPath: state.threadFilterRepoPath,
      pageInfo,
    }),
    keyboard,
  );
}

async function renderReposPanel(ctx, state, { page = 0 } = {}) {
  if (!Array.isArray(state.repoChoices) || state.repoChoices.length === 0) {
    state.repoTokenToPath = new Map();
    await showPanelMessage(ctx, "No repos found in local Codex history.", buildPanelNavKeyboard());
    return;
  }

  const { keyboard, pageInfo } = buildRepoPickerKeyboard(state, state.repoChoices, { page });
  state.repoPage = pageInfo.page;
  await showPanelMessage(
    ctx,
    panelReposText(state.repoChoices, { pageInfo }),
    keyboard,
  );
}

function createPanelMenus() {
  if (panelMainMenu && panelStatusMenu && panelRepoActionMenu) {
    return;
  }

  const outdatedMessage = "Panel changed. I refreshed it, please tap again.";
  panelMainMenu = new Menu("panel-main", {
    onMenuOutdated: outdatedMessage,
  })
    .text("Session", async (ctx) => {
      await showPanelMessage(ctx, panelStatusText(), buildStatusKeyboard());
    })
    .text("Conversations", async (ctx) => {
      const chatId = String(ctx.chat.id);
      const state = getMenuState(chatId);
      state.threadChoices = getRecentThreadIds(60);
      state.threadPage = 0;
      state.threadBackAction = "panel:main";
      state.threadFilterRepoPath = null;
      await renderThreadsPanel(ctx, state, { page: 0 });
    })
    .row()
    .text("New Chat", async (ctx) => {
      const chatId = String(ctx.chat.id);
      const target = await startFreshSession(defaultWorkdir);
      syncActiveConversationContext(chatId, target);
      await showPanelMessage(
        ctx,
        [
          "Started new conversation.",
          `Workdir: ${target}`,
          `Thread ID: ${PENDING_THREAD_TEXT}`,
        ].join("\n"),
        buildPanelNavKeyboard(),
      );
    })
    .text("Repositories", async (ctx) => {
      const chatId = String(ctx.chat.id);
      const state = getMenuState(chatId);
      state.repoChoices = getRecentRepos(60);
      state.repoPage = 0;
      await renderReposPanel(ctx, state, { page: 0 });
    })
    .row()
    .text("Set Repo Path", async (ctx) => {
      await enterSetRepoPathConversation(ctx);
    })
    .text("List Threads", async (ctx) => {
      const chatId = String(ctx.chat.id);
      const state = getMenuState(chatId);
      state.threadChoices = getRecentThreadIds(60);
      state.threadPage = 0;
      state.threadBackAction = "panel:main";
      state.threadFilterRepoPath = null;
      await renderThreadsPanel(ctx, state, { page: 0 });
    });

  panelStatusMenu = new Menu("panel-status", {
    onMenuOutdated: outdatedMessage,
  })
    .text("Refresh", async (ctx) => {
      await showPanelMessage(ctx, panelStatusText(), buildStatusKeyboard());
    })
    .text("Home", async (ctx) => {
      const state = getMenuState(ctx.chat.id);
      state.threadFilterRepoPath = null;
      await openPanelHome(ctx);
    })
    .row()
    .text("Conversations", async (ctx) => {
      const chatId = String(ctx.chat.id);
      const state = getMenuState(chatId);
      state.threadChoices = getRecentThreadIds(60);
      state.threadPage = 0;
      state.threadBackAction = "panel:main";
      state.threadFilterRepoPath = null;
      await renderThreadsPanel(ctx, state, { page: 0 });
    })
    .text("Repositories", async (ctx) => {
      const chatId = String(ctx.chat.id);
      const state = getMenuState(chatId);
      state.repoChoices = getRecentRepos(60);
      state.repoPage = 0;
      await renderReposPanel(ctx, state, { page: 0 });
    });

  panelRepoActionMenu = new Menu("panel-repo-actions", {
    onMenuOutdated: outdatedMessage,
  })
    .text("Start New Chat", async (ctx) => {
      const chatId = String(ctx.chat.id);
      const state = getMenuState(chatId);
      const repoPath = state.selectedRepoPath;
      if (!repoPath) {
        await showPanelMessage(
          ctx,
          "No repo selected. Open /panel and choose a repo first.",
          buildPanelMainKeyboard(),
        );
        return;
      }

      const target = await startFreshSession(repoPath);
      syncActiveConversationContext(chatId, target);
      await showPanelMessage(
        ctx,
        [
          "Started new conversation in selected repo.",
          `Workdir: ${target}`,
          `Thread ID: ${PENDING_THREAD_TEXT}`,
        ].join("\n"),
        buildPanelNavKeyboard(),
      );
    })
    .row()
    .text("Browse Conversations", async (ctx) => {
      const chatId = String(ctx.chat.id);
      const state = getMenuState(chatId);
      const repoPath = state.selectedRepoPath;
      if (!repoPath) {
        await showPanelMessage(
          ctx,
          "No repo selected. Open /panel and choose a repo first.",
          buildPanelMainKeyboard(),
        );
        return;
      }

      const selectedNormalized = normalizeFsPath(repoPath);
      const threads = getRecentThreadIds(80).filter((thread) => normalizeFsPath(thread.cwd) === selectedNormalized);
      if (threads.length === 0) {
        await showPanelMessage(
          ctx,
          "No saved conversations found for this repo.",
          buildRepoActionKeyboard(),
        );
        return;
      }

      state.threadChoices = threads;
      state.threadPage = 0;
      state.threadBackAction = "repo:menu";
      state.threadFilterRepoPath = repoPath;
      await renderThreadsPanel(ctx, state, { page: 0 });
    })
    .row()
    .text("Set Default Repo", async (ctx) => {
      const chatId = String(ctx.chat.id);
      const state = getMenuState(chatId);
      const repoPath = state.selectedRepoPath;
      if (!repoPath) {
        await showPanelMessage(
          ctx,
          "No repo selected. Open /panel and choose a repo first.",
          buildPanelMainKeyboard(),
        );
        return;
      }

      syncActiveConversationContext(chatId, repoPath, { clearThreadFilter: false });
      await showPanelMessage(
        ctx,
        `Default repo set:\n${defaultWorkdir}`,
        buildRepoActionKeyboard(),
      );
    })
    .row()
    .text("Back to Repos", async (ctx) => {
      const chatId = String(ctx.chat.id);
      const state = getMenuState(chatId);
      state.repoChoices = getRecentRepos(60);
      state.repoPage = 0;
      await renderReposPanel(ctx, state, { page: 0 });
    })
    .text("Home", async (ctx) => {
      const state = getMenuState(ctx.chat.id);
      state.threadFilterRepoPath = null;
      await openPanelHome(ctx);
    });

  bot.use(panelMainMenu);
  bot.use(panelStatusMenu);
  bot.use(panelRepoActionMenu);
}

bot.use(async (ctx, next) => {
  if (!ctx.chat) {
    return;
  }

  const text = ctx.msg?.text?.trim();
  const isBootstrapCommand = text === "/chatid" || text?.startsWith("/chatid@");
  if (isBootstrapCommand) {
    await next();
    return;
  }

  if (!isAuthorizedChat(ctx)) {
    return;
  }

  subscribers.add(String(ctx.chat.id));
  await next();
});

bot.use(conversations());
bot.use(createConversation(setRepoPathConversation, {
  id: "setRepoPathConversation",
  maxMillisecondsToWait: config.repoPathPromptTimeoutMs,
}));
createPanelMenus();

bot.command("start", async (ctx) => {
  if (!isAuthorizedChat(ctx)) {
    await ctx.reply(
      [
        "This chat is not authorized yet.",
        currentChatIdText(ctx),
        "Add that number to TELEGRAM_ALLOWED_CHAT_IDS in .env, then restart the bot.",
        "You can also use /chatid anytime to fetch it again.",
      ].join("\n"),
    );
    return;
  }

  await ctx.reply(helpText(), {
    reply_markup: buildControlKeyboard(),
  });
});

bot.command("help", async (ctx) => {
  if (!isAuthorizedChat(ctx)) {
    await ctx.reply(
      [
        "This chat is not authorized yet.",
        currentChatIdText(ctx),
        "Add that number to TELEGRAM_ALLOWED_CHAT_IDS in .env, then restart the bot.",
      ].join("\n"),
    );
    return;
  }

  await ctx.reply(helpText(), {
    reply_markup: buildControlKeyboard(),
  });
});

bot.command("menu", async (ctx) => {
  await ctx.reply("Control keyboard enabled.", {
    reply_markup: buildControlKeyboard(),
  });
});

bot.command("hide_menu", async (ctx) => {
  await ctx.reply("Control keyboard hidden.", {
    reply_markup: { remove_keyboard: true },
  });
});

bot.command("panel", async (ctx) => {
  await openPanelHome(ctx, { cleanup: true });
});

bot.on("message:web_app_data", async (ctx) => {
  const raw = ctx.msg.web_app_data?.data?.trim();
  if (!raw) {
    return;
  }

  if (raw === "/panel") {
    await openPanelHome(ctx, { cleanup: true });
    return;
  }

  if (raw === "/status") {
    await ctx.reply(sessionStatusText());
    return;
  }

  if (/^\/threads(\s+\d+)?$/i.test(raw)) {
    const parsedLimit = Number.parseInt(raw.split(/\s+/)[1] ?? "10", 10);
    const limit = Number.isInteger(parsedLimit) ? Math.max(1, Math.min(parsedLimit, 20)) : 10;
    const threads = getRecentThreadIds(limit);
    if (threads.length === 0) {
      await ctx.reply("No local Codex threads found.");
      return;
    }

    const lines = ["Recent thread IDs:"];
    for (const thread of threads) {
      lines.push(`${thread.threadId}`);
      lines.push(`${thread.label}  (${thread.when})`);
      if (thread.latestMessage) {
        const roleTag = thread.latestRole === "assistant"
          ? "assistant"
          : (thread.latestRole === "user" ? "you" : "latest");
        lines.push(`${roleTag}: ${thread.latestMessage}`);
      }
    }
    lines.push("");
    lines.push("Use: /resume_thread <thread_id> [path]");
    await ctx.reply(lines.join("\n"));
    return;
  }

  await ctx.reply(`Unsupported Mini App action: ${raw}`);
});

bot.command("chatid", async (ctx) => {
  await ctx.reply(currentChatIdText(ctx));
});

bot.command("threads", async (ctx) => {
  const rawLimit = parseCommandArg(ctx.msg.text);
  let limit = 10;

  if (rawLimit) {
    const parsed = Number.parseInt(rawLimit, 10);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 20) {
      await ctx.reply("Usage: /threads [n] where n is between 1 and 20");
      return;
    }
    limit = parsed;
  }

  const threads = getRecentThreadIds(limit);
  if (threads.length === 0) {
    await ctx.reply("No local Codex threads found.");
    return;
  }

  const lines = ["Recent thread IDs:"];
  for (const thread of threads) {
    lines.push(`${thread.threadId}`);
    lines.push(`${thread.label}  (${thread.when})`);
    if (thread.latestMessage) {
      const roleTag = thread.latestRole === "assistant"
        ? "assistant"
        : (thread.latestRole === "user" ? "you" : "latest");
      lines.push(`${roleTag}: ${thread.latestMessage}`);
    }
  }
  lines.push("");
  lines.push("Use: /resume_thread <thread_id> [path]");

  await ctx.reply(lines.join("\n"));
});

bot.command("replay", async (ctx) => {
  const rawLimit = parseCommandArg(ctx.msg.text);
  let limit = THREAD_REPLAY_TURN_LIMIT;

  if (rawLimit) {
    const parsed = Number.parseInt(rawLimit, 10);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 50) {
      await ctx.reply("Usage: /replay [n] where n is between 1 and 50");
      return;
    }
    limit = parsed;
  }

  const target = resolveReplayThreadForCurrentContext();
  if (!target?.threadId) {
    await ctx.reply("No thread available to replay. Start Codex or run /resume_thread first.");
    return;
  }

  if (target.source !== "active session") {
    await ctx.reply(
      [
        "No active thread in session.",
        `Using ${target.source}:`,
        target.threadId,
      ].join("\n"),
    );
  }

  const replayedCount = await sendTranscriptReplay(ctx, target.threadId, { limit });
  if (replayedCount === 0) {
    await ctx.reply(`No transcript messages found for thread:\n${target.threadId}`);
  }
});

bot.command("status", async (ctx) => {
  await ctx.reply(sessionStatusText());
});

bot.command("cwd", async (ctx) => {
  await ctx.reply(`Default workdir: ${defaultWorkdir}`);
});

bot.command("setdir", async (ctx) => {
  const rawPath = parseCommandArg(ctx.msg.text);
  if (!rawPath) {
    await ctx.reply("Usage: /setdir <path>");
    return;
  }

  try {
    defaultWorkdir = ensureDirectory(resolveWorkdir(rawPath));
    syncActiveRepoForChat(String(ctx.chat.id), defaultWorkdir);
    await ctx.reply(`Default workdir set to:\n${defaultWorkdir}`);
  } catch (error) {
    await ctx.reply(error.message);
  }
});

bot.command("clear_chat", async (ctx) => {
  const chatId = String(ctx.chat.id);
  await clearChatArtifacts(chatId);

  const confirmation = await ctx.reply("Chat cleanup complete.");
  if (confirmation?.message_id) {
    scheduleMessageDeletion(chatId, confirmation.message_id, 4000);
  }

  await safeDeleteMessage(chatId, ctx.msg.message_id);
});

bot.command("start_codex", async (ctx) => {
  const rawPath = parseCommandArg(ctx.msg.text);
  let targetWorkdir = defaultWorkdir;
  const chatId = String(ctx.chat.id);

  try {
    if (rawPath) {
      targetWorkdir = ensureDirectory(resolveWorkdir(rawPath));
    }

    if (session.isRunning) {
      if (session.workdir === targetWorkdir && !session.isBusy) {
        syncActiveConversationContext(chatId, targetWorkdir);
        await ctx.reply(`Codex is already running in:\n${targetWorkdir}`);
        return;
      }
    }

    await ctx.reply(`Starting Codex in:\n${targetWorkdir}`);
    await startFreshSession(targetWorkdir);
    syncActiveConversationContext(chatId, targetWorkdir);
    await ctx.reply(`Started Codex in:\n${targetWorkdir}`);
  } catch (error) {
    await ctx.reply(`Failed to start Codex: ${error.message}`);
  }
});

bot.command("resume_thread", async (ctx) => {
  const rawInput = parseCommandArg(ctx.msg.text);
  const parsed = parseThreadAndOptionalPath(rawInput);
  if (!parsed) {
    await ctx.reply("Usage: /resume_thread <thread_id> [path]");
    return;
  }

  const { threadId, pathArg } = parsed;
  let targetWorkdir = defaultWorkdir;
  const chatId = String(ctx.chat.id);

  try {
    if (pathArg) {
      targetWorkdir = ensureDirectory(resolveWorkdir(pathArg));
    }

    await ctx.reply(
      [
        "Resuming existing Codex thread.",
        `Thread ID: ${threadId}`,
        `Workdir: ${targetWorkdir}`,
      ].join("\n"),
    );

    await resumeExistingThread(threadId, targetWorkdir);
    syncActiveConversationContext(chatId, targetWorkdir);
    await ctx.reply(`Resumed thread:\n${threadId}`);
    await sendTranscriptReplay(ctx, threadId);
  } catch (error) {
    await ctx.reply(`Failed to resume thread: ${error.message}`);
  }
});

bot.command("restart_codex", async (ctx) => {
  const rawPath = parseCommandArg(ctx.msg.text);
  const chatId = String(ctx.chat.id);

  try {
    const targetWorkdir = rawPath
      ? ensureDirectory(resolveWorkdir(rawPath))
      : defaultWorkdir;

    await ctx.reply(`Restarting Codex in:\n${targetWorkdir}`);
    await startFreshSession(targetWorkdir);
    syncActiveConversationContext(chatId, targetWorkdir);
    await ctx.reply(`Restarted Codex in:\n${targetWorkdir}`);
  } catch (error) {
    await ctx.reply(`Failed to restart Codex: ${error.message}`);
  }
});

bot.command("stop_codex", async (ctx) => {
  if (!session.stop()) {
    await ctx.reply("Codex is not running.");
    return;
  }

  await ctx.reply("Stopping Codex session.");
});

bot.command("send", async (ctx) => {
  const text = parseCommandArg(ctx.msg.text);
  if (!text) {
    await ctx.reply("Usage: /send <text>");
    return;
  }

  await forwardPrompt(ctx, text);
});

bot.command("ctrlc", async (ctx) => {
  try {
    session.interrupt();
    await ctx.reply("Sent interrupt.");
  } catch (error) {
    await ctx.reply(error.message);
  }
});

bot.callbackQuery(/^panel:(main|status|switch|new|repos|threads|setpath)$/, async (ctx) => {
  const action = ctx.match[1];
  await ctx.answerCallbackQuery().catch(() => {});

  const chatId = String(ctx.chat.id);
  const state = getMenuState(chatId);

  try {
    if (action === "main") {
      state.threadFilterRepoPath = null;
      await openPanelHome(ctx);
      return;
    }

    if (action === "status") {
      await showPanelMessage(
        ctx,
        panelStatusText(),
        buildStatusKeyboard(),
      );
      return;
    }

    if (action === "threads" || action === "switch") {
      state.threadChoices = getRecentThreadIds(60);
      state.threadPage = 0;
      state.threadBackAction = "panel:main";
      state.threadFilterRepoPath = null;
      await renderThreadsPanel(ctx, state, { page: 0 });
      return;
    }

    if (action === "new") {
      const target = await startFreshSession(defaultWorkdir);
      syncActiveConversationContext(chatId, target);
      await showPanelMessage(
        ctx,
        [
          "Started new conversation.",
          `Workdir: ${target}`,
          `Thread ID: ${PENDING_THREAD_TEXT}`,
        ].join("\n"),
        buildPanelNavKeyboard(),
      );
      return;
    }

    if (action === "repos") {
      state.repoChoices = getRecentRepos(60);
      state.repoPage = 0;
      await renderReposPanel(ctx, state, { page: 0 });
      return;
    }

    if (action === "setpath") {
      await enterSetRepoPathConversation(ctx);
    }
  } catch (error) {
    await showPanelMessage(
      ctx,
      `Panel action failed: ${error.message}`,
      buildPanelNavKeyboard(),
    );
  }
});

bot.callbackQuery(/^page:(threads|repos):(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery().catch(() => {});

  const listType = ctx.match[1];
  const requestedPage = Number.parseInt(ctx.match[2], 10);
  const chatId = String(ctx.chat.id);
  const state = getMenuState(chatId);

  try {
    if (!Number.isInteger(requestedPage) || requestedPage < 0) {
      await showPanelMessage(ctx, "Invalid page request.", buildPanelNavKeyboard());
      return;
    }

    if (listType === "threads") {
      await renderThreadsPanel(ctx, state, { page: requestedPage });
      return;
    }

    await renderReposPanel(ctx, state, { page: requestedPage });
  } catch (error) {
    await showPanelMessage(
      ctx,
      `Page change failed: ${error.message}`,
      buildPanelNavKeyboard(),
    );
  }
});

bot.callbackQuery(/^repo:menu$/, async (ctx) => {
  await ctx.answerCallbackQuery().catch(() => {});

  const chatId = String(ctx.chat.id);
  const state = getMenuState(chatId);

  const repoPath = state.selectedRepoPath;
  if (!repoPath) {
    await showPanelMessage(
      ctx,
      "No repo selected. Open Repositories first.",
      buildPanelMainKeyboard(),
    );
    return;
  }

  await showPanelMessage(
    ctx,
    panelRepoContextText(repoPath),
    buildRepoActionKeyboard(),
  );
});

bot.callbackQuery(/^pick:repo:([A-Za-z0-9_-]+|\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery().catch(() => {});

  const chatId = String(ctx.chat.id);
  const state = getMenuState(chatId);
  const rawToken = ctx.match[1];

  let repoPath = state.repoTokenToPath.get(rawToken);
  if (!repoPath && /^\d+$/.test(rawToken)) {
    const index = Number.parseInt(rawToken, 10);
    repoPath = state.repoChoices[index]?.path;
  }

  const repo = state.repoChoices.find((entry) => entry.path === repoPath);
  if (!repo) {
    await showPanelMessage(
      ctx,
      "Repo selection expired. Open /panel again.",
      buildPanelMainKeyboard(),
    );
    return;
  }

  state.selectedRepoPath = repo.path;
  await showPanelMessage(
    ctx,
    panelRepoContextText(repo.path),
    buildRepoActionKeyboard(),
  );
});

bot.callbackQuery(/^repo:action:(new|set|switch)$/, async (ctx) => {
  await ctx.answerCallbackQuery().catch(() => {});

  const action = ctx.match[1];
  const chatId = String(ctx.chat.id);
  const state = getMenuState(chatId);
  const repoPath = state.selectedRepoPath;
  if (!repoPath) {
    await showPanelMessage(
      ctx,
      "No repo selected. Open /panel and choose a repo first.",
      buildPanelMainKeyboard(),
    );
    return;
  }

  try {
    if (action === "set") {
      const target = ensureDirectory(repoPath);
      syncActiveConversationContext(chatId, target, { clearThreadFilter: false });
      await showPanelMessage(
        ctx,
        `Default repo set:\n${defaultWorkdir}`,
        buildRepoActionKeyboard(),
      );
      return;
    }

    if (action === "new") {
      const target = await startFreshSession(repoPath);
      syncActiveConversationContext(chatId, target, { clearThreadFilter: false });
      await showPanelMessage(
        ctx,
        [
          "Started new conversation in selected repo.",
          `Workdir: ${target}`,
          `Thread ID: ${PENDING_THREAD_TEXT}`,
        ].join("\n"),
        buildPanelNavKeyboard(),
      );
      return;
    }

    if (action === "switch") {
      const selectedNormalized = normalizeFsPath(repoPath);
      const threads = getRecentThreadIds(80).filter((thread) => normalizeFsPath(thread.cwd) === selectedNormalized);
      if (threads.length === 0) {
        await showPanelMessage(
          ctx,
          "No saved conversations found for this repo.",
          buildRepoActionKeyboard(),
        );
        return;
      }

      state.threadChoices = threads;
      state.threadPage = 0;
      state.threadBackAction = "repo:menu";
      state.threadFilterRepoPath = repoPath;
      await renderThreadsPanel(ctx, state, { page: 0 });
    }
  } catch (error) {
    await showPanelMessage(
      ctx,
      `Repo action failed: ${error.message}`,
      buildRepoActionKeyboard(),
    );
  }
});

bot.callbackQuery(/^pick:thread:([0-9a-f-]{36}|\d+)$/i, async (ctx) => {
  await ctx.answerCallbackQuery().catch(() => {});

  const chatId = String(ctx.chat.id);
  const state = getMenuState(chatId);
  const rawToken = ctx.match[1];

  let thread = null;
  if (/^\d+$/.test(rawToken)) {
    const index = Number.parseInt(rawToken, 10);
    thread = state.threadChoices[index] ?? null;
  } else {
    thread = state.threadById.get(rawToken) ?? state.threadChoices.find((candidate) => candidate.threadId === rawToken) ?? null;
  }
  if (!thread) {
    await showPanelMessage(
      ctx,
      "Thread selection expired. Open /panel again.",
      buildPanelMainKeyboard(),
    );
    return;
  }

  try {
    const resolved = resolveThreadResumeWorkdir(thread, state);
    if (!resolved) {
      await showPanelMessage(
        ctx,
        [
          "Cannot safely resume this conversation.",
          `Thread ID: ${thread.threadId}`,
          "No valid repo path was found for this thread.",
          "",
          "Open Repositories, select the repo, then browse conversations again.",
          "Or use /resume_thread <thread_id> <path>.",
        ].join("\n"),
        buildPanelNavKeyboard(),
      );
      return;
    }

    const targetWorkdir = resolved.workdir;

    await resumeExistingThread(thread.threadId, targetWorkdir);
    syncActiveConversationContext(chatId, targetWorkdir);
    await showPanelMessage(
      ctx,
      [
        "Conversation resumed.",
        `Thread ID: ${thread.threadId}`,
        `Workdir: ${targetWorkdir}`,
        `Repo source: ${resolved.source}`,
      ].join("\n"),
      new InlineKeyboard()
        .text("Home", "panel:main")
        .text("Session", "panel:status")
        .row()
        .text("Conversations", "panel:switch")
        .text("Repositories", "panel:repos"),
    );
    await sendTranscriptReplay(ctx, thread.threadId);
  } catch (error) {
    await showPanelMessage(
      ctx,
      `Failed to resume thread: ${error.message}`,
      buildPanelNavKeyboard(),
    );
  }
});

bot.on("message:text", async (ctx) => {
  const text = ctx.msg.text.trim();
  if (!text || text.startsWith("/")) {
    return;
  }

  await forwardPrompt(ctx, text);
});

session.on("start", ({ workdir, threadId }) => {
  invalidateThreadHistoryCache();
  queueOutput(
    [
      "[codex ready]",
      `Thread ID: ${threadId ?? PENDING_THREAD_TEXT}`,
      `Workdir: ${workdir}`,
    ].join("\n"),
  );
  void refreshBotUiConfiguration();
});

session.on("output", (text, meta) => {
  queueOutput(text, { partial: Boolean(meta?.partial) });
});

session.on("error", (error) => {
  queueOutput(`[codex error]\n${error.message}`);
});

session.on("exit", ({ reason, workdir, threadId }) => {
  invalidateThreadHistoryCache();
  queueOutput(
    [
      "[codex session ended]",
      `Reason: ${reason}`,
      `Thread ID: ${threadId ?? "n/a"}`,
      `Workdir: ${workdir ?? "n/a"}`,
    ].join("\n"),
  );
  void refreshBotUiConfiguration();
});

bot.catch((error) => {
  console.error("Telegram bot error:", error.error);
});

async function shutdown(signal) {
  console.log(`Received ${signal}, shutting down.`);
  await session.stopAndWait().catch(() => {});
  bot.stop();
  process.exit(0);
}

process.on("SIGINT", () => {
  void shutdown("SIGINT");
});

process.on("SIGTERM", () => {
  void shutdown("SIGTERM");
});

function authorizedCommandSet() {
  return session.isRunning ? AUTHORIZED_ACTIVE_BOT_COMMANDS : AUTHORIZED_IDLE_BOT_COMMANDS;
}

function preferredChatMenuButton() {
  if (config.menuWebAppUrl) {
    return {
      type: "web_app",
      text: "Control Panel",
      web_app: {
        url: config.menuWebAppUrl,
      },
    };
  }

  return {
    type: "commands",
  };
}

async function registerBotCommands() {
  try {
    await bot.api.setMyCommands(PUBLIC_BOT_COMMANDS);
  } catch (error) {
    console.error("Failed to register Telegram command menu:", error);
  }

  const authorizedCommands = authorizedCommandSet();
  for (const chatId of config.allowedChatIds) {
    try {
      await bot.api.setMyCommands(authorizedCommands, {
        scope: {
          type: "chat",
          chat_id: chatId,
        },
      });
    } catch (error) {
      console.error(`Failed to register Telegram command menu for chat ${chatId}:`, error);
    }
  }
}

async function registerChatMenuButtons() {
  const menuButton = preferredChatMenuButton();

  try {
    await bot.api.setChatMenuButton({
      menu_button: menuButton,
    });
  } catch (error) {
    console.error("Failed to set default Telegram chat menu button:", error);
  }

  for (const chatId of config.allowedChatIds) {
    try {
      await bot.api.setChatMenuButton({
        chat_id: chatId,
        menu_button: menuButton,
      });
    } catch (error) {
      console.error(`Failed to set Telegram chat menu button for chat ${chatId}:`, error);
    }
  }
}

async function refreshBotUiConfiguration() {
  await registerBotCommands();
  await registerChatMenuButtons();
}

console.log("Starting Telegram Codex bridge...");
console.log(`Default workdir: ${defaultWorkdir}`);
console.log(`Authorized chat count: ${config.allowedChatIds.size}`);

try {
  await refreshBotUiConfiguration();
  await bot.start({
    drop_pending_updates: true,
    onStart: () => {
      console.log("Bot polling started.");
    },
  });
} catch (error) {
  const description = error?.description || error?.message || String(error);
  console.error("Failed to start Telegram bot.");
  console.error(`Reason: ${description}`);
  console.error("Check TELEGRAM_BOT_TOKEN in .env and make sure you regenerated it after exposing the old one.");
  process.exit(1);
}
