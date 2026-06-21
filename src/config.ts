import "dotenv/config";
import process from "node:process";

export type LogLevel = "debug" | "info" | "warn" | "error";

export type BotConfig = {
  botName: string;
  discordToken: string;
  discordClientId: string;
  discordGuildId?: string;
  openRouterApiKey?: string;
  openRouterBaseUrl: string;
  openRouterModel: string;
  openRouterFallbackModels: string[];
  openRouterVisionModel: string;
  openRouterVisionFallbackModels: string[];
  openRouterSiteUrl?: string;
  openRouterAppName: string;
  openCodeGoApiKey?: string;
  openCodeGoBaseUrl: string;
  openCodeGoModel: string;
  openCodeGoFallbackModels: string[];
  openCodeGoVisionModel?: string;
  openCodeGoVisionFallbackModels: string[];
  pollinationsToken?: string;
  pollinationsUseToken: boolean;
  pollinationsNoLogo: boolean;
  pollinationsImageBaseUrl: string;
  pollinationsImageModel: string;
  autoReplyEnabled: boolean;
  allowedChannelIds: Set<string>;
  ignoredChannelIds: Set<string>;
  memoryPath: string;
  maxHistoryMessages: number;
  maxResponseChars: number;
  chatTemperature: number;
  chatMaxTokens: number;
  userCooldownMs: number;
  channelCooldownMs: number;
  imageCooldownMs: number;
  imageAspectRatio: string;
  imageWidth: number;
  imageHeight: number;
  imageTimeoutMs: number;
  autoPostJitterPercent: number;
  autoPostMaxLateMs: number;
  logLevel: LogLevel;
};

const logLevels = new Set<LogLevel>(["debug", "info", "warn", "error"]);

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optional(name: string, fallback: string): string {
  const value = process.env[name]?.trim();
  return value ? value : fallback;
}

function optionalUndefined(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function intEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function numberEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number.parseFloat(raw);
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${name} must be a number between ${min} and ${max}`);
  }
  return value;
}

function boolEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  throw new Error(`${name} must be true or false`);
}

function csvEnv(name: string): Set<string> {
  const values = process.env[name]
    ?.split(",")
    .map((value) => value.trim())
    .filter(Boolean) ?? [];
  return new Set(values);
}

function csvListEnv(name: string): string[] {
  return [...csvEnv(name)];
}

function logLevelEnv(): LogLevel {
  const raw = optional("LOG_LEVEL", "info").toLowerCase() as LogLevel;
  if (!logLevels.has(raw)) {
    throw new Error("LOG_LEVEL must be debug, info, warn, or error");
  }
  return raw;
}

function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

export const config: BotConfig = {
  botName: optional("BOT_NAME", "lemonAI"),
  discordToken: required("DISCORD_TOKEN"),
  discordClientId: required("DISCORD_CLIENT_ID"),
  discordGuildId: optionalUndefined("DISCORD_GUILD_ID"),
  openRouterApiKey: optionalUndefined("OPENROUTER_API_KEY"),
  openRouterBaseUrl: normalizeBaseUrl(optional("OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1")),
  openRouterModel: optional("OPENROUTER_MODEL", "openrouter/free"),
  openRouterFallbackModels: csvListEnv("OPENROUTER_FALLBACK_MODELS"),
  openRouterVisionModel: optional("OPENROUTER_VISION_MODEL", "nvidia/nemotron-nano-12b-v2-vl:free"),
  openRouterVisionFallbackModels: csvListEnv("OPENROUTER_VISION_FALLBACK_MODELS"),
  openRouterSiteUrl: optionalUndefined("OPENROUTER_SITE_URL"),
  openRouterAppName: optional("OPENROUTER_APP_NAME", "lemonAI"),
  openCodeGoApiKey: optionalUndefined("OPENCODE_GO_API_KEY"),
  openCodeGoBaseUrl: normalizeBaseUrl(optional("OPENCODE_GO_BASE_URL", "https://opencode.ai/zen/go/v1")),
  openCodeGoModel: optional("OPENCODE_GO_MODEL", "mimo-v2.5-pro"),
  openCodeGoFallbackModels: csvListEnv("OPENCODE_GO_FALLBACK_MODELS"),
  openCodeGoVisionModel: optionalUndefined("OPENCODE_GO_VISION_MODEL"),
  openCodeGoVisionFallbackModels: csvListEnv("OPENCODE_GO_VISION_FALLBACK_MODELS"),
  pollinationsToken: optionalUndefined("POLLINATIONS_TOKEN"),
  pollinationsUseToken: boolEnv("POLLINATIONS_USE_TOKEN", false),
  pollinationsNoLogo: boolEnv("POLLINATIONS_NOLOGO", false),
  pollinationsImageBaseUrl: normalizeBaseUrl(optional("POLLINATIONS_IMAGE_BASE_URL", "https://image.pollinations.ai/prompt")),
  pollinationsImageModel: optional("POLLINATIONS_IMAGE_MODEL", "turbo"),
  autoReplyEnabled: boolEnv("AUTO_REPLY_ENABLED", true),
  allowedChannelIds: csvEnv("ALLOWED_CHANNEL_IDS"),
  ignoredChannelIds: csvEnv("IGNORED_CHANNEL_IDS"),
  memoryPath: optional("MEMORY_PATH", "./data/memory.json"),
  maxHistoryMessages: intEnv("MAX_HISTORY_MESSAGES", 24, 0, 80),
  maxResponseChars: intEnv("MAX_RESPONSE_CHARS", 1800, 200, 1900),
  chatTemperature: numberEnv("CHAT_TEMPERATURE", 1, 0, 2),
  chatMaxTokens: intEnv("CHAT_MAX_TOKENS", 650, 32, 4096),
  userCooldownMs: intEnv("USER_COOLDOWN_MS", 6000, 0, 600000),
  channelCooldownMs: intEnv("CHANNEL_COOLDOWN_MS", 2500, 0, 600000),
  imageCooldownMs: intEnv("IMAGE_COOLDOWN_MS", 30000, 0, 3600000),
  imageAspectRatio: optional("IMAGE_ASPECT_RATIO", "1:1"),
  imageWidth: intEnv("IMAGE_WIDTH", 1024, 256, 2048),
  imageHeight: intEnv("IMAGE_HEIGHT", 1024, 256, 2048),
  imageTimeoutMs: intEnv("IMAGE_TIMEOUT_MS", 120000, 10000, 300000),
  autoPostJitterPercent: intEnv("AUTO_POST_JITTER_PERCENT", 20, 0, 90),
  autoPostMaxLateMs: intEnv("AUTO_POST_MAX_LATE_MS", 300000, 0, 86400000),
  logLevel: logLevelEnv()
};

export function redactSecrets(value: unknown): string {
  let text = value instanceof Error ? value.message : String(value);
  for (const secret of [config.discordToken, config.openRouterApiKey, config.openCodeGoApiKey, config.pollinationsToken]) {
    if (secret) text = text.split(secret).join("[redacted]");
  }
  return text;
}
