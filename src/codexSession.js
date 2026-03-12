import { execFileSync, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

function resolveExecutable(command) {
  const hasPathSeparator = command.includes("/") || command.includes("\\");

  if (hasPathSeparator || path.isAbsolute(command)) {
    const resolved = path.resolve(command);
    if (fs.existsSync(resolved)) {
      return resolved;
    }

    throw new Error(`Executable not found: ${command}`);
  }

  if (process.platform === "win32") {
    try {
      const output = execFileSync("where.exe", [command], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      const resolved = output
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find((line) => line.length > 0 && fs.existsSync(line));

      if (resolved) {
        return resolved;
      }
    } catch {
      throw new Error(`Executable not found in PATH: ${command}`);
    }
  }

  throw new Error(`Executable not found in PATH: ${command}`);
}

function ensureDirectory(workdir) {
  if (!fs.existsSync(workdir) || !fs.statSync(workdir).isDirectory()) {
    throw new Error(`Workdir does not exist: ${workdir}`);
  }
}

function summarizeFailure(code, stderrBuffer, fallbackMessage) {
  const stderrLines = stderrBuffer
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !line.includes("WARN codex_"))
    .filter((line) => !line.includes("state_5.sqlite"))
    .filter((line) => !line.includes("Shell snapshot not supported"));

  if (fallbackMessage) {
    return fallbackMessage;
  }

  if (stderrLines.length > 0) {
    return stderrLines[stderrLines.length - 1];
  }

  return `Codex exited with code ${code}.`;
}

function isAgentMessageItem(item) {
  return item?.type === "agent_message" || item?.role === "assistant";
}

function extractAgentText(item) {
  if (!item || typeof item !== "object") {
    return "";
  }

  if (typeof item.text === "string") {
    return item.text;
  }

  if (!Array.isArray(item.content)) {
    return "";
  }

  let combined = "";
  for (const part of item.content) {
    if (typeof part === "string") {
      combined += part;
      continue;
    }

    if (!part || typeof part !== "object") {
      continue;
    }

    if (typeof part.text === "string") {
      combined += part.text;
    }
  }

  return combined;
}

function streamKeyForEvent(parsed) {
  const itemId = typeof parsed.item?.id === "string"
    ? parsed.item.id
    : (typeof parsed.item_id === "string" ? parsed.item_id : null);
  const outputIndex = Number.isInteger(parsed.output_index) ? parsed.output_index : 0;
  const contentIndex = Number.isInteger(parsed.content_index) ? parsed.content_index : 0;

  if (itemId) {
    return `${itemId}:${outputIndex}:${contentIndex}`;
  }

  if (Number.isInteger(parsed.item_index)) {
    return `item-index:${parsed.item_index}:${contentIndex}`;
  }

  return `fallback:${outputIndex}:${contentIndex}`;
}

export class CodexSession extends EventEmitter {
  #command;
  #extraArgs;
  #resolvedExecutable = null;
  #activeChild = null;
  #workdir = null;
  #threadId = null;
  #stopRequested = false;
  #interruptRequested = false;

  constructor({ command, extraArgs }) {
    super();
    this.#command = command;
    this.#extraArgs = extraArgs;
  }

  get isRunning() {
    return this.#workdir !== null;
  }

  get isBusy() {
    return this.#activeChild !== null;
  }

  get workdir() {
    return this.#workdir;
  }

  get threadId() {
    return this.#threadId;
  }

  get pid() {
    return this.#activeChild?.pid ?? null;
  }

  #getExecutable() {
    if (this.#resolvedExecutable && fs.existsSync(this.#resolvedExecutable)) {
      return this.#resolvedExecutable;
    }

    const resolved = resolveExecutable(this.#command);
    this.#resolvedExecutable = resolved;
    return resolved;
  }

  async start(workdir, { threadId = null } = {}) {
    if (this.isRunning || this.isBusy) {
      throw new Error("Codex session is already running.");
    }

    ensureDirectory(workdir);
    this.#getExecutable();
    this.#workdir = workdir;
    this.#threadId = typeof threadId === "string" && threadId.trim().length > 0
      ? threadId.trim()
      : null;

    this.emit("start", {
      workdir,
      threadId: this.#threadId,
    });
  }

  stop() {
    if (!this.isRunning && !this.isBusy) {
      return false;
    }

    if (this.#activeChild) {
      this.#stopRequested = true;
      this.#activeChild.kill();
      return true;
    }

    const workdir = this.#workdir;
    const threadId = this.#threadId;
    this.#workdir = null;
    this.#threadId = null;

    queueMicrotask(() => {
      this.emit("exit", {
        reason: "stopped",
        workdir,
        threadId,
        exitCode: 0,
        signal: null,
      });
    });

    return true;
  }

  stopAndWait(timeoutMs = 10000) {
    if (!this.isRunning && !this.isBusy) {
      return Promise.resolve(false);
    }

    if (!this.#activeChild) {
      this.stop();
      return Promise.resolve(true);
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.off("exit", handleExit);
        reject(new Error("Timed out waiting for Codex to stop."));
      }, timeoutMs);

      const handleExit = () => {
        clearTimeout(timer);
        resolve(true);
      };

      this.once("exit", handleExit);
      this.stop();
    });
  }

  interrupt() {
    if (!this.#activeChild) {
      throw new Error("Codex is not currently processing a request.");
    }

    this.#interruptRequested = true;
    this.#activeChild.kill();
  }

  async send(prompt) {
    if (!this.isRunning) {
      throw new Error("Codex session is not running.");
    }

    if (this.#activeChild) {
      throw new Error("Codex is busy. Wait for the current request to finish or use /ctrlc.");
    }

    const result = await this.#runTurn({
      prompt,
      resume: Boolean(this.#threadId),
    });

    if (result.threadId) {
      this.#threadId = result.threadId;
    }

    if (result.agentText && !result.streamedPartial) {
      this.emit("output", result.agentText);
    }

    return result.agentText;
  }

  #runTurn({ prompt, resume }) {
    const executable = this.#getExecutable();
    const args = [
      "-C",
      this.#workdir,
      ...this.#extraArgs,
      "exec",
    ];

    if (resume && this.#threadId) {
      args.push("resume", "--json", "--skip-git-repo-check", this.#threadId, prompt);
    } else {
      args.push("--json", "--skip-git-repo-check", prompt);
    }

    return new Promise((resolve, reject) => {
      const child = spawn(executable, args, {
        cwd: this.#workdir,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });

      this.#activeChild = child;

      let stdoutBuffer = "";
      let stderrBuffer = "";
      let threadId = this.#threadId;
      let fallbackMessage = "";
      const agentMessages = [];
      const streamState = new Map();
      let streamedPartial = false;
      let streamedFallbackText = "";

      const getState = (key) => {
        const existing = streamState.get(key);
        if (existing) {
          return existing;
        }

        const created = {
          emittedLength: 0,
          text: "",
        };
        streamState.set(key, created);
        return created;
      };

      const emitPartial = (chunk) => {
        if (typeof chunk !== "string" || chunk.length === 0) {
          return;
        }

        streamedPartial = true;
        streamedFallbackText += chunk;
        this.emit("output", chunk, { partial: true });
      };

      const applyDelta = (key, delta) => {
        if (typeof delta !== "string" || delta.length === 0) {
          return;
        }

        const state = getState(key);
        state.text += delta;
        state.emittedLength += delta.length;
        emitPartial(delta);
      };

      const applySnapshot = (key, snapshot) => {
        if (typeof snapshot !== "string") {
          return;
        }

        const state = getState(key);
        if (snapshot.length > state.emittedLength) {
          emitPartial(snapshot.slice(state.emittedLength));
        }

        state.text = snapshot;
        state.emittedLength = Math.max(state.emittedLength, snapshot.length);
      };

      const finalizeBuffers = () => {
        const trailingLines = stdoutBuffer.split(/\r?\n/);
        stdoutBuffer = "";
        for (const line of trailingLines) {
          parseLine(line);
        }
      };

      const parseLine = (line) => {
        const trimmed = line.trim();
        if (!trimmed) {
          return;
        }

        let parsed;
        try {
          parsed = JSON.parse(trimmed);
        } catch {
          return;
        }

        if (parsed.type === "thread.started" && typeof parsed.thread_id === "string") {
          threadId = parsed.thread_id;
          return;
        }

        if (parsed.type === "response.output_text.delta" && typeof parsed.delta === "string") {
          applyDelta(streamKeyForEvent(parsed), parsed.delta);
          return;
        }

        if (parsed.type === "response.output_text.done" && typeof parsed.text === "string") {
          applySnapshot(streamKeyForEvent(parsed), parsed.text);
          return;
        }

        if ((parsed.type === "item.delta" || parsed.type === "item.updated") && isAgentMessageItem(parsed.item)) {
          const key = streamKeyForEvent(parsed);
          if (typeof parsed.delta === "string") {
            applyDelta(key, parsed.delta);
            return;
          }

          if (typeof parsed.item?.delta === "string") {
            applyDelta(key, parsed.item.delta);
            return;
          }

          const snapshot = extractAgentText(parsed.item);
          if (snapshot) {
            applySnapshot(key, snapshot);
          }
          return;
        }

        if (parsed.type === "item.completed" && isAgentMessageItem(parsed.item)) {
          const key = streamKeyForEvent(parsed);
          const rawText = extractAgentText(parsed.item);
          if (rawText) {
            applySnapshot(key, rawText);
          }

          const text = rawText.trim();
          if (text) {
            agentMessages.push(text);
          }
          return;
        }

        if (parsed.type === "turn.failed" && typeof parsed.error?.message === "string") {
          fallbackMessage = parsed.error.message;
        }
      };

      const clearActiveChild = () => {
        if (this.#activeChild === child) {
          this.#activeChild = null;
        }
      };

      child.stdout.on("data", (chunk) => {
        stdoutBuffer += chunk.toString();
        const lines = stdoutBuffer.split(/\r?\n/);
        stdoutBuffer = lines.pop() ?? "";
        for (const line of lines) {
          parseLine(line);
        }
      });

      child.stderr.on("data", (chunk) => {
        stderrBuffer += chunk.toString();
      });

      child.on("error", (error) => {
        clearActiveChild();
        const wrapped = new Error(`Failed to launch Codex: ${error.message}`);
        this.emit("error", wrapped);
        reject(wrapped);
      });

      child.on("close", (code, signal) => {
        finalizeBuffers();
        clearActiveChild();

        if (this.#stopRequested) {
          this.#stopRequested = false;
          const workdir = this.#workdir;
          const endedThreadId = threadId ?? this.#threadId;
          this.#workdir = null;
          this.#threadId = null;
          this.#interruptRequested = false;
          this.emit("exit", {
            reason: "stopped",
            workdir,
            threadId: endedThreadId,
            exitCode: code ?? 0,
            signal,
          });
          resolve({
            threadId: endedThreadId,
            agentText: "",
          });
          return;
        }

        if (this.#interruptRequested) {
          this.#interruptRequested = false;
          const interrupted = new Error("Codex request interrupted.");
          this.emit("output", "[codex interrupted]");
          reject(interrupted);
          return;
        }

        if (code !== 0) {
          const error = new Error(summarizeFailure(code, stderrBuffer, fallbackMessage));
          this.emit("error", error);
          reject(error);
          return;
        }

        resolve({
          threadId,
          agentText: agentMessages.join("\n\n").trim() || streamedFallbackText.trim(),
          streamedPartial,
        });
      });
    });
  }
}
