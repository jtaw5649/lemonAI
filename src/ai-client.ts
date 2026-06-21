import OpenAI from "openai";
import type { ChatCompletionContentPart, ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { buildImagePrompt } from "./persona.js";
import type { BotConfig } from "./config.js";
import type { MemoryMessage } from "./memory.js";
import { logger } from "./logger.js";

type ChatInput = {
  systemPrompt: string;
  prompt: string;
  authorName: string;
  history: MemoryMessage[];
  images?: ChatImageInput[];
};

export type ChatImageInput = {
  url: string;
  detail?: "auto" | "low" | "high";
};

export type GeneratedImage = {
  bytes: Buffer;
  filename: string;
  contentType: string;
  sourceUrl: string;
};

export type GeneratedImageLink = {
  url: string;
  prompt: string;
  model: string;
  width: number;
  height: number;
};

type ImageAttempt = {
  label: string;
  model: string;
  width: number;
  height: number;
  useToken: boolean;
  noLogo: boolean;
  safe: boolean;
  privateImage: boolean;
};

type ImageOptions = {
  adult?: boolean;
};

type ChatAttempt = {
  provider: string;
  client: OpenAI;
  model: string;
};

export class AiClient {
  private readonly chatAttempts: ChatAttempt[];
  private readonly visionAttempts: ChatAttempt[];

  constructor(private readonly config: BotConfig) {
    this.chatAttempts = buildChatAttempts(config);
    this.visionAttempts = buildVisionAttempts(config);
    if (this.chatAttempts.length === 0) throw new Error("Missing chat API key: set OPENCODE_GO_API_KEY or OPENROUTER_API_KEY");
  }

  async chat(input: ChatInput): Promise<string> {
    const images = input.images?.slice(0, 4) ?? [];
    const visualContext = images.length > 0 ? await this.describeImages(input, images) : "";
    const prompt = visualContext ? `${input.prompt}\n\n[attached image analysis]\n${visualContext}` : input.prompt;
    const scopedPrompt = [
      `Current speaker: ${input.authorName}`,
      "Reply to the current speaker. Do not target unrelated usernames from channel history unless the current prompt explicitly asks about them.",
      prompt
    ].join("\n");
    const messages: ChatCompletionMessageParam[] = [
      { role: "system", content: input.systemPrompt },
      ...input.history.map(toChatMessage),
      { role: "user", content: scopedPrompt }
    ];

    let lastError: unknown;
    for (const attempt of this.chatAttempts) {
      try {
        const completion = await attempt.client.chat.completions.create({
          model: attempt.model,
          messages,
          temperature: this.config.chatTemperature,
          max_tokens: this.config.chatMaxTokens
        });

        const content = cleanAssistantOutput(completion.choices[0]?.message?.content ?? "");
        if (!content) throw new Error("chat provider returned an empty response");
        return content.slice(0, this.config.maxResponseChars);
      } catch (error) {
        lastError = error;
        logger.warn("chat model failed", { provider: attempt.provider, model: attempt.model, error: errorMessage(error) });
      }
    }

    throw new Error(`chat failed across all configured models: ${errorMessage(lastError)}`);
  }

  private async describeImages(input: ChatInput, images: ChatImageInput[]): Promise<string> {
    if (this.visionAttempts.length === 0) {
      throw new Error("image understanding needs OPENROUTER_API_KEY or OPENCODE_GO_VISION_MODEL with OPENCODE_GO_API_KEY");
    }

    const messages: ChatCompletionMessageParam[] = [
      {
        role: "system",
        content: [
          "You are a concise visual analyst for a Discord bot.",
          "Return factual visual evidence needed to answer the user's question.",
          "If asked whether an image is AI-generated, mention visible artifacts, confidence, and uncertainty.",
          "No jokes, no persona, no policy lecture. Keep it under 900 characters."
        ].join("\n")
      },
      {
        role: "user",
        content: imageMessageContent(`${input.authorName} asks: ${input.prompt}`, images)
      }
    ];

    let lastError: unknown;
    for (const attempt of this.visionAttempts) {
      try {
        const completion = await attempt.client.chat.completions.create({
          model: attempt.model,
          messages,
          temperature: 0.2,
          max_tokens: 300
        });
        const content = cleanAssistantOutput(completion.choices[0]?.message?.content ?? "");
        if (!content) throw new Error("vision provider returned an empty response");
        return content;
      } catch (error) {
        lastError = error;
        logger.warn("vision model failed", { provider: attempt.provider, model: attempt.model, error: errorMessage(error) });
      }
    }

    throw new Error(`image understanding failed across all configured models: ${errorMessage(lastError)}`);
  }

  async image(prompt: string, aspectRatio?: string, options: ImageOptions = {}): Promise<GeneratedImage> {
    const adult = options.adult === true;
    const dimensions = dimensionsFor(aspectRatio ?? this.config.imageAspectRatio, this.config.imageWidth, this.config.imageHeight);
    const attempts: ImageAttempt[] = [
      {
        label: "configured",
        model: this.config.pollinationsImageModel,
        width: dimensions.width,
        height: dimensions.height,
        useToken: this.config.pollinationsUseToken,
        noLogo: this.config.pollinationsNoLogo,
        safe: !adult,
        privateImage: adult
      },
      {
        label: "anonymous turbo fallback",
        model: "turbo",
        width: Math.min(dimensions.width, 768),
        height: Math.min(dimensions.height, 768),
        useToken: false,
        noLogo: false,
        safe: !adult,
        privateImage: adult
      },
      {
        label: "anonymous flux fallback",
        model: "flux",
        width: 512,
        height: 512,
        useToken: false,
        noLogo: false,
        safe: !adult,
        privateImage: adult
      }
    ];

    let lastError: unknown;
    for (const attempt of attempts) {
      try {
        return await downloadImage(buildPollinationsUrl(this.config, prompt, attempt), headersFor(this.config, attempt), this.config.imageTimeoutMs);
      } catch (error) {
        lastError = error;
        logger.warn("image attempt failed", { attempt: attempt.label, error: errorMessage(error) });
      }
    }

    throw new Error(`Pollinations image generation failed after retries: ${errorMessage(lastError)}`);
  }

  imageLink(prompt: string, aspectRatio?: string): GeneratedImageLink {
    const dimensions = dimensionsFor(aspectRatio ?? this.config.imageAspectRatio, this.config.imageWidth, this.config.imageHeight);
    const attempt: ImageAttempt = {
      label: "discord embed",
      model: this.config.pollinationsImageModel,
      width: dimensions.width,
      height: dimensions.height,
      useToken: false,
      noLogo: false,
      safe: true,
      privateImage: false
    };
    const url = buildPollinationsUrl(this.config, prompt, attempt);
    return {
      url: url.toString(),
      prompt: compactImagePrompt(prompt, false),
      model: attempt.model,
      width: attempt.width,
      height: attempt.height
    };
  }
}

function toChatMessage(message: MemoryMessage): ChatCompletionMessageParam {
  return message.role === "assistant"
    ? { role: "assistant", content: message.content }
    : { role: "user", content: `${message.authorName}: ${message.content}` };
}

function imageMessageContent(text: string, images: ChatImageInput[]): ChatCompletionContentPart[] {
  return [
    { type: "text", text },
    ...images.map((image) => ({
      type: "image_url" as const,
      image_url: {
        url: image.url,
        detail: image.detail ?? "auto"
      }
    }))
  ];
}

function buildChatAttempts(config: BotConfig): ChatAttempt[] {
  const attempts: ChatAttempt[] = [];

  if (config.openCodeGoApiKey) {
    const client = new OpenAI({
      apiKey: config.openCodeGoApiKey,
      baseURL: config.openCodeGoBaseUrl
    });
    for (const model of [config.openCodeGoModel, ...config.openCodeGoFallbackModels]) {
      attempts.push({ provider: "opencode-go", client, model });
    }
  }

  if (config.openRouterApiKey) {
    const client = new OpenAI({
      apiKey: config.openRouterApiKey,
      baseURL: config.openRouterBaseUrl,
      defaultHeaders: {
        ...(config.openRouterSiteUrl ? { "HTTP-Referer": config.openRouterSiteUrl } : {}),
        "X-OpenRouter-Title": config.openRouterAppName
      }
    });
    for (const model of [config.openRouterModel, ...config.openRouterFallbackModels]) {
      attempts.push({ provider: "openrouter", client, model });
    }
  }

  return attempts;
}

function buildVisionAttempts(config: BotConfig): ChatAttempt[] {
  const attempts: ChatAttempt[] = [];

  if (config.openCodeGoApiKey && config.openCodeGoVisionModel) {
    const client = new OpenAI({
      apiKey: config.openCodeGoApiKey,
      baseURL: config.openCodeGoBaseUrl
    });
    for (const model of [config.openCodeGoVisionModel, ...config.openCodeGoVisionFallbackModels]) {
      attempts.push({ provider: "opencode-go-vision", client, model });
    }
  }

  if (config.openRouterApiKey) {
    const client = new OpenAI({
      apiKey: config.openRouterApiKey,
      baseURL: config.openRouterBaseUrl,
      defaultHeaders: {
        ...(config.openRouterSiteUrl ? { "HTTP-Referer": config.openRouterSiteUrl } : {}),
        "X-OpenRouter-Title": config.openRouterAppName
      }
    });
    for (const model of [config.openRouterVisionModel, ...config.openRouterVisionFallbackModels]) {
      attempts.push({ provider: "openrouter-vision", client, model });
    }
  }

  return attempts;
}

function buildPollinationsUrl(config: BotConfig, prompt: string, attempt: ImageAttempt): URL {
  const url = new URL(`${config.pollinationsImageBaseUrl}/${encodeURIComponent(compactImagePrompt(prompt, !attempt.safe))}`);
  url.searchParams.set("model", attempt.model);
  url.searchParams.set("width", String(attempt.width));
  url.searchParams.set("height", String(attempt.height));
  url.searchParams.set("safe", attempt.safe ? "true" : "false");
  url.searchParams.set("referrer", "lemonAI");
  if (attempt.noLogo) url.searchParams.set("nologo", "true");
  if (attempt.privateImage) url.searchParams.set("private", "true");
  return url;
}

function compactImagePrompt(prompt: string, adult: boolean): string {
  return buildImagePrompt(prompt, adult).replace(/\s+/g, " ").trim().slice(0, 900);
}

function headersFor(config: BotConfig, attempt: ImageAttempt): Record<string, string> {
  if (!attempt.useToken || !config.pollinationsToken) return {};
  return { Authorization: `Bearer ${config.pollinationsToken}` };
}

async function downloadImage(url: URL, headers: Record<string, string>, timeoutMs: number): Promise<GeneratedImage> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { headers, signal: controller.signal });
    const contentType = response.headers.get("content-type") ?? "image/png";
    if (!response.ok) {
      throw new Error(`Pollinations image request failed with HTTP ${response.status}: ${await response.text()}`);
    }
    if (!contentType.startsWith("image/")) {
      throw new Error(`Pollinations returned non-image response: ${await response.text()}`);
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length === 0) throw new Error("Pollinations returned an empty image body");
    const extension = extensionForContentType(contentType);
    return {
      bytes,
      filename: `lemonai.${extension}`,
      contentType,
      sourceUrl: url.toString()
    };
  } catch (error) {
    if (isAbortError(error)) throw new Error(`Pollinations aborted while generating or downloading image after ${timeoutMs}ms`);
    throw error;
  } finally {
    clearTimeout(timeout);
  }
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

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.message.toLowerCase().includes("aborted"));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function stripBotPrefix(content: string): string {
  return content.replace(/^\s*(?:lemonAI|lemonai|assistant)\s*(?::|-|—|–)\s*/i, "").trim();
}

function cleanAssistantOutput(content: string): string {
  return stripBotPrefix(
    content
      .replace(/<think>[\s\S]*?<\/think>/gi, "")
      .replace(/^\s*<think>[\s\S]*?(?:\n\s*\n|$)/i, "")
      .replace(/^\s*(?:analysis|reasoning)\s*[:\-][\s\S]*?(?:\n\s*\n|$)/i, "")
      .trim()
  );
}
