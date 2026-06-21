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

type MemoryFile = {
  version: 1;
  channels: Record<string, MemoryMessage[]>;
};

export class MemoryStore {
  private readonly channels = new Map<string, MemoryMessage[]>();
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

  async flush(): Promise<void> {
    await this.saveQueue;
  }

  private queueSave(): void {
    this.saveQueue = this.saveQueue
      .then(() => this.save())
      .catch((error) => logger.error("failed to save memory", error));
  }

  private async save(): Promise<void> {
    const payload: MemoryFile = { version: 1, channels: Object.fromEntries(this.channels) };
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
