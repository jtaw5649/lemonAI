import {
  ActivityType,
  Attachment,
  AttachmentBuilder,
  ChatInputCommandInteraction,
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  Message,
  MessageFlags,
  PermissionFlagsBits,
  Partials
} from "discord.js";
import { config, redactSecrets } from "./config.js";
import { AiClient, type ChatImageInput, type GeneratedImage } from "./ai-client.js";
import { logger } from "./logger.js";
import { type AutoPostConfig, type AutoPostMode, MemoryStore } from "./memory.js";
import { buildChannelStyle, buildSystemPrompt } from "./persona.js";
import { CooldownBucket, formatRemaining } from "./rate-limit.js";

const memory = new MemoryStore(config.memoryPath, config.maxHistoryMessages);
const ai = new AiClient(config);
const systemPrompt = buildSystemPrompt({ botName: config.botName, maxResponseChars: config.maxResponseChars });
const userCooldown = new CooldownBucket(config.userCooldownMs);
const channelCooldown = new CooldownBucket(config.channelCooldownMs);
const imageCooldown = new CooldownBucket(config.imageCooldownMs);
const discordUploadTimeoutMs = 20_000;
let autoPostTimer: NodeJS.Timeout | undefined;

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Channel]
});

client.once(Events.ClientReady, async (readyClient) => {
  readyClient.user.setActivity("/chat | /image", { type: ActivityType.Listening });
  scheduleAutoPostWakeup();
  logger.info("lemonAI online", {
    bot: readyClient.user.tag,
    guilds: readyClient.guilds.cache.size,
    autoReplyEnabled: config.autoReplyEnabled
  });
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  try {
    if (!isChannelAllowed(interaction.channelId)) {
      await interaction.reply({ content: "this channel is on the lemon blacklist", flags: MessageFlags.Ephemeral });
      return;
    }

    switch (interaction.commandName) {
      case "chat":
        await handleChatCommand(interaction);
        break;
      case "image":
        await handleImageCommand(interaction);
        break;
      case "gif":
        await handleGifCommand(interaction);
        break;
      case "reset":
        await handleResetCommand(interaction);
        break;
      case "autopost":
        await handleAutoPostCommand(interaction);
        break;
      case "help":
        await handleHelpCommand(interaction);
        break;
      default:
        await interaction.reply({ content: "unknown command. very cursed.", flags: MessageFlags.Ephemeral });
    }
  } catch (error) {
    logger.error("interaction failed", error);
    await replyWithError(interaction, error);
  }
});

client.on(Events.MessageCreate, async (message) => {
  if (!config.autoReplyEnabled || message.author.bot || !message.guildId || !isChannelAllowed(message.channelId)) return;

  const content = message.content.trim();
  if (!content) return;

  const referencedMessage = await fetchReferencedMessage(message);
  const prompt = extractMentionPrompt(message, content, referencedMessage);
  if (!prompt) {
    memory.remember(message.channelId, {
      role: "user",
      authorId: message.author.id,
      authorName: displayName(message),
      content
    });
    return;
  }

  const limited = takeChatCooldown(message.author.id, message.channelId);
  if (limited) {
    await message.reply(`cooldown goblin says wait ${formatRemaining(limited)}`);
    return;
  }

  try {
    await message.channel.sendTyping();
    const images = collectMessageImages(message, referencedMessage);
    const response = await ai.chat({
      systemPrompt,
      prompt,
      authorName: displayName(message),
      history: memory.get(message.channelId),
      styleContext: buildChannelStyle(memory.get(message.channelId)),
      images
    });
    await sendChunkedReply(message, response);
    memory.remember(message.channelId, {
      role: "user",
      authorId: message.author.id,
      authorName: displayName(message),
      content: prompt
    });
    memory.remember(message.channelId, {
      role: "assistant",
      authorId: client.user?.id ?? "lemonai",
      authorName: config.botName,
      content: response
    });
  } catch (error) {
    logger.error("message reply failed", error);
    await message.reply(`lemon slipped on api peel: ${redactSecrets(error)}`);
  }
});

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("unhandledRejection", (error) => logger.error("unhandled rejection", error));
process.on("uncaughtException", (error) => {
  logger.error("uncaught exception", error);
  void shutdown("uncaughtException", 1);
});

await memory.load();
await client.login(config.discordToken);

