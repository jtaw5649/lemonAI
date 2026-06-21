# lemonAI

Discord chat and image generation bot powered by OpenRouter free models and Pollinations.

Built to be a chaotic shitposting/troll bot without being a moderation nightmare: it roasts, riffs, and memes, but the system prompt blocks doxxing, slurs, targeted harassment, self-harm encouragement, sexual minors content, and illegal instructions.

## Features

- `/chat` for OpenRouter-powered replies.
- `/image` for Pollinations image generation.
- Mention/name-triggered replies when `AUTO_REPLY_ENABLED=true`.
- Per-channel rolling memory saved to `data/memory.json`.
- Per-user, per-channel, and image cooldowns.
- Slash command deploy script for guild or global commands.
- Dockerfile for production deploys.

## Discord Setup

1. Create a Discord application at `https://discord.com/developers/applications`.
2. Add a bot and copy the bot token into `DISCORD_TOKEN`.
3. Copy the application ID into `DISCORD_CLIENT_ID`.
4. Enable `MESSAGE CONTENT INTENT` if you want mention/name-triggered replies.
5. Invite the bot with scopes `bot` and `applications.commands`.
6. Bot permissions needed: `Send Messages`, `Use Slash Commands`, `Attach Files`, `Read Message History`.

## OpenRouter Setup

Create an OpenRouter API key and set `OPENROUTER_API_KEY`. The bot defaults to:

- Chat base URL: `https://openrouter.ai/api/v1`
- Chat model: `openrouter/free`

Override `OPENROUTER_MODEL` with any OpenRouter `:free` model if you want a specific one.

## Pollinations Setup

Images work anonymously through `https://image.pollinations.ai/prompt`, but anonymous mode is slower and may watermark images. Optional: set `POLLINATIONS_TOKEN` from `https://auth.pollinations.ai` for higher limits.

## Run Locally

```bash
npm install
cp .env.example .env
npm run deploy:commands
npm run dev
```

Use `DISCORD_GUILD_ID` during setup so slash command changes appear immediately. Remove it and run `npm run deploy:commands` again when you want global commands.

## Production

```bash
npm ci
npm run build
npm run start
```

## Docker

```bash
docker build -t lemonai .
docker run --env-file .env -v "$(pwd)/data:/app/data" lemonai
```

## Commands

- `/chat prompt:<text> private:<true|false>`: ask lemonAI something.
- `/image prompt:<text> aspect_ratio:<optional>`: generate an image.
- `/reset`: clear the current channel memory.
- `/help`: show quick usage.

## Channel Controls

Set `ALLOWED_CHANNEL_IDS` to a comma-separated list to restrict the bot to specific channels. Set `IGNORED_CHANNEL_IDS` to block channels. Ignored channels win.

## Notes

- No test files are included.
- Do not commit `.env` or `data/`.
- If `/chat` fails immediately, `OPENROUTER_API_KEY` is missing or invalid.
- If `/image` rate-limits, either wait or add `POLLINATIONS_TOKEN`.
