# lemonAI

Discord chat and image generation bot powered by OpenCode Go/OpenRouter chat and Pollinations images.

Built to be a chaotic shitposting/troll bot without being a moderation nightmare: it roasts, riffs, and memes, but the system prompt blocks doxxing, slurs, targeted harassment, self-harm encouragement, sexual minors content, and illegal instructions.

## Features

- `/chat` for OpenCode Go-powered replies with OpenRouter fallback.
- `/chat image:` and mention/reply image inspection using vision models.
- `/image` for Pollinations image generation, including `adult:true` for `safe=false/private=true` generation.
- `/gif url:` for posting GIF/image URLs without Tenor/Giphy API keys.
- `/autopost` for scheduled channel chat/image/both posting.
- Discord-safe image delivery as file-only image attachments.
- Discord attachment, pasted media URL, and GIF-picker embed recognition.
- Dynamic per-channel style telemetry from recent memory, used for cadence only and not persisted separately.
- Mention/name-triggered replies when `AUTO_REPLY_ENABLED=true`.
- Reply-to-bot triggered replies when `AUTO_REPLY_ENABLED=true`.
- Per-channel rolling memory saved to `data/memory.json`.
- Per-channel autopost settings saved to `data/memory.json`.
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

## OpenCode Go Setup

OpenCode Go is the primary chat backend. It uses an OpenAI-compatible endpoint and does not provide image generation in the docs/model catalogs checked.

Set:

```env
OPENCODE_GO_API_KEY=
OPENCODE_GO_BASE_URL=https://opencode.ai/zen/go/v1
OPENCODE_GO_MODEL=mimo-v2.5-pro
OPENCODE_GO_FALLBACK_MODELS=qwen3.7-plus,minimax-m3,glm-5.2
OPENCODE_GO_VISION_MODEL=
OPENCODE_GO_VISION_FALLBACK_MODELS=
```

OpenCode Go stays the final chat/persona voice. If you configure `OPENCODE_GO_VISION_MODEL`, it is tried first for image/GIF understanding. Otherwise OpenRouter vision provides visual facts and OpenCode Go writes the final reply.

## OpenRouter Setup

OpenRouter remains the fallback if OpenCode Go fails or rate-limits. Create an OpenRouter API key and set `OPENROUTER_API_KEY`. The bot defaults to:

- Chat base URL: `https://openrouter.ai/api/v1`
- Chat model: `openrouter/free`

Override `OPENROUTER_MODEL` with any OpenRouter `:free` model if you want a specific fallback.

Vision fallback defaults to `OPENROUTER_VISION_MODEL=nvidia/nemotron-nano-12b-v2-vl:free`. OpenRouter supports image URLs/base64 and content types including `image/gif`; Discord attachments, pasted GIF/image URLs, and GIF-picker embeds are passed through when available.

## Pollinations Setup

Images work anonymously through `https://image.pollinations.ai/prompt`. The bot downloads the generated image and sends it as a Discord file attachment, so `/image` returns just the image with no prompt text or embed wrapper. Set `adult:true` to use Pollinations `safe=false` and `private=true`. Optional: set `POLLINATIONS_TOKEN`, `POLLINATIONS_USE_TOKEN=true`, and `POLLINATIONS_NOLOGO=true` from `https://auth.pollinations.ai` for authenticated/no-logo attempts; anonymous turbo/flux fallbacks remain enabled for reliability.

Discord's built-in GIF picker posts GIFs as embeds such as `gifv`, not normal attachments. lemonAI can inspect those embeds when replying/mentioning. Discord does not expose the client GIF picker as a bot API, and Tenor API keys are being discontinued, so `/gif` accepts a URL instead of doing API search. Direct GIF/image URLs are sent as embeds; Tenor/Giphy page links are posted raw so Discord can unfurl them.

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

- `/chat prompt:<text> image:<optional> private:<true|false>`: ask lemonAI something, optionally with an image.
- Reply to an image/GIF with `@lemonAI is this ai?` to inspect it.
- `/image prompt:<text> aspect_ratio:<optional> adult:<optional>`: generate an image.
- `/gif url:<gif-or-image-url>`: post a GIF/image URL.
- `/autopost set mode:<chat|image|both> interval_minutes:<number> prompt:<optional> aspect_ratio:<optional>`: schedule channel posts.
- `/autopost status`: show this channel's schedule.
- `/autopost off`: disable this channel's schedule.
- `/reset`: clear the current channel memory.
- `/help`: show quick usage.

Autopost uses persisted `nextRunAt` timestamps in `data/memory.json`, one-shot scheduler wakeups, jitter, and stale-job skipping. It does not run a blind fixed interval loop.

## Channel Controls

Set `ALLOWED_CHANNEL_IDS` to a comma-separated list to restrict the bot to specific channels. Set `IGNORED_CHANNEL_IDS` to block channels. Ignored channels win.

## Notes

- No test files are included.
- Do not commit `.env` or `data/`.
- If `/chat` fails immediately, `OPENROUTER_API_KEY` is missing or invalid.
- If `/image` rate-limits, either wait or add `POLLINATIONS_TOKEN`.