async function handleChatCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  const prompt = interaction.options.getString("prompt", true).trim();
  const privateReply = interaction.options.getBoolean("private") ?? false;
  const attachment = interaction.options.getAttachment("image");
  const images = attachment ? imageInputFromAttachment(attachment) : [];
  if (attachment && images.length === 0) {
    await interaction.reply({ content: "that attachment is not an image, genius", flags: MessageFlags.Ephemeral });
    return;
  }
  const limited = takeChatCooldown(interaction.user.id, interaction.channelId);
  if (limited) {
    await interaction.reply({ content: `cooldown goblin says wait ${formatRemaining(limited)}`, flags: MessageFlags.Ephemeral });
    return;
  }

  await defer(interaction, privateReply);
  const authorName = interaction.member && "displayName" in interaction.member
    ? interaction.member.displayName
    : interaction.user.username;

  const response = await ai.chat({
      systemPrompt,
      prompt,
      authorName,
      history: privateReply ? [] : memory.get(interaction.channelId),
      styleContext: privateReply ? undefined : buildChannelStyle(memory.get(interaction.channelId)),
      images
    });

  await editChunkedInteraction(interaction, response, privateReply);

  if (!privateReply) {
    memory.remember(interaction.channelId, {
      role: "user",
      authorId: interaction.user.id,
      authorName,
      content: prompt
    });
    memory.remember(interaction.channelId, {
      role: "assistant",
      authorId: client.user?.id ?? "lemonai",
      authorName: config.botName,
      content: response
    });
  }
}

async function handleImageCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  const prompt = interaction.options.getString("prompt", true).trim();
  const aspectRatio = interaction.options.getString("aspect_ratio") ?? undefined;
  const adult = interaction.options.getBoolean("adult") ?? false;
  const limited = imageCooldown.take(interaction.user.id);
  if (limited) {
    await interaction.reply({ content: `image gremlin is reloading. wait ${formatRemaining(limited)}`, flags: MessageFlags.Ephemeral });
    return;
  }

  await interaction.deferReply();
  const image = await ai.image(prompt, aspectRatio, { adult });
  await editImageReply(interaction, image);
}

async function handleGifCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  const url = interaction.options.getString("url", true).trim();
  const mediaUrl = parseMediaUrl(url);
  if (!mediaUrl) {
    await interaction.reply({ content: "that is not a usable gif/image url", flags: MessageFlags.Ephemeral });
    return;
  }

  await replyWithMedia(interaction, mediaUrl);
}

async function handleResetCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  memory.reset(interaction.channelId);
  await interaction.reply({ content: "channel memory deleted. lemon lobotomy complete.", flags: MessageFlags.Ephemeral });
}

