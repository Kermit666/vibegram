import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SESSION_FILE_PATTERN = /^rollout-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})-([0-9a-f-]{36})\.jsonl$/i;

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

function repoNameFromPath(repoPath) {
  if (typeof repoPath !== "string" || !repoPath.trim()) {
    return "Unknown";
  }

  const trimmed = repoPath.trim().replace(/[\\/]+$/, "");
  const basename = path.basename(trimmed);
  return basename || shortPathLabel(repoPath, 28);
}

function formatSessionTimestamp(raw) {
  const [datePart, timePart] = raw.split("T");
  if (!datePart || !timePart) {
    return raw;
  }

  return `${datePart} ${timePart.replace(/-/g, ":")}`;
}

function summarizeLabel(text, maxThreadLabelLength) {
  const singleLine = text.replace(/\s+/g, " ").trim();
  if (singleLine.length <= maxThreadLabelLength) {
    return singleLine;
  }

  return `${singleLine.slice(0, maxThreadLabelLength - 1)}...`;
}

function summarizePreview(text, maxThreadPreviewLength) {
  const singleLine = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!singleLine) {
    return "";
  }

  if (singleLine.length <= maxThreadPreviewLength) {
    return singleLine;
  }

  return `${singleLine.slice(0, maxThreadPreviewLength - 3)}...`;
}

function looksLikeSessionBoilerplate(text) {
  const normalized = text.trim();
  if (!normalized) {
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
  ].some((pattern) => pattern.test(normalized));
}

function firstContentText(parts) {
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

function parseSessionFileSummary(filePath, { maxThreadLabelLength, maxThreadPreviewLength }) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch {
    return {
      label: "Untitled thread",
      cwd: "",
      latestMessage: "",
      latestRole: "",
    };
  }

  let fallbackLabel = "Untitled thread";
  let label = "";
  let cwd = "";
  let latestMessage = "";
  let latestRole = "";

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

    if (parsed.type === "session_meta") {
      const parsedCwd = parsed.payload?.cwd;
      if (typeof parsedCwd === "string" && parsedCwd.trim()) {
        cwd = parsedCwd.trim();
        const basename = path.basename(cwd.replace(/[\\/]+$/, ""));
        if (basename) {
          fallbackLabel = `[${basename}]`;
        }
      }
      continue;
    }

    if (parsed.type !== "response_item") {
      continue;
    }

    if (parsed.payload?.type !== "message") {
      continue;
    }

    const text = firstContentText(parsed.payload?.content);
    if (!text) {
      continue;
    }

    const firstLine = text.split(/\r?\n/).find((segment) => segment.trim()) || text;
    if (looksLikeSessionBoilerplate(firstLine)) {
      continue;
    }

    const normalizedLine = firstLine.trim();
    if (!normalizedLine) {
      continue;
    }

    if (!label && parsed.payload?.role === "user") {
      label = summarizeLabel(normalizedLine, maxThreadLabelLength);
    }

    latestMessage = normalizedLine;
    latestRole = typeof parsed.payload?.role === "string" ? parsed.payload.role : "";
  }

  return {
    label: label || fallbackLabel,
    cwd,
    latestMessage: summarizePreview(latestMessage, maxThreadPreviewLength),
    latestRole,
  };
}

