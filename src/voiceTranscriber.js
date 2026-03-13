import { execFileSync, spawn } from "node:child_process";
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

  const locatorCommand = process.platform === "win32" ? "where.exe" : "which";
  try {
    const output = execFileSync(locatorCommand, [command], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const resolved = output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line && fs.existsSync(line));
    if (resolved) {
      return resolved;
    }
  } catch {
    throw new Error(`Executable not found in PATH: ${command}`);
  }

  throw new Error(`Executable not found in PATH: ${command}`);
}

function summarizeProcessFailure(command, args, exitCode, signal, stderr, stdout) {
  const stderrLines = String(stderr ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const stdoutLines = String(stdout ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const detail = stderrLines[stderrLines.length - 1] || stdoutLines[stdoutLines.length - 1];
  const commandText = [command, ...args].join(" ");
  if (detail) {
    return `${commandText} failed: ${detail}`;
  }

  if (signal) {
    return `${commandText} exited due to signal ${signal}.`;
  }

  return `${commandText} exited with code ${exitCode}.`;
}

function runProcess(command, args, { cwd, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    let stdoutBuffer = "";
    let stderrBuffer = "";
    let timedOut = false;
    let timer = null;

    if (Number.isInteger(timeoutMs) && timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        child.kill();
      }, timeoutMs);
    }

    child.stdout.on("data", (chunk) => {
      stdoutBuffer += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderrBuffer += chunk.toString();
    });

    child.on("error", (error) => {
      if (timer) {
        clearTimeout(timer);
      }
      reject(new Error(`Failed to launch ${command}: ${error.message}`));
    });

    child.on("close", (code, signal) => {
      if (timer) {
        clearTimeout(timer);
      }

      if (timedOut) {
        reject(new Error(`${command} timed out after ${timeoutMs}ms.`));
        return;
      }

      if (code !== 0) {
        reject(new Error(summarizeProcessFailure(command, args, code, signal, stderrBuffer, stdoutBuffer)));
        return;
      }

      resolve({
        stdout: stdoutBuffer,
        stderr: stderrBuffer,
      });
    });
  });
}

function inferDurationSeconds(parsed) {
  if (Number.isFinite(parsed?.duration)) {
    return parsed.duration;
  }

  if (!Array.isArray(parsed?.segments)) {
    return null;
  }

  let maxEnd = 0;
  for (const segment of parsed.segments) {
    if (Number.isFinite(segment?.end) && segment.end > maxEnd) {
      maxEnd = segment.end;
    }
  }

  return maxEnd > 0 ? maxEnd : null;
}

export class VoiceTranscriber {
  #ffmpegCommand;
  #whisperCommand;
  #whisperModel;
  #whisperTask;
  #whisperLanguage;
  #whisperDevice;
  #whisperTimeoutMs;
  #whisperFp16;
  #resolvedFfmpeg = null;
  #resolvedWhisper = null;

  constructor({
    ffmpegCommand,
    whisperCommand,
    whisperModel,
    whisperTask,
    whisperLanguage,
    whisperDevice,
    whisperTimeoutMs,
    whisperFp16,
  }) {
    this.#ffmpegCommand = ffmpegCommand;
    this.#whisperCommand = whisperCommand;
    this.#whisperModel = whisperModel;
    this.#whisperTask = whisperTask;
    this.#whisperLanguage = whisperLanguage;
    this.#whisperDevice = whisperDevice;
    this.#whisperTimeoutMs = whisperTimeoutMs;
    this.#whisperFp16 = whisperFp16;
  }

  #resolveFfmpeg() {
    if (this.#resolvedFfmpeg && fs.existsSync(this.#resolvedFfmpeg)) {
      return this.#resolvedFfmpeg;
    }
    const resolved = resolveExecutable(this.#ffmpegCommand);
    this.#resolvedFfmpeg = resolved;
    return resolved;
  }

  #resolveWhisper() {
    if (this.#resolvedWhisper && fs.existsSync(this.#resolvedWhisper)) {
      return this.#resolvedWhisper;
    }
    const resolved = resolveExecutable(this.#whisperCommand);
    this.#resolvedWhisper = resolved;
    return resolved;
  }

  dependencyStatus() {
    const status = {
      ok: true,
      ffmpeg: "ok",
      whisper: "ok",
    };

    try {
      this.#resolveFfmpeg();
    } catch (error) {
      status.ok = false;
      status.ffmpeg = error.message;
    }

    try {
      this.#resolveWhisper();
    } catch (error) {
      status.ok = false;
      status.whisper = error.message;
    }

    return status;
  }

  settings() {
    return {
      model: this.#whisperModel,
      task: this.#whisperTask,
      language: this.#whisperLanguage || "",
      device: this.#whisperDevice,
      timeoutMs: this.#whisperTimeoutMs,
      fp16: this.#whisperFp16,
    };
  }

  async transcribe({ inputPath, workingDir }) {
    if (!inputPath || !workingDir) {
      throw new Error("Both inputPath and workingDir are required for transcription.");
    }

    if (!fs.existsSync(inputPath) || !fs.statSync(inputPath).isFile()) {
      throw new Error(`Audio input does not exist: ${inputPath}`);
    }

    if (!fs.existsSync(workingDir) || !fs.statSync(workingDir).isDirectory()) {
      throw new Error(`Working directory does not exist: ${workingDir}`);
    }

    const ffmpegExecutable = this.#resolveFfmpeg();
    const whisperExecutable = this.#resolveWhisper();

    const normalizedPath = path.join(workingDir, "normalized-16k.wav");
    await runProcess(
      ffmpegExecutable,
      [
        "-y",
        "-i",
        inputPath,
        "-ar",
        "16000",
        "-ac",
        "1",
        normalizedPath,
      ],
      {
        cwd: workingDir,
        timeoutMs: this.#whisperTimeoutMs,
      },
    );

    const whisperArgs = [
      normalizedPath,
      "--model",
      this.#whisperModel,
      "--task",
      this.#whisperTask,
      "--output_format",
      "json",
      "--output_dir",
      workingDir,
      "--verbose",
      "False",
      "--fp16",
      this.#whisperFp16 ? "True" : "False",
    ];
    if (this.#whisperLanguage) {
      whisperArgs.push("--language", this.#whisperLanguage);
    }
    if (this.#whisperDevice && this.#whisperDevice !== "auto") {
      whisperArgs.push("--device", this.#whisperDevice);
    }

    await runProcess(whisperExecutable, whisperArgs, {
      cwd: workingDir,
      timeoutMs: this.#whisperTimeoutMs,
    });

    const outputJsonPath = path.join(workingDir, `${path.parse(normalizedPath).name}.json`);
    if (!fs.existsSync(outputJsonPath)) {
      throw new Error("Whisper did not produce JSON output.");
    }

    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(outputJsonPath, "utf8"));
    } catch (error) {
      throw new Error(`Failed to parse Whisper JSON output: ${error.message}`);
    }

    return {
      text: typeof parsed?.text === "string" ? parsed.text.trim() : "",
      language: typeof parsed?.language === "string" ? parsed.language : "",
      durationSeconds: inferDurationSeconds(parsed),
      model: this.#whisperModel,
      task: this.#whisperTask,
    };
  }
}
