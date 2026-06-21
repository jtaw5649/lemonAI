import "dotenv/config";
import process from "node:process";

export type LogLevel = "debug" | "info" | "warn" | "error";

export type BotConfig = {
  botName: string;
  discordToken: string;
  discordClientId: string;
  discordGuildId?: string;
  veniceApiKey?: string;
  veniceBaseUrl: string;
  veniceModel: string;
  veniceImageModel: string;
  veniceImageFormat: string;
  veniceImageHideWatermark: boolean;
  veniceIncludeSystemPrompt: boolean;
  autoReplyEnabled: boolean;
  allowedChannelIds: Set<string>;
  ignoredChannelIds: Set<string>;
  personaExcludedAuthorIds: Set<string>;
  memoryDbPath: string;
  memoryJsonImportPath: string;
  mediaCachePath: string;
  mediaCacheMaxBytes: number;
  mediaMaxDownloadBytes: number;
  mediaUploadMaxBytes: number;
  mediaValidationTimeoutMs: number;
  mediaAnalysisEnabled: boolean;
  mediaAnalysisConcurrency: number;
  mediaAnalysisMaxPerHour: number;
  mediaAnalysisMaxBytes: number;
  mediaAnalysisQueueMax: number;
  mediaAnalysisMaxAttempts: number;
  maxHistoryMessages: number;
  maxMemoryMessages: number;
  memoryRecallMessages: number;
  memorySummaryEnabled: boolean;
  memorySummaryWindowMessages: number;
  memorySummaryDaily: boolean;
  memorySummaryTopics: boolean;
  memorySummaryTopicMinMessages: number;
  memorySummaryStartupChannels: number;
  backfillEnabled: boolean;
  memoryBackfillMessages: number;
  backfillAllChannels: boolean;
  maxResponseChars: number;
  chatTemperature: number;
  chatTopP: number;
  chatMaxTokens: number;
  userCooldownMs: number;
  channelCooldownMs: number;
  ambientCooldownMs: number;
  expressionCacheTtlMs: number;
  imageCooldownMs: number;
  imageAspectRatio: string;
  imageWidth: number;
  imageHeight: number;
  imageTimeoutMs: number;
  autoPostJitterPercent: number;
  autoPostMaxLateMs: number;
  ambientExpressionChance: number;
  ambientReplyChance: number;
  logLevel: LogLevel;
};

const logLevels = new Set<LogLevel>(["debug", "info", "warn", "error"]);
const defaultPersonaExcludedAuthorIds = ["974297735559806986", "1518064151832821890"];

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

