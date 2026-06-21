import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { mkdir, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import { join } from "node:path";

export type MediaRenderMode = "embed_image" | "raw_url" | "upload_file" | "disabled" | "unknown";
export type MediaValidationStatus = "unvalidated" | "valid" | "invalid" | "failed";

export type MediaCacheConfig = {
  cachePath: string;
  maxCacheBytes: number;
  maxDownloadBytes: number;
  uploadMaxBytes: number;
  validationTimeoutMs: number;
};

export type CachedMedia = {
  directUrl: string;
  contentType?: string;
  size?: number;
  sha256?: string;
  localPath?: string;
  status: "cached" | "validated" | "invalid" | "failed";
  validationStatus: MediaValidationStatus;
  validationError?: string;
  validatedAt: number;
  renderMode: MediaRenderMode;
};

export async function cacheMediaUrl(url: string, config: MediaCacheConfig, fallbackContentType?: string): Promise<CachedMedia> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.validationTimeoutMs);

  try {
    const response = await fetchSafe(url, { signal: controller.signal });
    const headerContentType = response.headers.get("content-type");
    const contentType = normalizeImageContentType(headerContentType, url) ?? (headerContentType ? null : normalizeImageContentType(fallbackContentType ?? null, url));
    const contentLength = Number.parseInt(response.headers.get("content-length") ?? "", 10);
    const size = Number.isFinite(contentLength) && contentLength >= 0 ? contentLength : undefined;

    if (!response.ok) {
      await cancelResponseBody(response);
      throw new Error(`HTTP ${response.status}`);
    }
    if (!contentType) {
      await cancelResponseBody(response);
      return {
        directUrl: url,
        contentType: headerContentType?.split(";", 1)[0]?.trim().toLowerCase(),
        size,
        status: "invalid",
        validationStatus: "invalid",
        validationError: `not an image response: ${headerContentType ?? "unknown content-type"}`,
        validatedAt: Date.now(),
        renderMode: "raw_url"
      };
    }

    if (size !== undefined && size > config.maxDownloadBytes) {
      await cancelResponseBody(response);
      return {
        directUrl: url,
        contentType,
        size,
        status: "invalid",
        validationStatus: "unvalidated",
        validationError: `media too large to validate (${size} bytes)`,
        validatedAt: Date.now(),
        renderMode: "raw_url"
      };
    }

    const bytes = await readResponseBytes(response, config.maxDownloadBytes);
    if (bytes.length === 0) throw new Error("empty image response");
    const detectedContentType = validateImageBytes(bytes, contentType);

    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const extension = extensionForContentType(detectedContentType);
    await mkdir(config.cachePath, { recursive: true });
    const localPath = join(config.cachePath, `${sha256}.${extension}`);
    await writeFile(localPath, bytes, { flag: "wx" }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    });
    void pruneCache(config.cachePath, config.maxCacheBytes).catch(() => undefined);

    return {
      directUrl: url,
      contentType: detectedContentType,
      size: bytes.length,
      sha256,
      localPath,
      status: "cached",
      validationStatus: "valid",
      validatedAt: Date.now(),
      renderMode: bytes.length <= config.uploadMaxBytes ? "upload_file" : "embed_image"
    };
  } catch (error) {
    return {
      directUrl: url,
      status: "failed",
      validationStatus: "failed",
      validationError: isAbortError(error) ? `media validation timed out after ${config.validationTimeoutMs}ms` : errorMessage(error),
      validatedAt: Date.now(),
      renderMode: "raw_url"
    };
  } finally {
    clearTimeout(timeout);
  }
}

