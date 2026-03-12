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

## Main Environment Variables

- `TELEGRAM_BOT_TOKEN`: token from BotFather.
- `TELEGRAM_ALLOWED_CHAT_IDS`: comma-separated Telegram chat IDs allowed to use the bot.
- `CODEX_COMMAND`: `codex` (or full path to your Codex executable).
- `CODEX_WORKDIR`: default directory where Codex runs.
- `CODEX_EXTRA_ARGS`: JSON array of extra top-level Codex arguments.
- `REPO_PATH_PROMPT_TIMEOUT_MS`: timeout for repo-path prompt flow in ms.
- `TELEGRAM_MENU_WEBAPP_URL`: optional HTTPS mini-app URL for the chat menu button.