function csvEnv(name: string, defaults: string[] = []): Set<string> {
  const values = process.env[name]
    ?.split(",")
    .map((value) => value.trim())
    .filter(Boolean) ?? [];
  return new Set([...defaults, ...values]);
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
  veniceApiKey: optionalUndefined("VENICE_API_KEY"),
  veniceBaseUrl: normalizeBaseUrl(optional("VENICE_BASE_URL", "https://api.venice.ai/api/v1")),
  veniceModel: optional("VENICE_MODEL", "venice-uncensored-1-2"),
  veniceImageModel: optional("VENICE_IMAGE_MODEL", "lustify-v8"),
  veniceImageFormat: optional("VENICE_IMAGE_FORMAT", "webp"),
  veniceImageHideWatermark: boolEnv("VENICE_IMAGE_HIDE_WATERMARK", false),
  veniceIncludeSystemPrompt: boolEnv("VENICE_INCLUDE_SYSTEM_PROMPT", false),
  autoReplyEnabled: boolEnv("AUTO_REPLY_ENABLED", true),
  allowedChannelIds: csvEnv("ALLOWED_CHANNEL_IDS"),
  ignoredChannelIds: csvEnv("IGNORED_CHANNEL_IDS"),
  personaExcludedAuthorIds: csvEnv("PERSONA_EXCLUDED_AUTHOR_IDS", defaultPersonaExcludedAuthorIds),
  memoryDbPath: optional("MEMORY_DB_PATH", "./data/memory.sqlite"),
  memoryJsonImportPath: optionalUndefined("MEMORY_JSON_IMPORT_PATH") ?? optional("MEMORY_PATH", "./data/memory.json"),
  mediaCachePath: optional("MEDIA_CACHE_PATH", "./data/media"),
  mediaCacheMaxBytes: intEnv("MEDIA_CACHE_MAX_BYTES", 1073741824, 0, 10737418240),
  mediaMaxDownloadBytes: intEnv("MEDIA_MAX_DOWNLOAD_BYTES", 8388608, 1024, 52428800),
  mediaUploadMaxBytes: intEnv("MEDIA_UPLOAD_MAX_BYTES", 8388608, 1024, 52428800),
  mediaValidationTimeoutMs: intEnv("MEDIA_VALIDATION_TIMEOUT_MS", 5000, 500, 60000),
  mediaAnalysisEnabled: boolEnv("MEDIA_ANALYSIS_ENABLED", false),
  mediaAnalysisConcurrency: intEnv("MEDIA_ANALYSIS_CONCURRENCY", 1, 1, 4),
  mediaAnalysisMaxPerHour: intEnv("MEDIA_ANALYSIS_MAX_PER_HOUR", 5, 0, 1000),
  mediaAnalysisMaxBytes: intEnv("MEDIA_ANALYSIS_MAX_BYTES", 4194304, 1024, 52428800),
  mediaAnalysisQueueMax: intEnv("MEDIA_ANALYSIS_QUEUE_MAX", 25, 0, 10000),
  mediaAnalysisMaxAttempts: intEnv("MEDIA_ANALYSIS_MAX_ATTEMPTS", 1, 1, 20),
  maxHistoryMessages: intEnv("MAX_HISTORY_MESSAGES", 24, 0, 80),
  maxMemoryMessages: intEnv("MAX_MEMORY_MESSAGES", 100000, 0, 1000000),
  memoryRecallMessages: intEnv("MEMORY_RECALL_MESSAGES", 16, 0, 100),
  memorySummaryEnabled: boolEnv("MEMORY_SUMMARY_ENABLED", true),
  memorySummaryWindowMessages: intEnv("MEMORY_SUMMARY_WINDOW_MESSAGES", 80, 10, 500),
  memorySummaryDaily: boolEnv("MEMORY_SUMMARY_DAILY", true),
  memorySummaryTopics: boolEnv("MEMORY_SUMMARY_TOPICS", true),
  memorySummaryTopicMinMessages: intEnv("MEMORY_SUMMARY_TOPIC_MIN_MESSAGES", 3, 2, 20),
  memorySummaryStartupChannels: intEnv("MEMORY_SUMMARY_STARTUP_CHANNELS", 8, 0, 100),
  backfillEnabled: boolEnv("BACKFILL_ENABLED", false),
  memoryBackfillMessages: intEnv("MEMORY_BACKFILL_MESSAGES", 2000, 0, 100000),
  backfillAllChannels: boolEnv("BACKFILL_ALL_CHANNELS", false),
  maxResponseChars: intEnv("MAX_RESPONSE_CHARS", 1800, 200, 1900),
  chatTemperature: numberEnv("CHAT_TEMPERATURE", 0.7, 0, 2),
  chatTopP: numberEnv("CHAT_TOP_P", 0.9, 0, 1),
  chatMaxTokens: intEnv("CHAT_MAX_TOKENS", 650, 32, 4096),
  userCooldownMs: intEnv("USER_COOLDOWN_MS", 3000, 0, 600000),
  channelCooldownMs: intEnv("CHANNEL_COOLDOWN_MS", 1200, 0, 600000),
  ambientCooldownMs: intEnv("AMBIENT_COOLDOWN_MS", 15000, 0, 3600000),
  expressionCacheTtlMs: intEnv("EXPRESSION_CACHE_TTL_MS", 600000, 0, 3600000),
  imageCooldownMs: intEnv("IMAGE_COOLDOWN_MS", 30000, 0, 3600000),
  imageAspectRatio: optional("IMAGE_ASPECT_RATIO", "1:1"),
  imageWidth: intEnv("IMAGE_WIDTH", 1024, 256, 2048),
  imageHeight: intEnv("IMAGE_HEIGHT", 1024, 256, 2048),
  imageTimeoutMs: intEnv("IMAGE_TIMEOUT_MS", 120000, 10000, 300000),
  autoPostJitterPercent: intEnv("AUTO_POST_JITTER_PERCENT", 20, 0, 90),
  autoPostMaxLateMs: intEnv("AUTO_POST_MAX_LATE_MS", 300000, 0, 86400000),
  ambientExpressionChance: numberEnv("AMBIENT_EXPRESSION_CHANCE", 0.03, 0, 1),
  ambientReplyChance: numberEnv("AMBIENT_REPLY_CHANCE", 0.02, 0, 1),
  logLevel: logLevelEnv()
};

export function redactSecrets(value: unknown): string {
  let text: string;
  if (value instanceof Error) {
    text = value.message;
  } else if (typeof value === "object" && value !== null) {
    try {
      text = JSON.stringify(value);
    } catch {
      text = String(value);
    }
  } else {
    text = String(value);
  }
  for (const secret of [config.discordToken, config.veniceApiKey]) {
    if (secret) text = text.split(secret).join("[redacted]");
  }
  return text;
}
