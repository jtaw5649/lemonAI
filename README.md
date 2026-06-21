# lemonAI

Discord chat, image understanding, and image generation bot powered by Venice.

Built around a dynamic server-wide persona card: remembers channel history, derives aggregate voice/style from quality-filtered human message/media/expression evidence, uses learned media, and can react with Discord-native expressions.

## Features

- `/chat` for Venice Uncensored 1.2-powered replies.
- `/chat image:` and mention/reply image inspection using Venice Uncensored 1.2 vision support.
- `/image` for Venice `lustify-v8` image generation, including `adult:true` for `safe_mode=false` generation.
- `/gif query:` for reposting GIFs learned server-wide without Tenor/Giphy API keys.
- `/emote` and `/sticker` for matching guild-native custom emojis and stickers.
- `/autopost` for scheduled channel chat/image/both posting.
- Low-rate ambient auto reactions/replies via learned GIFs, emojis, stickers, and chat.
- Discord-safe image delivery as file-only image attachments.
- Discord attachment, pasted media URL, and GIF-picker embed recognition.
- Async media caption/tag enrichment for learned images/GIFs/stickers/emojis when a vision model is configured.
- Reaction metadata capture for custom/unicode emoji usage when reaction events are available.
- Dynamic server-wide persona card derived from quality-filtered human memory/media/expression patterns, excluding configured app/user IDs, persisted as compact SQLite metadata.
- Durable per-channel memory archive with deterministic window/day/topic summaries, hybrid retrieval, internal retrieval audit records, and optional startup backfill from Discord history.
- Mention/name-triggered replies when `AUTO_REPLY_ENABLED=true`.
- Reply-to-bot triggered replies when `AUTO_REPLY_ENABLED=true`.
- Per-channel memory, media catalog, and autopost settings saved to SQLite at `data/memory.sqlite`; legacy JSON is kept as an import source/backup.
- Per-user, per-channel, and image cooldowns.
- Slash command deploy script for guild or global commands.
- Dockerfile for production deploys.

## Discord Setup

1. Create a Discord application at `https://discord.com/developers/applications`.
2. Add a bot and copy the bot token into `DISCORD_TOKEN`.
3. Copy the application ID into `DISCORD_CLIENT_ID`.
4. Enable `MESSAGE CONTENT INTENT` if you want mention/name-triggered replies. Enable reaction events/intents if you want reaction usage cataloging.
5. Invite the bot with scopes `bot` and `applications.commands`.
6. Bot permissions needed: `Send Messages`, `Use Slash Commands`, `Attach Files`, `Embed Links`, `Read Message History`, `Add Reactions`, `Use External Emojis`, and `Use External Stickers`.

## Venice Setup

Venice is the only chat, image-understanding, and image-generation backend. It uses OpenAI-compatible chat completions for `venice-uncensored-1-2`, plus Venice's native image generation endpoint for `lustify-v8`.

Set:

```env
VENICE_API_KEY=
VENICE_BASE_URL=https://api.venice.ai/api/v1
VENICE_MODEL=venice-uncensored-1-2
VENICE_IMAGE_MODEL=lustify-v8
VENICE_IMAGE_FORMAT=webp
VENICE_IMAGE_HIDE_WATERMARK=false
VENICE_INCLUDE_SYSTEM_PROMPT=false
```

The bot disables Venice's provider system prompt for chat by default so lemonAI's own system prompt and derived guild persona card remain the only voice/style sources. `VENICE_MODEL=venice-uncensored-1-2` handles chat and explicit image inspection. `VENICE_IMAGE_MODEL=lustify-v8` handles `/image`; `/image adult:true` maps to `safe_mode:false`.

Discord's built-in GIF picker posts GIFs as embeds such as `gifv`, not normal attachments. lemonAI learns usable GIF/image media from attachments, pasted URLs, and embeds as people post them. Discord does not expose the client GIF picker as a bot API, and Tenor API keys are being discontinued, so `/gif query:` searches the saved server media catalog instead of calling Tenor/Giphy. Direct GIF/image URLs still work as a fallback; Tenor/Giphy page links are posted raw so Discord can unfurl them.

## Run Locally

```bash
npm install
cp .env.example .env
npm run deploy:commands
npm run dev
```

Use `DISCORD_GUILD_ID` during setup so slash command changes appear immediately. Remove it and run `npm run deploy:commands` again when you want global commands.

Memory knobs:

```env
MEMORY_DB_PATH=./data/memory.sqlite
MEMORY_JSON_IMPORT_PATH=./data/memory.json
MAX_HISTORY_MESSAGES=24
MAX_MEMORY_MESSAGES=100000
MEMORY_RECALL_MESSAGES=16
MEMORY_SUMMARY_ENABLED=true
MEMORY_SUMMARY_WINDOW_MESSAGES=80
MEMORY_SUMMARY_DAILY=true
MEMORY_SUMMARY_TOPICS=true
MEMORY_SUMMARY_TOPIC_MIN_MESSAGES=3
MEMORY_SUMMARY_STARTUP_CHANNELS=8
PERSONA_EXCLUDED_AUTHOR_IDS=974297735559806986,1518064151832821890
BACKFILL_ENABLED=false
MEMORY_BACKFILL_MESSAGES=2000
BACKFILL_ALL_CHANNELS=false
MEDIA_CACHE_PATH=./data/media
MEDIA_CACHE_MAX_BYTES=1073741824
MEDIA_MAX_DOWNLOAD_BYTES=8388608
MEDIA_UPLOAD_MAX_BYTES=8388608
MEDIA_VALIDATION_TIMEOUT_MS=5000
MEDIA_ANALYSIS_ENABLED=false
MEDIA_ANALYSIS_CONCURRENCY=1
MEDIA_ANALYSIS_MAX_PER_HOUR=5
MEDIA_ANALYSIS_MAX_BYTES=4194304
MEDIA_ANALYSIS_QUEUE_MAX=25
MEDIA_ANALYSIS_MAX_ATTEMPTS=1
AMBIENT_EXPRESSION_CHANCE=0.03
AMBIENT_REPLY_CHANCE=0.02
```

Chat sampling defaults mirror Venice web chat defaults:

```env
CHAT_TEMPERATURE=0.7
CHAT_TOP_P=0.9
CHAT_MAX_TOKENS=650
```

`MEMORY_DB_PATH` is the active SQLite store. `MEMORY_JSON_IMPORT_PATH` points to the legacy JSON file imported on first SQLite startup or when the database is missing stored messages/media/autoposts; the JSON file is not deleted or written as active storage. `MAX_HISTORY_MESSAGES` is the recent chat window sent directly to the model. `MAX_MEMORY_MESSAGES` is the persisted archive cap. `MEMORY_RECALL_MESSAGES` controls how many older relevant rows are retrieved into the compact evidence block. `MEMORY_SUMMARY_*` controls deterministic extractive summaries written to `summary_chunks`: fixed message windows, UTC daily channel summaries, and recurring topic chunks with source message IDs, timestamps, participants, tags, and importance. Summary work is bounded on startup and after writes; summaries are retrieved before raw old-message citations. Retrieval also records bounded internal audit rows for tuning. `PERSONA_EXCLUDED_AUTHOR_IDS` is a comma-separated list of Discord author IDs excluded from server persona card training; GenAi `974297735559806986` and lemonAI `1518064151832821890` are excluded by default even if the variable is omitted. The server persona card is rebuilt lazily from quality-filtered human messages and stored as compact aggregate metadata with source message IDs, not raw quotes. `BACKFILL_ENABLED=false` skips startup history import entirely. Set `BACKFILL_ENABLED=true` plus `MEMORY_BACKFILL_MESSAGES` to import recent Discord history; backfill uses `ALLOWED_CHANNEL_IDS`, and if no allowlist is set, `BACKFILL_ALL_CHANNELS=true` is also required to opt into all-channel backfill. `MEDIA_CACHE_*` controls validated local media files and byte caps. `MEDIA_ANALYSIS_*` controls the optional async caption/tag analyzer for newly observed media; it is disabled by default so background image recognition cannot consume Venice quota unless you opt in. Server-side media fetch/validation is limited to known media/CDN hosts; unknown pasted URLs are stored and sent raw instead of fetched by the bot. Learned GIF/emoji/sticker/media reuse is server-wide within the guild, with send success/failure and recent-use scoring.

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

- `/chat prompt:<text> image:<optional> private:<true|false>`: ask lemonAI something, optionally with an image.
- Reply to an image/GIF with `@lemonAI is this ai?` to inspect it.
- `/image prompt:<text> aspect_ratio:<optional> adult:<optional>`: generate an image.
- `/gif query:<text-or-url>`: post a matching learned GIF, or a direct GIF/image URL.
- `/emote query:<text>`: post a matching guild custom emoji, or pass a direct Unicode emoji.
- `/sticker query:<text>`: post a matching guild sticker.
- Reply with `lemonai react <query>`: react to that message with a matching guild emoji or direct Unicode emoji.
- `/autopost set mode:<chat|image|both> interval_minutes:<number> prompt:<optional> aspect_ratio:<optional>`: schedule channel posts.
- `/autopost status`: show this channel's schedule.
- `/autopost off`: disable this channel's schedule.
- `/help`: show quick usage.

Autopost uses persisted `nextRunAt` timestamps in SQLite, one-shot scheduler wakeups, jitter, and stale-job skipping. It does not run a blind fixed interval loop.

## Channel Controls

Set `ALLOWED_CHANNEL_IDS` to a comma-separated list to restrict the bot to specific channels. Set `IGNORED_CHANNEL_IDS` to block channels. Ignored channels win.

## Notes

- No test files are included.
- Do not commit `.env` or `data/`.
- If `/chat` fails immediately, `VENICE_API_KEY` is missing or invalid.
- If `/image` rate-limits, wait for the Venice image limit window to reset.