export function normalizeImageContentType(rawContentType: string | null, url = ""): string | null {
  const contentType = rawContentType?.split(";", 1)[0]?.trim().toLowerCase();
  if (isSupportedImageContentType(contentType)) return contentType;
  if (contentType) return null;
  if (/\.png(?:[?#].*)?$/i.test(url)) return "image/png";
  if (/\.jpe?g(?:[?#].*)?$/i.test(url)) return "image/jpeg";
  if (/\.webp(?:[?#].*)?$/i.test(url)) return "image/webp";
  if (/\.gif(?:[?#].*)?$/i.test(url)) return "image/gif";
  return null;
}

export function isSupportedImageContentType(contentType: string | undefined | null): contentType is "image/gif" | "image/png" | "image/jpeg" | "image/webp" {
  return contentType === "image/gif" || contentType === "image/png" || contentType === "image/jpeg" || contentType === "image/webp";
}

export function validateImageBytes(bytes: Buffer, expectedContentType: string): "image/gif" | "image/png" | "image/jpeg" | "image/webp" {
  const detectedContentType = detectImageContentType(bytes);
  if (!detectedContentType) throw new Error("image response failed signature check");
  if (expectedContentType !== detectedContentType) throw new Error(`image signature mismatch: ${expectedContentType} body is ${detectedContentType}`);
  return detectedContentType;
}

export function detectImageContentType(bytes: Buffer): "image/gif" | "image/png" | "image/jpeg" | "image/webp" | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (bytes.length >= 6 && (bytes.subarray(0, 6).toString("ascii") === "GIF87a" || bytes.subarray(0, 6).toString("ascii") === "GIF89a")) return "image/gif";
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  return null;
}

export async function fetchSafe(url: string, init: RequestInit = {}, redirects = 3): Promise<Response> {
  await assertSafeMediaUrl(url);
  const response = await fetch(url, { ...init, redirect: "manual" });
  if ([301, 302, 303, 307, 308].includes(response.status) && redirects > 0) {
    const location = response.headers.get("location");
    if (!location) return response;
    await cancelResponseBody(response);
    const nextUrl = new URL(location, url).toString();
    return fetchSafe(nextUrl, init, redirects - 1);
  }
  return response;
}

export async function readResponseBytes(response: Response, maxBytes: number): Promise<Buffer> {
  if (!response.body) {
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > maxBytes) throw new Error(`media too large (${bytes.length} bytes)`);
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error(`media too large (${total} bytes)`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total);
}

export async function cancelResponseBody(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

async function assertSafeMediaUrl(raw: string): Promise<void> {
  const url = new URL(raw);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("unsupported media URL protocol");
  if (isBlockedHostname(url.hostname)) throw new Error("blocked media URL host");
  if (!isTrustedMediaFetchHostname(url.hostname)) throw new Error("untrusted media URL host");
  const addresses = await lookup(url.hostname, { all: true }).catch(() => []);
  if (addresses.length === 0) throw new Error("media URL host did not resolve");
  if (addresses.some(({ address }) => isBlockedIp(address))) throw new Error("blocked private media URL address");
}

function isBlockedHostname(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === "localhost" || host.endsWith(".localhost");
}

function isTrustedMediaFetchHostname(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return (
    host === "cdn.discordapp.com" ||
    host === "media.discordapp.net" ||
    host === "media.tenor.com" ||
    host === "i.giphy.com" ||
    host === "media.giphy.com"
  );
}

function isBlockedIp(address: string): boolean {
  if (address.toLowerCase().startsWith("::ffff:")) return isBlockedIp(address.slice(7));
  if (isIP(address) === 4) {
    const parts = address.split(".").map((part) => Number.parseInt(part, 10));
    const [a = 0, b = 0] = parts;
    return (
      a === 0 || a === 10 || a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) ||
      (a === 192 && b === 2) ||
      (a === 198 && (b === 18 || b === 19 || b === 51)) ||
      (a === 203 && b === 0) ||
      a >= 224
    );
  }
  if (isIP(address) === 6) {
    const normalized = address.toLowerCase();
    return normalized === "::" || normalized === "::1" || normalized.startsWith("fc") || normalized.startsWith("fd") || normalized.startsWith("fe80:") || normalized.startsWith("ff") || normalized.startsWith("2001:db8:");
  }
  return true;
}

export function extensionForContentType(contentType: string): string {
  if (contentType.includes("gif")) return "gif";
  if (contentType.includes("jpeg") || contentType.includes("jpg")) return "jpg";
  if (contentType.includes("webp")) return "webp";
  if (contentType.includes("avif")) return "avif";
  return "png";
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.message.toLowerCase().includes("aborted"));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function pruneCache(cachePath: string, maxBytes: number): Promise<void> {
  if (maxBytes <= 0) return;
  const entries = await readdir(cachePath, { withFileTypes: true }).catch(() => []);
  const files = await Promise.all(entries
    .filter((entry) => entry.isFile())
    .map(async (entry) => {
      const path = join(cachePath, entry.name);
      const info = await stat(path).catch(() => null);
      return info ? { path, size: info.size, mtimeMs: info.mtimeMs } : null;
    }));
  const present = files.filter((file): file is { path: string; size: number; mtimeMs: number } => file !== null);
  let total = present.reduce((sum, file) => sum + file.size, 0);
  for (const file of present.sort((a, b) => a.mtimeMs - b.mtimeMs)) {
    if (total <= maxBytes) break;
    await unlink(file.path).catch(() => undefined);
    total -= file.size;
  }
}
