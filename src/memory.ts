import { dirname } from "node:path";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { logger } from "./logger.js";

export type MemoryRole = "user" | "assistant";

export type MemoryMessage = {
  role: MemoryRole;
  authorId: string;
  authorName: string;
  content: string;
  createdAt: number;
};

export type AutoPostMode = "chat" | "image" | "both";

export type AutoPostConfig = {
  enabled: boolean;
  mode: AutoPostMode;
  intervalMs: number;
  prompt: string;
  aspectRatio: string;
  nextRunAt: number;
  updatedBy: string;
  updatedAt: number;
};

type MemoryFile = {
  version: 1;
  channels: Record<string, MemoryMessage[]>;
  autoposts?: Record<string, AutoPostConfig>;
};

export class MemoryStore {
  private readonly channels = new Map<string, MemoryMessage[]>();
  private readonly autoposts = new Map<string, AutoPostConfig>();
  private saveQueue = Promise.resolve();

  constructor(
    private readonly path: string,
    private readonly maxMessages: number
  ) {}

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.path, "utf8");
      const parsed = JSON.parse(raw) as Partial<MemoryFile>;
      if (parsed.version !== 1 || typeof parsed.channels !== "object" || !parsed.channels) {
        throw new Error("unsupported memory file format");
      }
      for (const [channelId, messages] of Object.entries(parsed.channels)) {
        if (Array.isArray(messages)) {
          this.channels.set(channelId, messages.filter(isMemoryMessage).slice(-this.maxMessages));
        }
      }
      for (const [channelId, autopost] of Object.entries(parsed.autoposts ?? {})) {
        if (isAutoPostConfig(autopost)) this.autoposts.set(channelId, autopost);
      }
      logger.info("memory loaded", { path: this.path, channels: this.channels.size });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        logger.info("memory file not found, starting empty", { path: this.path });
        return;
      }
      throw error;
    }
  }

  remember(channelId: string, message: Omit<MemoryMessage, "createdAt"> & { createdAt?: number }): void {
    if (this.maxMessages === 0) return;
    const messages = this.channels.get(channelId) ?? [];
    messages.push({ ...message, content: compactContent(message.content), createdAt: message.createdAt ?? Date.now() });
    this.channels.set(channelId, messages.slice(-this.maxMessages));
    this.queueSave();
  }

  get(channelId: string): MemoryMessage[] {
    return [...(this.channels.get(channelId) ?? [])];
  }

  reset(channelId: string): void {
    this.channels.delete(channelId);
    this.queueSave();
  }

  setAutoPost(channelId: string, config: AutoPostConfig): void {
    this.autoposts.set(channelId, config);
    this.queueSave();
  }

  getAutoPost(channelId: string): AutoPostConfig | undefined {
    const config = this.autoposts.get(channelId);
    return config ? { ...config } : undefined;
  }

  disableAutoPost(channelId: string): void {
    const current = this.autoposts.get(channelId);
    if (current) this.autoposts.set(channelId, { ...current, enabled: false, updatedAt: Date.now() });
    else this.autoposts.delete(channelId);
    this.queueSave();
  }

  dueAutoPosts(now = Date.now()): Array<[string, AutoPostConfig]> {
    return [...this.autoposts.entries()].filter(([, config]) => config.enabled && config.nextRunAt <= now);
  }

  scheduleNextAutoPost(channelId: string, now = Date.now(), jitterPercent = 0): void {
    const current = this.autoposts.get(channelId);
    if (!current) return;
    const jitterMs = Math.round(current.intervalMs * (jitterPercent / 100));
    const jitter = jitterMs > 0 ? Math.round((Math.random() * 2 - 1) * jitterMs) : 0;
    const delay = Math.max(60_000, current.intervalMs + jitter);
    this.autoposts.set(channelId, { ...current, nextRunAt: now + delay });
    this.queueSave();
  }

  nextAutoPostAt(): number | undefined {
    const nextRuns = [...this.autoposts.values()]
      .filter((config) => config.enabled)
      .map((config) => config.nextRunAt);
    return nextRuns.length > 0 ? Math.min(...nextRuns) : undefined;
  }

  async flush(): Promise<void> {
    await this.saveQueue;
  }

  private queueSave(): void {
    this.saveQueue = this.saveQueue
      .then(() => this.save())
      .catch((error) => logger.error("failed to save memory", error));
  }

  private async save(): Promise<void> {
    const payload: MemoryFile = {
      version: 1,
      channels: Object.fromEntries(this.channels),
      autoposts: Object.fromEntries(this.autoposts)
    };
    await mkdir(dirname(this.path), { recursive: true });
    const tempPath = `${this.path}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    await rename(tempPath, this.path);
  }
}

function compactContent(content: string): string {
  return content.replace(/\s+/g, " ").trim().slice(0, 2000);
}

function isMemoryMessage(value: unknown): value is MemoryMessage {
  const maybe = value as Partial<MemoryMessage>;
  return (
    (maybe.role === "user" || maybe.role === "assistant") &&
    typeof maybe.authorId === "string" &&
    typeof maybe.authorName === "string" &&
    typeof maybe.content === "string" &&
    typeof maybe.createdAt === "number"
  );
}

function isAutoPostConfig(value: unknown): value is AutoPostConfig {
  const maybe = value as Partial<AutoPostConfig>;
  return (
    typeof maybe.enabled === "boolean" &&
    (maybe.mode === "chat" || maybe.mode === "image" || maybe.mode === "both") &&
    typeof maybe.intervalMs === "number" &&
    typeof maybe.prompt === "string" &&
    typeof maybe.aspectRatio === "string" &&
    typeof maybe.nextRunAt === "number" &&
    typeof maybe.updatedBy === "string" &&
    typeof maybe.updatedAt === "number"
  );
}