export class SessionHistoryStore {
  #threadRecordsCacheTtlMs;
  #summaryCacheMaxEntries;
  #maxThreadLabelLength;
  #maxThreadPreviewLength;
  #sessionSummaryCache = new Map();
  #sessionThreadRecordsCache = {
    loadedAtMs: 0,
    records: [],
  };

  constructor({
    threadRecordsCacheTtlMs = 3000,
    summaryCacheMaxEntries = 512,
    maxThreadLabelLength = 90,
    maxThreadPreviewLength = 120,
  } = {}) {
    this.#threadRecordsCacheTtlMs = threadRecordsCacheTtlMs;
    this.#summaryCacheMaxEntries = summaryCacheMaxEntries;
    this.#maxThreadLabelLength = maxThreadLabelLength;
    this.#maxThreadPreviewLength = maxThreadPreviewLength;
  }

  invalidate() {
    this.#sessionThreadRecordsCache = {
      loadedAtMs: 0,
      records: [],
    };
  }

  #getSessionFileSummary(filePath, mtimeMs) {
    const cached = this.#sessionSummaryCache.get(filePath);
    if (cached && cached.mtimeMs === mtimeMs) {
      return cached.summary;
    }

    const summary = parseSessionFileSummary(filePath, {
      maxThreadLabelLength: this.#maxThreadLabelLength,
      maxThreadPreviewLength: this.#maxThreadPreviewLength,
    });
    this.#sessionSummaryCache.set(filePath, {
      mtimeMs,
      summary,
    });
    if (this.#sessionSummaryCache.size > this.#summaryCacheMaxEntries) {
      const oldestKey = this.#sessionSummaryCache.keys().next().value;
      if (oldestKey) {
        this.#sessionSummaryCache.delete(oldestKey);
      }
    }

    return summary;
  }

  #collectSessionThreadRecords(rootDir, records) {
    if (!fs.existsSync(rootDir) || !fs.statSync(rootDir).isDirectory()) {
      return;
    }

    const stack = [rootDir];
    while (stack.length > 0) {
      const current = stack.pop();
      let entries = [];
      try {
        entries = fs.readdirSync(current, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const entry of entries) {
        const entryPath = path.join(current, entry.name);
        if (entry.isDirectory()) {
          stack.push(entryPath);
          continue;
        }

        if (!entry.isFile()) {
          continue;
        }

        const match = SESSION_FILE_PATTERN.exec(entry.name);
        if (!match) {
          continue;
        }

        const [, rawTimestamp, threadId] = match;
        let stat;
        try {
          stat = fs.statSync(entryPath);
        } catch {
          continue;
        }

        records.push({
          threadId,
          when: formatSessionTimestamp(rawTimestamp),
          mtimeMs: stat.mtimeMs,
          filePath: entryPath,
        });
      }
    }
  }

  #getSessionThreadRecords() {
    const now = Date.now();
    if (now - this.#sessionThreadRecordsCache.loadedAtMs < this.#threadRecordsCacheTtlMs) {
      return this.#sessionThreadRecordsCache.records;
    }

    const codexHome = path.join(os.homedir(), ".codex");
    const records = [];
    this.#collectSessionThreadRecords(path.join(codexHome, "sessions"), records);
    this.#collectSessionThreadRecords(path.join(codexHome, "archived_sessions"), records);
    records.sort((a, b) => b.mtimeMs - a.mtimeMs);

    this.#sessionThreadRecordsCache = {
      loadedAtMs: now,
      records,
    };

    const activeFilePaths = new Set(records.map((record) => record.filePath));
    for (const filePath of this.#sessionSummaryCache.keys()) {
      if (!activeFilePaths.has(filePath)) {
        this.#sessionSummaryCache.delete(filePath);
      }
    }

    return records;
  }

  getRecentThreadIds(limit = 10) {
    const records = this.#getSessionThreadRecords();
    const deduped = [];
    const seen = new Set();
    for (const record of records) {
      if (seen.has(record.threadId)) {
        continue;
      }

      seen.add(record.threadId);
      const summary = this.#getSessionFileSummary(record.filePath, record.mtimeMs);
      deduped.push({
        ...record,
        label: summary.label,
        cwd: summary.cwd,
        repoName: repoNameFromPath(summary.cwd),
        latestMessage: summary.latestMessage,
        latestRole: summary.latestRole,
      });
      if (deduped.length >= limit) {
        break;
      }
    }

    return deduped;
  }

  getRecentRepos(defaultWorkdir, limit = 12) {
    const records = this.#getSessionThreadRecords();

    const repos = [];
    const seen = new Set();
    const directoryCheckCache = new Map();

    const currentDefaultNormalized = normalizeFsPath(defaultWorkdir);
    if (currentDefaultNormalized && !seen.has(currentDefaultNormalized)) {
      repos.push({
        path: defaultWorkdir,
        name: path.basename(defaultWorkdir) || shortPathLabel(defaultWorkdir),
        when: "current",
      });
      seen.add(currentDefaultNormalized);
    }

    for (const record of records) {
      const summary = this.#getSessionFileSummary(record.filePath, record.mtimeMs);
      const cwd = summary.cwd;
      if (!cwd) {
        continue;
      }

      let isDirectory = directoryCheckCache.get(cwd);
      if (typeof isDirectory !== "boolean") {
        try {
          isDirectory = fs.statSync(cwd).isDirectory();
        } catch {
          isDirectory = false;
        }
        directoryCheckCache.set(cwd, isDirectory);
      }
      if (!isDirectory) {
        continue;
      }

      const normalized = normalizeFsPath(cwd);
      if (!normalized || seen.has(normalized)) {
        continue;
      }
      seen.add(normalized);

      repos.push({
        path: cwd,
        name: path.basename(cwd) || shortPathLabel(cwd),
        when: record.when,
      });

      if (repos.length >= limit) {
        break;
      }
    }

    return repos;
  }

  findThreadById(threadId) {
    const needle = typeof threadId === "string" ? threadId.trim().toLowerCase() : "";
    if (!needle) {
      return null;
    }

    const records = this.#getSessionThreadRecords();
    for (const record of records) {
      if (String(record.threadId).toLowerCase() !== needle) {
        continue;
      }

      const summary = this.#getSessionFileSummary(record.filePath, record.mtimeMs);
      return {
        ...record,
        label: summary.label,
        cwd: summary.cwd,
        repoName: repoNameFromPath(summary.cwd),
        latestMessage: summary.latestMessage,
        latestRole: summary.latestRole,
      };
    }

    return null;
  }
}
