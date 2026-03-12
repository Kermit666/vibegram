# Contributing

Thanks for contributing to Telegram Codex Remote.

## Development setup

1. Use Node.js 20 or newer.
2. Install dependencies:
   ```powershell
   npm install
   ```
3. Create local config:
   ```powershell
   Copy-Item .env.example .env
   ```
4. Fill `.env` with your own values (never commit secrets).

## Run locally

- Start once:
  ```powershell
  npm start
  ```
- Watch mode:
  ```powershell
  npm run dev
  ```

## Code guidelines

- Keep modules focused and avoid large mixed-responsibility functions.
- Preserve existing naming and formatting style.
- Prefer small, targeted changes over broad refactors.
- Update docs when behavior or commands change.

## Validation before PR

- Syntax check changed JS files:
  ```powershell
  node --check .\src\index.js
  ```
- Start the bot and verify at least:
  - `/help` reflects your command changes.
  - command menu entries match runtime behavior.
  - core flows still work (`/start_codex`, `/resume_thread`, normal prompt forwarding).

## Security and privacy

- Never commit `.env`, tokens, chat IDs, or private logs.
- Treat this bot as remote control access to your machine.
- Keep `TELEGRAM_ALLOWED_CHAT_IDS` strict.

## Pull request checklist

- Describe the user-visible change.
- Include any migration/config notes.
- Mention manual test steps and results.
- Keep unrelated edits out of the PR.
