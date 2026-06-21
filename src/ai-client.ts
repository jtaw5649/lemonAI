import OpenAI from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { buildImagePrompt } from "./persona.js";
import type { BotConfig } from "./config.js";
import type { MemoryMessage } from "./memory.js";

type ChatInput = {
  systemPrompt: string;
  prompt: string;
  authorName: string;
  history: MemoryMessage[];
};

export type GeneratedImage = {
  bytes: Buffer;
  filename: string;
  contentType: string;
};

export class AiClient {
  private readonly openai: OpenAI;

  constructor(private readonly config: BotConfig) {
    if (!config.openRouterApiKey) {
      throw new Error("Missing required environment variable: OPENROUTER_API_KEY");
    }
    this.openai = new OpenAI({
      apiKey: config.openRouterApiKey,
      baseURL: config.openRouterBaseUrl,
      defaultHeaders: {
        ...(config.openRouterSiteUrl ? { "HTTP-Referer": config.openRouterSiteUrl } : {}),
        "X-OpenRouter-Title": config.openRouterAppName
      }
    });
  }

  async chat(input: ChatInput): Promise<string> {
    const messages: ChatCompletionMessageParam[] = [
      { role: "system", content: input.systemPrompt },
      ...input.history.map(toChatMessage),
      { role: "user", content: `${input.authorName}: ${input.prompt}` }
    ];

    const completion = await this.openai.chat.completions.create({
      model: this.config.openRouterModel,
      messages,
      temperature: this.config.chatTemperature,
      max_tokens: this.config.chatMaxTokens
    });

    const content = completion.choices[0]?.message?.content?.trim();
    if (!content) throw new Error("OpenRouter returned an empty chat response");
    return content.slice(0, this.config.maxResponseChars);
  }

  async image(prompt: string, aspectRatio?: string): Promise<GeneratedImage> {
    const dimensions = dimensionsFor(aspectRatio ?? this.config.imageAspectRatio, this.config.imageWidth, this.config.imageHeight);
    const url = new URL(`${this.config.pollinationsImageBaseUrl}/${encodeURIComponent(buildImagePrompt(prompt))}`);
    url.searchParams.set("model", this.config.pollinationsImageModel);
    url.searchParams.set("width", String(dimensions.width));
    url.searchParams.set("height", String(dimensions.height));
    url.searchParams.set("safe", "true");
    url.searchParams.set("referrer", "lemonAI");

    const headers: Record<string, string> = {};
    if (this.config.pollinationsToken) {
      headers.Authorization = `Bearer ${this.config.pollinationsToken}`;
      url.searchParams.set("nologo", "true");
    }

    return downloadImage(url, headers);
  }
}

function toChatMessage(message: MemoryMessage): ChatCompletionMessageParam {
  const content = `${message.authorName}: ${message.content}`;
  return message.role === "assistant"
    ? { role: "assistant", content }
    : { role: "user", content };
}

async function downloadImage(url: URL, headers: Record<string, string>): Promise<GeneratedImage> {
  const response = await fetch(url, { headers });
  const contentType = response.headers.get("content-type") ?? "image/png";
  if (!response.ok) {
    throw new Error(`Pollinations image request failed with HTTP ${response.status}: ${await response.text()}`);
  }
  if (!contentType.startsWith("image/")) {
    throw new Error(`Pollinations returned non-image response: ${await response.text()}`);
  }
  const extension = extensionForContentType(contentType);
  return {
    bytes: Buffer.from(await response.arrayBuffer()),
    filename: `lemonai.${extension}`,
    contentType
  };
}

function extensionForContentType(contentType: string): string {
  if (contentType.includes("jpeg") || contentType.includes("jpg")) return "jpg";
  if (contentType.includes("webp")) return "webp";
  return "png";
}

function dimensionsFor(aspectRatio: string, fallbackWidth: number, fallbackHeight: number): { width: number; height: number } {
  if (aspectRatio === "auto") return { width: fallbackWidth, height: fallbackHeight };
  const [rawWidth, rawHeight] = aspectRatio.split(":");
  const widthRatio = Number.parseFloat(rawWidth ?? "");
  const heightRatio = Number.parseFloat(rawHeight ?? "");
  if (!Number.isFinite(widthRatio) || !Number.isFinite(heightRatio) || widthRatio <= 0 || heightRatio <= 0) {
    return { width: fallbackWidth, height: fallbackHeight };
  }

  const area = fallbackWidth * fallbackHeight;
  const ratio = widthRatio / heightRatio;
  return {
    width: clamp(roundTo64(Math.sqrt(area * ratio)), 256, 2048),
    height: clamp(roundTo64(Math.sqrt(area / ratio)), 256, 2048)
  };
}

function roundTo64(value: number): number {
  return Math.max(64, Math.round(value / 64) * 64);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