async function handleAutoPostCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!canManageAutoPost(interaction)) {
    await interaction.reply({ content: "need Manage Channels to configure the lemon sewer sprinkler", flags: MessageFlags.Ephemeral });
    return;
  }

  const subcommand = interaction.options.getSubcommand(true);
  if (subcommand === "set") {
    const mode = interaction.options.getString("mode", true) as AutoPostMode;
    const intervalMinutes = interaction.options.getInteger("interval_minutes", true);
    const prompt = interaction.options.getString("prompt")?.trim() || "";
    const aspectRatio = interaction.options.getString("aspect_ratio") ?? config.imageAspectRatio;
    const now = Date.now();
    const autopost: AutoPostConfig = {
      enabled: true,
      mode,
      intervalMs: intervalMinutes * 60_000,
      prompt,
      aspectRatio,
      nextRunAt: now + intervalMinutes * 60_000,
      updatedBy: interaction.user.id,
      updatedAt: now
    };
    memory.setAutoPost(interaction.channelId, autopost);
    scheduleAutoPostWakeup();
    await interaction.reply({
      content: `autopost armed: ${mode} every ${intervalMinutes}m${prompt ? ` | vibe: ${truncate(prompt, 300)}` : " | vibe: channel-memory goblin mode"}`,
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  if (subcommand === "off") {
    memory.disableAutoPost(interaction.channelId);
    scheduleAutoPostWakeup();
    await interaction.reply({ content: "autopost disabled. sewer valve closed.", flags: MessageFlags.Ephemeral });
    return;
  }

  const current = memory.getAutoPost(interaction.channelId);
  if (!current?.enabled) {
    await interaction.reply({ content: "autopost is off in this channel.", flags: MessageFlags.Ephemeral });
    return;
  }

  await interaction.reply({
    content: [
      `autopost: ${current.mode}`,
      `interval: ${Math.round(current.intervalMs / 60_000)}m`,
      `next: <t:${Math.floor(current.nextRunAt / 1000)}:R>`,
      `aspect: ${current.aspectRatio}`,
      `vibe: ${current.prompt || "channel-memory goblin mode"}`
    ].join("\n"),
    flags: MessageFlags.Ephemeral
  });
}

async function handleHelpCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.reply({
    content: [
      `**${config.botName}**`,
      "`/chat prompt:` chaotic reply; add `image:` to inspect an image",
      "`/image prompt:` Pollinations image; `adult:true` uses safe=false/private=true",
      "`/gif url:` send a GIF/image URL",
      "Reply to image/GIF embeds or attach an image to `/chat` for vision.",
      "`/autopost set mode:both interval_minutes:30` scheduled channel brainrot",
      "`/reset` wipe this channel's memory",
      "Mention me, reply to me, or start with `lemonai` for inline replies if auto-reply is enabled."
    ].join("\n"),
    flags: MessageFlags.Ephemeral
  });
}

function takeChatCooldown(userId: string, channelId: string): number {
  return userCooldown.take(userId) || channelCooldown.take(channelId);
}

function isChannelAllowed(channelId: string | null): boolean {
  if (!channelId) return false;
  if (config.ignoredChannelIds.has(channelId)) return false;
  return config.allowedChannelIds.size === 0 || config.allowedChannelIds.has(channelId);
}

function extractMentionPrompt(message: Message, content: string, referencedMessage: Message | null): string | null {
  const botId = client.user?.id;
  const mentioned = botId ? message.mentions.users.has(botId) : false;
  const normalized = content.toLowerCase();
  const nameTriggered = normalized.startsWith("lemonai") || normalized.startsWith("lemon ai");
  const replyTriggered = Boolean(botId && referencedMessage?.author.id === botId);
  if (!mentioned && !nameTriggered && !replyTriggered) return null;

  const withoutMention = botId
    ? content.replace(new RegExp(`<@!?${botId}>`, "g"), "")
    : content;
  const withoutName = withoutMention.replace(/^lemon\s*ai[:,\s-]*/i, "").trim();
  return withoutName || "say something unhinged but useful";
}

async function fetchReferencedMessage(message: Message): Promise<Message | null> {
  if (!message.reference?.messageId) return null;
  const cached = message.channel.messages.cache.get(message.reference.messageId);
  if (cached) return cached;
  try {
    return await message.channel.messages.fetch(message.reference.messageId);
  } catch {
    return null;
  }
}

function collectMessageImages(message: Message, referencedMessage: Message | null): ChatImageInput[] {
  return [
    ...imageInputsFromAttachments(referencedMessage?.attachments),
    ...imageInputsFromEmbeds(referencedMessage?.embeds),
    ...imageInputsFromText(referencedMessage?.content ?? ""),
    ...imageInputsFromAttachments(message.attachments),
    ...imageInputsFromEmbeds(message.embeds),
    ...imageInputsFromText(message.content)
  ].slice(0, 4);
}

function imageInputsFromAttachments(attachments?: Message["attachments"]): ChatImageInput[] {
  return [...(attachments?.values() ?? [])].flatMap(imageInputFromAttachment);
}

function imageInputFromAttachment(attachment: Attachment): ChatImageInput[] {
  const contentType = attachment.contentType ?? "";
  const name = attachment.name ?? "";
  const looksLikeImage = contentType.startsWith("image/") || looksLikeMediaUrl(name);
  return looksLikeImage ? [{ url: attachment.url, detail: "auto" }] : [];
}

function imageInputsFromEmbeds(embeds?: Message["embeds"]): ChatImageInput[] {
  return (embeds ?? []).flatMap((embed) => {
    const urls = [
      embed.image?.url,
      embed.image?.proxyURL,
      embed.thumbnail?.url,
      embed.thumbnail?.proxyURL,
      embed.video?.url,
      embed.video?.proxyURL,
      embed.url
    ].filter((url): url is string => typeof url === "string" && looksLikeMediaUrl(url));
    return urls.map((url) => ({ url, detail: "auto" as const }));
  });
}

function imageInputsFromText(content: string): ChatImageInput[] {
  return [...content.matchAll(/https?:\/\/\S+/gi)]
    .map((match) => match[0].replace(/[>)\].,!?'";:]+$/g, ""))
    .filter(looksLikeMediaUrl)
    .map((url) => ({ url, detail: "auto" as const }));
}

function looksLikeMediaUrl(value: string): boolean {
  return /\.(?:png|jpe?g|webp|gif)(?:[?#].*)?$/i.test(value) || /(?:tenor\.com|media\.tenor\.com|giphy\.com|media\.giphy\.com|cdn\.discordapp\.com|media\.discordapp\.net)/i.test(value);
}

function looksLikeDirectMediaUrl(value: string): boolean {
  return /\.(?:png|jpe?g|webp|gif)(?:[?#].*)?$/i.test(value) || /(?:media\.tenor\.com|media\.giphy\.com|cdn\.discordapp\.com|media\.discordapp\.net)/i.test(value);
}

function parseMediaUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return looksLikeMediaUrl(url.toString()) ? url.toString() : null;
  } catch {
    return null;
  }
}

function mediaEmbed(url: string): EmbedBuilder {
  return new EmbedBuilder().setImage(url);
}

async function replyWithMedia(interaction: ChatInputCommandInteraction, url: string): Promise<void> {
  if (looksLikeDirectMediaUrl(url)) {
    await interaction.reply({ embeds: [mediaEmbed(url)] });
    return;
  }
  await interaction.reply(url);
}

function displayName(message: Message): string {
  return message.member?.displayName ?? message.author.username;
}

async function defer(interaction: ChatInputCommandInteraction, ephemeral: boolean): Promise<void> {
  if (ephemeral) await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  else await interaction.deferReply();
}

async function editChunkedInteraction(
  interaction: ChatInputCommandInteraction,
  text: string,
  ephemeral: boolean
): Promise<void> {
  const chunks = chunkDiscord(text);
  const first = chunks.shift() ?? "model returned vapor. impressive failure.";
  await interaction.editReply(first);
  for (const chunk of chunks) {
    await interaction.followUp({ content: chunk, flags: ephemeral ? MessageFlags.Ephemeral : undefined });
  }
}

async function sendChunkedReply(message: Message, text: string): Promise<void> {
  const chunks = chunkDiscord(text);
  const first = chunks.shift() ?? "model returned vapor. impressive failure.";
  await message.reply(first);
  if (!canSend(message.channel)) return;
  for (const chunk of chunks) await message.channel.send(chunk);
}

function canSend(channel: unknown): channel is {
  send: (content: string | { content?: string; embeds?: EmbedBuilder[]; files?: AttachmentBuilder[] }) => Promise<unknown>;
  sendTyping?: () => Promise<unknown>;
} {
  return typeof (channel as { send?: unknown }).send === "function";
}

function canManageAutoPost(interaction: ChatInputCommandInteraction): boolean {
  return Boolean(
    interaction.memberPermissions?.has(PermissionFlagsBits.ManageChannels) ||
    interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)
  );
}

async function runAutoPosts(): Promise<void> {
  if (!client.isReady()) {
    scheduleAutoPostWakeup();
    return;
  }

  const now = Date.now();
  for (const [channelId, autopost] of memory.dueAutoPosts(now)) {
    memory.scheduleNextAutoPost(channelId, now, config.autoPostJitterPercent);
    if (config.autoPostMaxLateMs > 0 && now - autopost.nextRunAt > config.autoPostMaxLateMs) continue;
    try {
      const channel = await client.channels.fetch(channelId);
      if (!canSend(channel)) continue;
      await channel.sendTyping?.().catch(() => undefined);

      if (autopost.mode === "chat" || autopost.mode === "both") {
        const response = await ai.chat({
          systemPrompt,
          prompt: buildAutoPostChatPrompt(autopost),
          authorName: config.botName,
          history: memory.get(channelId),
          styleContext: buildChannelStyle(memory.get(channelId))
        });
        await channel.send(response);
        memory.remember(channelId, {
          role: "assistant",
          authorId: client.user.id,
          authorName: config.botName,
          content: response
        });
      }

      if (autopost.mode === "image" || autopost.mode === "both") {
        const imagePrompt = await ai.chat({
          systemPrompt,
          prompt: buildAutoPostImagePrompt(autopost),
          authorName: config.botName,
          history: memory.get(channelId),
          styleContext: buildChannelStyle(memory.get(channelId))
        });
        const image = await ai.image(imagePrompt, autopost.aspectRatio);
        await sendImageToChannel(channel, image);
        memory.remember(channelId, {
          role: "assistant",
          authorId: client.user.id,
          authorName: config.botName,
          content: `[autopost image] ${imagePrompt}`
        });
      }
    } catch (error) {
      logger.error("autopost failed", { channelId, error: redactSecrets(error) });
    }
  }
  scheduleAutoPostWakeup();
}

function scheduleAutoPostWakeup(): void {
  if (autoPostTimer) clearTimeout(autoPostTimer);
  const nextRunAt = memory.nextAutoPostAt();
  if (!nextRunAt) return;
  const delay = Math.max(1000, Math.min(nextRunAt - Date.now(), 2_147_483_647));
  autoPostTimer = setTimeout(() => void runAutoPosts(), delay);
  autoPostTimer.unref();
}

function buildAutoPostChatPrompt(autopost: AutoPostConfig): string {
  return [
    "Generate one spontaneous Discord autopost for the current channel.",
    "Use the channel memory as context. Do not announce that this is scheduled.",
    "Make it funny, weird, and short like a feral Discord regular. Insult only if the channel context earns it. Avoid slurs and real threats.",
    autopost.prompt ? `Channel-configured vibe: ${autopost.prompt}` : "No configured vibe: infer the brainrot from recent channel memory."
  ].join("\n");
}

function buildAutoPostImagePrompt(autopost: AutoPostConfig): string {
  return [
    "Generate a concise image prompt for a Discord shitpost image.",
    "Base it on recent channel memory and the configured vibe. Return only the prompt, no explanation.",
    "Style: toxic-but-safe Discord brainrot, absurd meme composition, readable visual subject. League jokes are optional seasoning.",
    autopost.prompt ? `Channel-configured vibe: ${autopost.prompt}` : "No configured vibe: infer from channel memory."
  ].join("\n");
}

function imageAttachment(image: GeneratedImage): AttachmentBuilder {
  return new AttachmentBuilder(image.bytes, { name: image.filename });
}

async function editImageReply(interaction: ChatInputCommandInteraction, image: GeneratedImage): Promise<void> {
  try {
    await withTimeout(interaction.editReply({ files: [imageAttachment(image)] }), discordUploadTimeoutMs, "Discord image upload timed out");
  } catch (error) {
    logger.warn("image attachment upload failed, falling back to source URL", { error: redactSecrets(error) });
    await interaction.editReply({ embeds: [mediaEmbed(image.sourceUrl)], files: [] });
  }
}

async function sendImageToChannel(channel: { send: (content: string | { embeds?: EmbedBuilder[]; files?: AttachmentBuilder[] }) => Promise<unknown> }, image: GeneratedImage): Promise<void> {
  try {
    await withTimeout(channel.send({ files: [imageAttachment(image)] }), discordUploadTimeoutMs, "Discord image upload timed out");
  } catch (error) {
    logger.warn("image channel upload failed, falling back to source URL", { error: redactSecrets(error) });
    await channel.send({ embeds: [mediaEmbed(image.sourceUrl)] });
  }
}

async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new Error(`${message} after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function chunkDiscord(text: string): string[] {
  const limit = Math.min(config.maxResponseChars, 1900);
  const chunks: string[] = [];
  let remaining = text.trim();

  while (remaining.length > limit) {
    const newline = remaining.lastIndexOf("\n", limit);
    const space = remaining.lastIndexOf(" ", limit);
    const cut = Math.max(newline, space, Math.floor(limit * 0.8));
    chunks.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trim();
  }

  if (remaining) chunks.push(remaining);
  return chunks;
}

async function replyWithError(interaction: ChatInputCommandInteraction, error: unknown): Promise<void> {
  const content = `lemon tripped over a cable: ${truncate(redactSecrets(error), 1500)}`;
  if (interaction.deferred || interaction.replied) {
    await interaction.editReply(content).catch(() => interaction.followUp({ content, flags: MessageFlags.Ephemeral }));
    return;
  }
  await interaction.reply({ content, flags: MessageFlags.Ephemeral });
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}...` : value;
}

async function shutdown(signal: string, exitCode = 0): Promise<void> {
  logger.info("shutting down", { signal });
  if (autoPostTimer) clearTimeout(autoPostTimer);
  await memory.flush();
  client.destroy();
  process.exit(exitCode);
}
