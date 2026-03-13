# VibeGram

**Vibe code from anywhere, on Telegram.**

VibeGram runs on your machine and bridges Telegram messages to your local `codex` CLI session. You can start, stop, resume, and control Codex remotely from Telegram, while access is restricted to chat IDs you explicitly allow.

## How It Works

- You send a command or message to your Telegram bot.
- VibeGram checks that your chat ID is in `TELEGRAM_ALLOWED_CHAT_IDS`.
- If authorized, it forwards your prompt into a local Codex session.
- Codex output is streamed back into Telegram.

This is remote control of your local environment, so token and chat-ID security matter.

## Setup

### 1) Requirements

- Node.js 20+
- A working local `codex` CLI install and login
- A Telegram account
- `ffmpeg` available in your PATH (required for voice notes)
- Python 3.10+ with `openai-whisper` installed (required for voice notes)

### 2) Create your Telegram bot (BotFather)

1. Open Telegram and search for `@BotFather`.
2. Send `/newbot`.
3. Choose a bot name and username.
4. Copy the token BotFather gives you.

You will use that token as `TELEGRAM_BOT_TOKEN`.

### 3) Create `.env`

```powershell
Copy-Item .env.example .env
```

### 4) Add your bot token to `.env`

Set:

```env
TELEGRAM_BOT_TOKEN=your_botfather_token_here
```

### 5) Add your chat ID to `.env`

`TELEGRAM_ALLOWED_CHAT_IDS` is an allowlist of chats allowed to control your local Codex session.  
We need it so random Telegram users cannot run commands on your machine through your bot.

If you do not know your chat ID:

1. Launch the app once (see "Launch VibeGram" below).
2. Open your bot in Telegram.
3. Send `/chatid` to the bot.
4. Copy the returned number.

Then set it in `.env`:

```env
TELEGRAM_ALLOWED_CHAT_IDS=123456789
```

For multiple allowed chats, use comma-separated IDs:

```env
TELEGRAM_ALLOWED_CHAT_IDS=123456789,987654321
```

### 6) Recommended `CODEX_EXTRA_ARGS` (powerful but risky)

Recommended for best behavior with this app:

```env
CODEX_EXTRA_ARGS=["--dangerously-bypass-approvals-and-sandbox","--search"]
```

Important risk:

- `--dangerously-bypass-approvals-and-sandbox` removes important safety barriers.
- Codex can execute commands and modify files without approval prompts.
- If someone unauthorized gets access to your bot/chat, impact can be high.

Why still recommended here:

- VibeGram was developed and tested with this mode, so command flows are smoother.
- The default `.env.example` does not force this setting so you can opt in consciously.

### 7) Optional: enable Telegram voice notes via Whisper

Voice note flow:

- Send a Telegram voice note to your bot.
- VibeGram downloads the audio, runs Whisper transcription locally, then forwards the transcript to Codex.

Install Whisper once:

```powershell
python -m pip install -U openai-whisper
```

Set these env vars (defaults are already in `.env.example`):

```env
VOICE_TO_CODEX_ENABLED=true
FFMPEG_COMMAND=ffmpeg
WHISPER_COMMAND=whisper
WHISPER_MODEL=base
WHISPER_DEVICE=auto
WHISPER_TASK=transcribe
```

Useful chat commands:

- `/voice_status` to check config + dependency status.
- `/voice_help` to see usage limits and behavior.

## Launch VibeGram

Install dependencies:

```powershell
npm install
```

Start the bot:

```powershell
npm start
```

Dev mode (auto-restart on file changes):

```powershell
npm run dev
```

## Quick Usage

In Telegram:

- Use `/panel` for the interactive control center.
- Use `/start_codex [path]` to start a session.
- Send plain text messages to forward prompts directly.
- Use `/resume_thread <thread_id> [path]` to continue an old thread.
- Use `/status` to check state.
- Use `/stop_codex` to end the session.
- Use `/help` to see command help.
- Send a voice note to transcribe with Whisper and forward to Codex.

## Whisper Mode (Voice Notes)

Use this mode when you want to talk to Codex instead of typing.

### Telegram flow

1. Start a Codex session with `/start_codex`.
2. Send a voice note in the same chat.
3. The bot updates one status message through these steps:
   - `Voice note received.`
   - `Status: Downloading audio...`
   - `Status: Transcribing voice note...`
   - `Transcript ready (...)` + preview
4. After that, the transcript is forwarded to Codex automatically.
5. Codex response is returned in chat like normal text requests.

### Useful commands

- `/voice_status`: show current Whisper config and dependency status.
- `/voice_help`: show voice usage and limits.

### Performance tips

- CPU mode: `WHISPER_DEVICE=cpu` and usually `WHISPER_FP16=false`
- GPU mode (recommended if available): `WHISPER_DEVICE=cuda` and `WHISPER_FP16=true`
- Faster but less accurate: `WHISPER_MODEL=tiny`
- Better accuracy but slower: `WHISPER_MODEL=base` or higher

### Notes

- Voice processing only works for authorized chat IDs in `TELEGRAM_ALLOWED_CHAT_IDS`.
- Temporary voice files are stored in OS temp and cleaned after processing.
- If Codex is busy or stopped, the bot will tell you instead of queueing voice transcription.

## Main Environment Variables

- `TELEGRAM_BOT_TOKEN`: token from BotFather.
- `TELEGRAM_ALLOWED_CHAT_IDS`: comma-separated Telegram chat IDs allowed to use the bot.
- `CODEX_COMMAND`: `codex` (or full path to your Codex executable).
- `CODEX_WORKDIR`: default directory where Codex runs.
- `CODEX_EXTRA_ARGS`: JSON array of extra top-level Codex arguments.
- `VOICE_TO_CODEX_ENABLED`: enable/disable voice-note transcription flow.
- `VOICE_MAX_DURATION_SECONDS`: reject voice notes longer than this.
- `VOICE_MAX_FILE_BYTES`: reject files larger than this limit.
- `VOICE_TEMP_DIR`: optional temp directory for downloaded/converted audio artifacts.
- `FFMPEG_COMMAND`: `ffmpeg` executable (or full path).
- `WHISPER_COMMAND`: `whisper` executable (or full path).
- `WHISPER_MODEL`: Whisper model name (for example `tiny`, `base`, `small`).
- `WHISPER_LANGUAGE`: optional language hint, empty means auto-detect.
- `WHISPER_DEVICE`: `auto`, `cpu`, or `cuda`.
- `WHISPER_TASK`: `transcribe` or `translate`.
- `WHISPER_TIMEOUT_MS`: timeout for ffmpeg/whisper steps.
- `WHISPER_FP16`: whether to run Whisper with fp16 (`false` is safer on CPU).
- `REPO_PATH_PROMPT_TIMEOUT_MS`: timeout for repo-path prompt flow in ms.
- `TELEGRAM_MENU_WEBAPP_URL`: optional HTTPS mini-app URL for the chat menu button.
