import {
  ActivityType,
  Attachment,
  AttachmentBuilder,
  ChatInputCommandInteraction,
  Client,
  Collection,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  Guild,
  GuildEmoji,
  Message,
  MessageFlags,
  MessageReaction,
  PartialMessageReaction,
  PermissionFlagsBits,
  Partials,
  PartialUser,
  Sticker,
  User
} from "discord.js";
import { config, redactSecrets } from "./config.js";
import { AiClient, type ChatImageInput, type ChatReplyContext, type GeneratedImage } from "./ai-client.js";
import { logger } from "./logger.js";
import { type AutoPostConfig, type AutoPostMode, type MediaInput, type MediaMemory, MemoryStore } from "./memory.js";
import { cacheMediaUrl, extensionForContentType, isSupportedImageContentType, type CachedMedia, type MediaCacheConfig } from "./media-cache.js";
import { buildSystemPrompt } from "./persona.js";
import { CooldownBucket, formatRemaining } from "./rate-limit.js";

const memory = new MemoryStore(config.memoryDbPath, config.memoryJsonImportPath, config.maxHistoryMessages, config.maxMemoryMessages, {
  enabled: config.memorySummaryEnabled,
  windowMessages: config.memorySummaryWindowMessages,
  dailyEnabled: config.memorySummaryDaily,
  topicEnabled: config.memorySummaryTopics,
  topicMinMessages: config.memorySummaryTopicMinMessages,
  startupChannelLimit: config.memorySummaryStartupChannels
});
const ai = new AiClient(config);
const systemPrompt = buildSystemPrompt({ botName: config.botName, maxResponseChars: config.maxResponseChars });
const userCooldown = new CooldownBucket(config.userCooldownMs);
const channelCooldown = new CooldownBucket(config.channelCooldownMs);
const ambientCooldown = new CooldownBucket(config.ambientCooldownMs);
const expressionCooldown = new CooldownBucket(Math.max(750, config.channelCooldownMs));
const reactionCaptureCooldown = new CooldownBucket(250);
const imageCooldown = new CooldownBucket(config.imageCooldownMs);
let autoPostTimer: NodeJS.Timeout | undefined;
const discordApiBaseUrl = "https://discord.com/api/v10";
const discordUploadTimeoutMs = 90_000;
const mediaCacheConfig: MediaCacheConfig = {
  cachePath: config.mediaCachePath,
  maxCacheBytes: config.mediaCacheMaxBytes,
  maxDownloadBytes: config.mediaMaxDownloadBytes,
  uploadMaxBytes: config.mediaUploadMaxBytes,
  validationTimeoutMs: config.mediaValidationTimeoutMs
};

type GuildStickerSnapshot = {
  fetchedAt: number;
  stickers: Sticker[];
};

const guildStickerSnapshots = new Map<string, GuildStickerSnapshot>();
type MediaAnalysisQueueItem = { url: string; channelId: string; retry?: boolean };
const mediaAnalysisQueue: MediaAnalysisQueueItem[] = [];
const queuedMediaAnalysis = new Set<string>();
const mediaAnalysisStartedAt: number[] = [];
let mediaAnalysisActive = 0;
let mediaAnalysisResumeTimer: NodeJS.Timeout | undefined;
const staleMediaAnalysisMs = 15 * 60_000;

type MessageFetchableChannel = {
  id: string;
  messages: {
    fetch: (options: { limit: number; before?: string }) => Promise<Collection<string, Message>>;
  };
};

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Channel, Partials.Message, Partials.Reaction],
  rest: { timeout: discordUploadTimeoutMs }
});

client.once(Events.ClientReady, (readyClient) => {
  readyClient.user.setActivity("/chat | /image", { type: ActivityType.Listening });
  void backfillMemory(readyClient).catch((error) => {
    logger.warn("memory backfill failed", { error: redactSecrets(error) });
  });
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
      await interaction.reply({ content: "this channel is not enabled for this bot.", flags: MessageFlags.Ephemeral });
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
      case "emote":
        await handleEmoteCommand(interaction);
        break;
      case "sticker":
        await handleStickerCommand(interaction);
        break;
      case "autopost":
        await handleAutoPostCommand(interaction);
        break;
      case "help":
        await handleHelpCommand(interaction);
        break;
      default:
        await interaction.reply({ content: "unknown command.", flags: MessageFlags.Ephemeral });
    }
  } catch (error) {
    logger.error("interaction failed", error);
    await replyWithError(interaction, error);
  }
});

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot || !message.guildId || !isChannelAllowed(message.channelId)) return;

  const content = message.content.trim();
  if (content) {
    memory.remember(message.channelId, {
      role: "user",
      authorId: message.author.id,
      authorName: displayName(message),
      content: message.content,
      messageId: message.id,
      createdAt: message.createdTimestamp,
      guildId: message.guildId,
      hasAttachments: message.attachments.size > 0,
      hasEmbeds: message.embeds.length > 0,
      hasStickers: message.stickers.size > 0
    });
  }

  rememberMessageMedia(message);
  if (!content) return;

  if (!config.autoReplyEnabled) return;

  const referencedMessage = await fetchReferencedMessage(message);
  if (await handleExpressionMessage(message, referencedMessage, content)) return;

  const replyContext = buildReplyContext(message, referencedMessage);
  const prompt = extractMentionPrompt(message, content, referencedMessage);
  if (!prompt) {
    if (await maybeAmbientExpression(message, content)) return;
    await maybeAmbientReply(message, content);
    return;
  }

  const limited = takeChatCooldown(message.author.id, message.channelId);
  if (limited) {
    await message.reply(`cooldown active. wait ${formatRemaining(limited)}`);
    return;
  }

  try {
    await message.channel.sendTyping();
    const images = await cacheVisionImages(collectMessageImages(message, referencedMessage));
    const useContext = shouldUseChannelContext(prompt, replyContext);
    const promptWithContext = useContext ? memoryContentWithContext(prompt, replyContext, images) : prompt;
    const history = useContext ? memory.get(message.channelId) : [];
    const memoryContext = useContext ? memory.context(message.channelId, promptWithContext, config.memoryRecallMessages, message.guildId ?? undefined) : undefined;
    const personaContext = serverPersonaProfile(message.guildId, message.channelId);
    const response = await ai.chat({
      systemPrompt,
      prompt,
      authorName: displayName(message),
      history,
      memoryContext,
      personaContext,
      replyContext,
      images
    });
    await sendChunkedReply(message, response);
    memory.remember(message.channelId, {
      role: "assistant",
      authorId: client.user?.id ?? "lemonai",
      authorName: config.botName,
      content: response,
      guildId: message.guildId ?? undefined
    });
  } catch (error) {
    logger.error("message reply failed", error);
    await message.reply(`request failed: ${formatRequestError(error)}`);
  }
});

client.on(Events.MessageReactionAdd, async (reaction, user) => {
  try {
    await rememberReactionMedia(reaction, user);
  } catch (error) {
    logger.debug("reaction media capture failed", { error: redactSecrets(error) });
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
recoverMediaAnalysisQueue();
await client.login(config.discordToken);

async function handleChatCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  const prompt = interaction.options.getString("prompt", true).trim();
  const privateReply = interaction.options.getBoolean("private") ?? false;
  const authorName = interaction.member && "displayName" in interaction.member
    ? interaction.member.displayName
    : interaction.user.username;
  const attachment = interaction.options.getAttachment("image");
  const rawImages = attachment ? imageInputFromAttachment(attachment, {
    source: "slash-command",
    sourceType: "slash-attachment",
    channelId: interaction.channelId,
    guildId: interaction.guildId ?? undefined,
    authorId: interaction.user.id,
    authorName
  }) : [];
  if (attachment && rawImages.length === 0) {
    await interaction.reply({ content: "that attachment is not an image.", flags: MessageFlags.Ephemeral });
    return;
  }
  const limited = takeChatCooldown(interaction.user.id, interaction.channelId);
  if (limited) {
    await interaction.reply({ content: `cooldown active. wait ${formatRemaining(limited)}`, flags: MessageFlags.Ephemeral });
    return;
  }

  await defer(interaction, privateReply);

  const history = privateReply ? [] : memory.get(interaction.channelId);
  const images = privateReply ? rawImages.map(privateChatImageInput) : await cacheVisionImages(rawImages);
  const useContext = !privateReply && shouldUseChannelContext(prompt, undefined);
  const promptWithContext = useContext ? memoryContentWithContext(prompt, undefined, images) : prompt;
  const personaContext = privateReply ? undefined : serverPersonaProfile(interaction.guildId ?? undefined, interaction.channelId);
  const response = await ai.chat({
    systemPrompt,
    prompt,
    authorName,
    history: useContext ? history : [],
    memoryContext: useContext ? memory.context(interaction.channelId, promptWithContext, config.memoryRecallMessages, interaction.guildId ?? undefined) : undefined,
    personaContext,
    images
  });

  await editChunkedInteraction(interaction, response, privateReply);

  if (!privateReply) {
    memory.remember(interaction.channelId, {
      role: "user",
      authorId: interaction.user.id,
      authorName,
      content: prompt,
      guildId: interaction.guildId ?? undefined,
      hasAttachments: Boolean(attachment)
    });
    memory.remember(interaction.channelId, {
      role: "assistant",
      authorId: client.user?.id ?? "lemonai",
      authorName: config.botName,
      content: response,
      guildId: interaction.guildId ?? undefined
    });
  }
}

async function handleImageCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  const prompt = interaction.options.getString("prompt", true).trim();
  const aspectRatio = interaction.options.getString("aspect_ratio") ?? undefined;
  const adult = interaction.options.getBoolean("adult") ?? false;
  const limited = imageCooldown.take(interaction.user.id);
  if (limited) {
    await interaction.reply({ content: `image cooldown active. wait ${formatRemaining(limited)}`, flags: MessageFlags.Ephemeral });
    return;
  }

  await interaction.deferReply();
  const image = await ai.image(prompt, aspectRatio, { adult });
  await editImageReply(interaction, image);
}

async function handleGifCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  const limited = takeExpressionCooldown(interaction.user.id, interaction.channelId);
  if (limited) {
    await interaction.reply({ content: `expression cooldown active. wait ${formatRemaining(limited)}`, flags: MessageFlags.Ephemeral });
    return;
  }
  const query = interaction.options.getString("query", true).trim();
  const directUrl = parseMediaUrl(query);
  const media = directUrl
    ? rememberTransientMedia(mediaInputFromUrl(directUrl, interaction.channelId, {
      guildId: interaction.guildId ?? undefined,
      authorId: interaction.user.id,
      authorName: interaction.user.username,
      sourceType: "slash-url",
      hint: query
    }))
    : memory.findMedia(query, interaction.channelId, "gif", interaction.guildId ?? undefined);
  if (!media) {
    await interaction.reply({ content: "no matching saved GIF found. Direct GIF/image URLs still work.", flags: MessageFlags.Ephemeral });
    return;
  }

  await interaction.deferReply();
  await replyWithMedia(interaction, media);
}

async function handleEmoteCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  const limited = takeExpressionCooldown(interaction.user.id, interaction.channelId);
  if (limited) {
    await interaction.reply({ content: `expression cooldown active. wait ${formatRemaining(limited)}`, flags: MessageFlags.Ephemeral });
    return;
  }
  const query = interaction.options.getString("query", true).trim();
  const resolved = interaction.guild ? resolveGuildEmoji(interaction.guild, query) : undefined;
  if (!resolved) {
    await interaction.reply({ content: "no matching server emoji found.", flags: MessageFlags.Ephemeral });
    return;
  }
  await interaction.reply(String(resolved.value));
  recordResolvedMedia(resolved.media, true);
}

async function handleStickerCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  const limited = takeExpressionCooldown(interaction.user.id, interaction.channelId);
  if (limited) {
    await interaction.reply({ content: `expression cooldown active. wait ${formatRemaining(limited)}`, flags: MessageFlags.Ephemeral });
    return;
  }
  const query = interaction.options.getString("query", true).trim();
  if (!interaction.guild) {
    await interaction.reply({ content: "stickers are only available in a server.", flags: MessageFlags.Ephemeral });
    return;
  }
  if (!canSend(interaction.channel)) {
    await interaction.reply({ content: "can't send stickers in this channel.", flags: MessageFlags.Ephemeral });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const resolved = await resolveGuildSticker(interaction.guild, query);
  if (!resolved) {
    await interaction.editReply("no matching server sticker found.");
    return;
  }
  await interaction.editReply("sticker sent.");
  await interaction.channel.send({ stickers: [resolved.sticker.id] });
  recordResolvedMedia(resolved.media, true);
}

async function handleAutoPostCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!canManageAutoPost(interaction)) {
    await interaction.reply({ content: "need Manage Channels to configure autopost.", flags: MessageFlags.Ephemeral });
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
      content: `autopost enabled: ${mode} every ${intervalMinutes}m${prompt ? ` | instruction: ${truncate(prompt, 300)}` : " | instruction: none; uses channel memory"}`,
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  if (subcommand === "off") {
    memory.disableAutoPost(interaction.channelId);
    scheduleAutoPostWakeup();
    await interaction.reply({ content: "autopost disabled.", flags: MessageFlags.Ephemeral });
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
      `instruction: ${current.prompt || "none; uses channel memory"}`
    ].join("\n"),
    flags: MessageFlags.Ephemeral
  });
}

async function handleHelpCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.reply({
    content: [
      `**${config.botName}**`,
      "`/chat prompt:` reply; add `image:` to inspect an image",
      "`/image prompt:` Venice lustify-v8 image; `adult:true` uses safe_mode=false",
      "`/gif query:` send a saved server GIF; URLs still work",
      "`/emote query:` post a matching server emoji",
      "`/sticker query:` post a matching server sticker",
      "Reply with `lemonai react <emoji name>` to react with a matching server emoji or direct Unicode emoji.",
      "Reply to image/GIF embeds or attach an image to `/chat` for vision.",
      "`/autopost set mode:both interval_minutes:30` scheduled channel post",
      "Mention me, reply to me, or start with `lemonai` for inline replies if auto-reply is enabled."
    ].join("\n"),
    flags: MessageFlags.Ephemeral
  });
}

function takeChatCooldown(userId: string, channelId: string): number {
  const now = Date.now();
  const limited = userCooldown.remaining(userId, now) || channelCooldown.remaining(channelId, now);
  if (limited) return limited;
  userCooldown.take(userId, now);
  channelCooldown.take(channelId, now);
  return 0;
}

function takeExpressionCooldown(userId: string, channelId: string): number {
  const now = Date.now();
  const key = `${userId}:${channelId}`;
  const limited = expressionCooldown.remaining(key, now);
  if (limited) return limited;
  expressionCooldown.take(key, now);
  return 0;
}

function isChannelAllowed(channelId: string | null): boolean {
  if (!channelId) return false;
  if (config.ignoredChannelIds.has(channelId)) return false;
  return config.allowedChannelIds.size === 0 || config.allowedChannelIds.has(channelId);
}

function serverPersonaProfile(guildId: string | undefined | null, channelId: string | undefined): string {
  return memory.serverPersonaContext(guildId ?? undefined, channelId, {
    botName: config.botName,
    botUserId: client.user?.id,
    excludedAuthorIds: config.personaExcludedAuthorIds
  });
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
  return withoutName || "respond to the referenced context";
}

function buildReplyContext(message: Message, referencedMessage: Message | null): ChatReplyContext | undefined {
  if (!referencedMessage) return undefined;
  const botId = client.user?.id;
  const relation = referencedMessage.author.id === botId
    ? "bot"
    : referencedMessage.author.id === message.author.id
      ? "current-speaker"
      : "other-user";
  return {
    messageId: referencedMessage.id,
    authorId: referencedMessage.author.id,
    authorName: displayName(referencedMessage),
    relation,
    contentExcerpt: truncate(summarizeMessageForContext(referencedMessage), 500)
  };
}

function summarizeMessageForContext(message: Message): string {
  const parts = [message.content.trim()];
  if (message.attachments.size > 0) parts.push(`[attachments: ${[...message.attachments.values()].map((attachment) => attachment.name ?? "unnamed").join(", ")}]`);
  if (message.embeds.length > 0) parts.push(`[embeds: ${message.embeds.map((embed) => embed.title ?? embed.description ?? embed.url ?? "media embed").join(", ")}]`);
  if (message.stickers.size > 0) parts.push(`[stickers: ${[...message.stickers.values()].map((sticker) => sticker.name).join(", ")}]`);
  return parts.filter(Boolean).join(" ") || "[no text; media/sticker/embed only]";
}

function memoryContentWithContext(content: string, replyContext?: ChatReplyContext, images: ChatImageInput[] = []): string {
  return [
    content,
    replyContext ? `[reply context: ${replyContext.relation} ${replyContext.authorName} (<@${replyContext.authorId}>) message ${replyContext.messageId}: ${replyContext.contentExcerpt}]` : "",
    imageMemorySummary(images)
  ].filter(Boolean).join(" ");
}

function shouldUseChannelContext(prompt: string, replyContext: ChatReplyContext | undefined): boolean {
  if (replyContext) return true;
  return /\b(remember|memory|history|earlier|previous|before|last|above|context|channel|server|persona|style|vibe|continue|more|again|that|this|it|those|they|them|he|she|who said|what did|when did|where did|why did)\b/i.test(prompt);
}

function imageMemorySummary(images: ChatImageInput[]): string {
  if (images.length === 0) return "";
  return `[media context: ${images.map((image, index) => {
    const author = image.authorName ? `${image.authorName}${image.authorId ? ` (<@${image.authorId}>)` : ""}` : "unknown author";
    const messageId = image.messageId ? ` msg ${image.messageId}` : "";
    return `image ${index + 1} ${image.source ?? "unknown-source"}/${image.sourceType ?? "unknown-media"} by ${author}${messageId}`;
  }).join("; ")}]`;
}

function privateChatImageInput(image: ChatImageInput): ChatImageInput {
  return {
    ...image,
    channelId: undefined,
    guildId: undefined,
    messageId: undefined,
    localPath: undefined
  };
}

async function handleExpressionMessage(message: Message, referencedMessage: Message | null, content: string): Promise<boolean> {
  const command = extractExpressionCommand(content);
  if (!command) return false;

  const limited = takeExpressionCooldown(message.author.id, message.channelId);
  if (limited) {
    await message.reply(`expression cooldown active. wait ${formatRemaining(limited)}`).catch(() => undefined);
    return true;
  }

  try {
    if (command.kind === "gif") {
      const directUrl = parseMediaUrl(command.query);
      const media = directUrl
        ? rememberTransientMedia(mediaInputFromUrl(directUrl, message.channelId, {
          guildId: message.guildId ?? undefined,
          authorId: message.author.id,
          authorName: displayName(message),
          messageId: message.id,
          sourceType: "text-url",
          hint: command.query
        }))
        : memory.findMedia(command.query, message.channelId, "gif", message.guildId ?? undefined);
      if (media) await replyToMessageWithMedia(message, media);
      else await message.reply("no matching saved GIF found. Direct GIF/image URLs still work.");
      return true;
    }

    if (command.kind === "sticker") {
      const resolved = message.guild ? await resolveGuildSticker(message.guild, command.query) : undefined;
      await message.reply(resolved ? { stickers: [resolved.sticker.id] } : { content: "no matching server sticker found." });
      if (resolved) recordResolvedMedia(resolved.media, true);
      return true;
    }

    const resolved = message.guild ? resolveGuildEmoji(message.guild, command.query) : undefined;
    if (!resolved) {
      await message.reply("no matching server emoji found.");
      return true;
    }

    if (command.kind === "react") {
      if (!referencedMessage) {
        await message.reply("reply to a message if you want me to react.");
        return true;
      }
      await referencedMessage.react(resolved.value);
      await message.react("✅").catch(() => undefined);
      recordResolvedMedia(resolved.media, true);
      return true;
    }

    await message.reply(String(resolved.value));
    recordResolvedMedia(resolved.media, true);
    return true;
  } catch (error) {
    logger.warn("expression command failed", { error: redactSecrets(error) });
    await message.reply("expression command failed.").catch(() => undefined);
    return true;
  }
}

async function maybeAmbientExpression(message: Message, content: string): Promise<boolean> {
  if (Math.random() >= config.ambientExpressionChance || !message.guild) return false;
  if (ambientCooldown.remaining(message.channelId)) return false;
  const roll = Math.random();

  if (roll < 0.45) {
    const resolved = resolveGuildEmoji(message.guild, content);
    if (!resolved) return false;
    if (ambientCooldown.take(message.channelId)) return false;
    await message.react(resolved.value).catch(() => undefined);
    recordResolvedMedia(resolved.media, true);
    return true;
  }

  if (roll < 0.75) {
    const media = memory.findMedia(content, message.channelId, "gif", message.guildId ?? undefined);
    if (!media || !canSend(message.channel)) return false;
    if (ambientCooldown.take(message.channelId)) return false;
    await sendMediaToChannel(message.channel, media).catch(() => undefined);
    return true;
  }

  if (roll < 0.9) {
    const resolved = await resolveGuildSticker(message.guild, content);
    if (!resolved || !canSend(message.channel)) return false;
    if (ambientCooldown.take(message.channelId)) return false;
    await message.channel.send({ stickers: [resolved.sticker.id] }).catch(() => undefined);
    recordResolvedMedia(resolved.media, true);
    return true;
  }

  const resolved = resolveGuildEmoji(message.guild, content);
  if (!resolved || !canSend(message.channel)) return false;
  if (ambientCooldown.take(message.channelId)) return false;
  await message.channel.send(String(resolved.value)).catch(() => undefined);
  recordResolvedMedia(resolved.media, true);
  return true;
}

async function maybeAmbientReply(message: Message, content: string): Promise<boolean> {
  if (Math.random() >= config.ambientReplyChance) return false;
  if (ambientCooldown.take(message.channelId)) return false;
  try {
    if (canSend(message.channel)) await message.channel.sendTyping?.();
    const prompt = [
      "Respond to the latest Discord message only when the supplied context supports an on-topic reply.",
      "Produce one short message. Do not announce that this was automatic.",
      `Latest message from ${displayName(message)} (<@${message.author.id}>): ${content}`
    ].join("\n");
    const history = memory.get(message.channelId);
    const response = await ai.chat({
      systemPrompt,
      prompt,
      authorName: displayName(message),
      history,
      memoryContext: memory.context(message.channelId, prompt, config.memoryRecallMessages, message.guildId ?? undefined),
      personaContext: serverPersonaProfile(message.guildId, message.channelId)
    });
    await sendChunkedReply(message, response);
    memory.remember(message.channelId, {
      role: "assistant",
      authorId: client.user?.id ?? "lemonai",
      authorName: config.botName,
      content: response,
      guildId: message.guildId ?? undefined
    });
    return true;
  } catch (error) {
    logger.warn("ambient reply failed", { error: redactSecrets(error) });
    return false;
  }
}

function extractExpressionCommand(content: string): { kind: "gif" | "sticker" | "emote" | "react"; query: string } | null {
  const botId = client.user?.id;
  const prefix = botId ? `(?:<@!?${botId}>|lemon\\s*ai|lemonai)` : "(?:lemon\\s*ai|lemonai)";
  const match = content.match(new RegExp(`^${prefix}\\s+(gif|sticker|emote|emoji|react)(?:\\s+(.+))?$`, "i"));
  if (!match) return null;
  const rawKind = match[1]?.toLowerCase();
  const kind = rawKind === "emoji" ? "emote" : rawKind;
  if (kind !== "gif" && kind !== "sticker" && kind !== "emote" && kind !== "react") return null;
  return { kind, query: match[2]?.trim() || "" };
}

function rememberMessageMedia(message: Message): void {
  const items = mediaInputsFromMessage(message);
  memory.rememberMediaMany(items);
  for (const item of items.filter(isCacheableMedia).slice(0, 4)) {
    void cacheAndUpdateMedia(item).catch((error) => {
      logger.debug("media cache failed", { url: item.url, error: redactSecrets(error) });
    });
  }
  enqueueMediaAnalysis(items);
}

function enqueueMediaAnalysis(items: MediaInput[]): void {
  if (!config.mediaAnalysisEnabled || config.mediaAnalysisMaxPerHour <= 0 || config.mediaAnalysisQueueMax <= 0 || !ai.hasVision()) return;
  for (const item of items) {
    if (mediaAnalysisQueue.length >= config.mediaAnalysisQueueMax) break;
    const key = mediaAnalysisKey(item);
    const media = memory.getMedia(item.url, item.channelId) ?? item;
    if (!shouldAnalyzeMedia(media) || queuedMediaAnalysis.has(key)) continue;
    queuedMediaAnalysis.add(key);
    mediaAnalysisQueue.push({ url: item.url, channelId: item.channelId });
  }
  pumpMediaAnalysisQueue();
}

function recoverMediaAnalysisQueue(): void {
  if (!config.mediaAnalysisEnabled || !ai.hasVision()) return;
  const recovered: MediaInput[] = [];
  for (const media of memory.allMedia()) {
    const hasAnalysisOutput = Boolean(media.caption.trim() || media.ocrText.trim());
    if (media.analysisStatus === "analyzing" || (media.analysisStatus === "ready" && !hasAnalysisOutput)) {
      const patch = {
        analysisStatus: "pending" as const,
        lastAnalysisError: media.analysisStatus === "analyzing" ? "recovered stale analyzing state after startup" : undefined,
        duplicateOfUrl: undefined,
        analyzedAt: undefined
      };
      memory.updateMedia(media.url, media.channelId, patch);
      recovered.push({ ...media, ...patch });
    } else if (shouldAnalyzeMedia(media)) {
      recovered.push(media);
    }
  }
  enqueueMediaAnalysis(recovered);
}

function pumpMediaAnalysisQueue(): void {
  while (mediaAnalysisActive < config.mediaAnalysisConcurrency && mediaAnalysisQueue.length > 0) {
    if (!takeMediaAnalysisBudget()) {
      scheduleMediaAnalysisResume();
      return;
    }
    const item = mediaAnalysisQueue.shift();
    if (!item) return;
    mediaAnalysisActive += 1;
    void analyzeQueuedMedia(item).catch((error) => {
      logger.debug("media analysis failed", { url: item.url, error: redactSecrets(error) });
    }).finally(() => {
      mediaAnalysisActive -= 1;
      queuedMediaAnalysis.delete(mediaAnalysisKey(item));
      if (item.retry) requeueMediaAnalysis(item);
      pumpMediaAnalysisQueue();
    });
  }
}

function requeueMediaAnalysis(item: MediaAnalysisQueueItem): void {
  if (mediaAnalysisQueue.length >= config.mediaAnalysisQueueMax) return;
  const retry = { url: item.url, channelId: item.channelId };
  const key = mediaAnalysisKey(retry);
  if (queuedMediaAnalysis.has(key)) return;
  queuedMediaAnalysis.add(key);
  mediaAnalysisQueue.push(retry);
}

function scheduleMediaAnalysisResume(): void {
  if (mediaAnalysisResumeTimer || mediaAnalysisQueue.length === 0) return;
  const nextAt = (mediaAnalysisStartedAt[0] ?? Date.now()) + 3_600_000;
  mediaAnalysisResumeTimer = setTimeout(() => {
    mediaAnalysisResumeTimer = undefined;
    pumpMediaAnalysisQueue();
  }, Math.max(1_000, nextAt - Date.now()));
}

async function analyzeQueuedMedia(item: MediaAnalysisQueueItem): Promise<void> {
  const media = memory.getMedia(item.url, item.channelId);
  if (!media || !shouldAnalyzeMedia(media)) return;
  const cached = await cacheAndUpdateMedia(media);
  const current = memory.getMedia(item.url, item.channelId) ?? { ...media, ...mediaPatchFromCache(cached) };
  if (!shouldAnalyzeMedia(current)) return;
  if (current.validationStatus !== "valid" || !isEmbeddableImageType(current.contentType)) {
    markMediaAnalysisSkipped(current, current.validationError ?? "media could not be validated for analysis");
    return;
  }
  if ((current.size ?? 0) > config.mediaAnalysisMaxBytes) {
    markMediaAnalysisSkipped(current, `media too large for analysis (${current.size} bytes)`);
    return;
  }

  if (current.sha256) {
    const duplicate = memory.findAnalyzedDuplicate(current.channelId, current.sha256, current.url);
    if (duplicate) {
      const tags = mergeTags(current.tags, duplicate.tags);
      memory.updateMedia(current.url, current.channelId, {
        caption: duplicate.caption || current.caption,
        ocrText: duplicate.ocrText || current.ocrText,
        tags,
        analysisStatus: "ready",
        analyzedAt: Date.now(),
        duplicateOfUrl: duplicate.url
      });
      return;
    }
  }

  const attempts = current.analysisAttempts + 1;
  memory.updateMedia(current.url, current.channelId, {
    analysisStatus: "analyzing",
    analysisAttempts: attempts,
    lastAnalysisError: undefined
  });

  try {
    const analysis = await ai.analyzeMedia({
      url: mediaDirectUrl(current) ?? current.url,
      contentType: current.contentType,
      localPath: current.localPath,
      alternateUrls: [current.proxyUrl, current.directUrl].filter((item): item is string => Boolean(item)),
      sourceType: current.sourceType === "attachment" ? "attachment" : "embed",
      authorId: current.authorId,
      authorName: current.authorName,
      messageId: current.messageId
    }, [
      current.hint,
      current.title,
      current.description,
      current.filename,
      current.emojiName
    ].filter(Boolean).join(" | "));

    const patch = {
      caption: analysis.caption || current.caption,
      ocrText: analysis.ocrText || current.ocrText,
      tags: mergeTags(current.tags, analysis.tags),
      analysisStatus: "ready" as const,
      analysisAttempts: attempts,
      lastAnalysisError: undefined,
      analyzedAt: Date.now()
    };
    memory.updateMedia(current.url, current.channelId, patch);
    if (current.sha256) {
      memory.updateMediaBySha256(current.channelId, current.sha256, {
        ...patch,
        duplicateOfUrl: current.url
      }, current.url);
    }
  } catch (error) {
    const terminal = attempts >= config.mediaAnalysisMaxAttempts;
    memory.updateMedia(current.url, current.channelId, {
      analysisStatus: terminal ? "failed" : "pending",
      analysisAttempts: attempts,
      lastAnalysisError: truncate(redactSecrets(error), 500),
      analyzedAt: Date.now()
    });
    logger.debug("media analysis attempt failed", { url: current.url, attempts, terminal, error: redactSecrets(error) });
    if (!terminal) item.retry = true;
  }
}

function markMediaAnalysisSkipped(media: MediaMemory, reason: string): void {
  memory.updateMedia(media.url, media.channelId, {
    analysisStatus: "skipped",
    lastAnalysisError: truncate(reason, 500),
    analyzedAt: Date.now()
  });
}

function mediaAnalysisKey(item: Pick<MediaInput, "url" | "channelId">): string {
  return `${item.channelId}\u0000${item.url}`;
}

function shouldAnalyzeMedia(media: MediaInput | MediaMemory): boolean {
  if (!config.mediaAnalysisEnabled || config.mediaAnalysisMaxPerHour <= 0 || !ai.hasVision()) return false;
  if (media.analysisStatus === "ready" || media.analysisStatus === "skipped") return false;
  if (media.analysisStatus === "analyzing" && media.analyzedAt !== undefined && Date.now() - media.analyzedAt < staleMediaAnalysisMs) return false;
  if (media.analysisStatus === "failed" && (media.analysisAttempts ?? 0) >= config.mediaAnalysisMaxAttempts) return false;
  if (media.caption?.trim() || media.ocrText?.trim()) return false;
  if (media.validationStatus === "invalid" || media.validationStatus === "failed") return false;
  if (media.renderMode === "raw_url" || media.renderMode === "disabled") return false;
  if (media.size !== undefined && media.size > config.mediaAnalysisMaxBytes) return false;
  if (media.kind !== "image" && media.kind !== "gif" && media.kind !== "sticker" && media.kind !== "emoji") return false;
  return mediaCacheUrls(media).length > 0;
}

function takeMediaAnalysisBudget(): boolean {
  if (config.mediaAnalysisMaxPerHour <= 0) return false;
  const cutoff = Date.now() - 3_600_000;
  while (mediaAnalysisStartedAt[0] !== undefined && mediaAnalysisStartedAt[0] < cutoff) mediaAnalysisStartedAt.shift();
  if (mediaAnalysisStartedAt.length >= config.mediaAnalysisMaxPerHour) return false;
  mediaAnalysisStartedAt.push(Date.now());
  return true;
}

function mergeTags(current: string[], incoming: string[]): string[] {
  return [...new Set([...current, ...incoming].flatMap(expressionTerms))].slice(0, 20);
}

async function rememberReactionMedia(reaction: MessageReaction | PartialMessageReaction, user: User | PartialUser): Promise<void> {
  const knownChannelId = reaction.message.channelId;
  if (knownChannelId && !isChannelAllowed(knownChannelId)) return;
  if (reactionCaptureCooldown.take(`${knownChannelId ?? "unknown"}:${user.id}`)) return;
  const fullUser = user.partial ? await user.fetch() : user;
  if (fullUser.bot) return;
  const fullReaction = reaction.partial ? await reaction.fetch() : reaction;
  const message = fullReaction.message.partial ? await fullReaction.message.fetch() : fullReaction.message;
  if (!message.guildId || !isChannelAllowed(message.channelId)) return;

  const emoji = fullReaction.emoji;
  const emojiName = emoji.name ?? "emoji";
  const isCustom = Boolean(emoji.id);
  const url = isCustom
    ? `https://cdn.discordapp.com/emojis/${emoji.id}.${emoji.animated ? "gif" : "png"}`
    : `unicode-emoji:${encodeURIComponent(emojiName)}`;
  const item: MediaInput = {
    url,
    kind: "emoji",
    channelId: message.channelId,
    guildId: message.guildId,
    authorId: fullUser.id,
    authorName: fullUser.username,
    messageId: message.id,
    sourceType: "reaction",
    emojiId: emoji.id ?? undefined,
    emojiName,
    filename: isCustom ? `${emojiName}.${emoji.animated ? "gif" : "png"}` : undefined,
    title: emojiName,
    contentType: isCustom ? (emoji.animated ? "image/gif" : "image/png") : undefined,
    directUrl: isCustom ? url : undefined,
    hint: `reaction ${emojiName} on: ${summarizeMessageForContext(message).slice(0, 300)}`,
    status: "reaction",
    uses: Math.max(1, fullReaction.count ?? 1),
    validationStatus: isCustom ? "unvalidated" : "valid",
    renderMode: isCustom ? "unknown" : "disabled",
    caption: "",
    ocrText: "",
    tags: mergeTags([emojiName], expressionTerms(message.content))
  };
  memory.rememberMedia(item);
  enqueueMediaAnalysis([item]);
}

function mediaInputsFromMessage(message: Message): MediaInput[] {
  return messageMedia(message);
}

function messageMedia(message: Message): MediaInput[] {
  const hint = mediaHint(message);
  const media = new Map<string, MediaInput>();
  const base = {
    channelId: message.channelId,
    guildId: message.guildId ?? undefined,
    authorId: message.author.id,
    authorName: displayName(message),
    messageId: message.id,
    hint
  };

  const remember = (item: MediaInput) => {
    media.set(item.url, { ...media.get(item.url), ...item, hint: item.hint || hint });
  };

  for (const attachment of message.attachments.values()) {
    if (attachment.contentType?.startsWith("image/") || looksLikeMediaUrl(attachment.url) || looksLikeMediaUrl(attachment.name ?? "")) {
      remember({
        ...base,
        url: attachment.url,
        kind: mediaKind(attachment.url, attachment.contentType ?? ""),
        sourceType: "attachment",
        attachmentId: attachment.id,
        filename: attachment.name ?? undefined,
        title: attachment.title ?? undefined,
        description: attachment.description ?? undefined,
        contentType: attachment.contentType ?? undefined,
        size: attachment.size,
        width: attachment.width,
        height: attachment.height,
        directUrl: attachment.url,
        proxyUrl: attachment.proxyURL ?? undefined,
        validationStatus: "unvalidated",
        renderMode: "unknown",
        caption: "",
        tags: []
      });
    }
  }

  for (const embed of message.embeds) {
    const pageUrl = typeof embed.url === "string" && looksLikeMediaUrl(embed.url) ? embed.url : undefined;
    for (const source of [
      { url: embed.image?.url, proxyUrl: embed.image?.proxyURL, width: embed.image?.width, height: embed.image?.height },
      { url: embed.thumbnail?.url, proxyUrl: embed.thumbnail?.proxyURL, width: embed.thumbnail?.width, height: embed.thumbnail?.height },
      { url: embed.video?.url, proxyUrl: embed.video?.proxyURL, width: embed.video?.width, height: embed.video?.height }
    ]) {
      if (typeof source.url !== "string" || !looksLikeMediaUrl(source.url)) continue;
      remember({
        ...base,
        url: source.url,
        kind: mediaKind(source.url),
        sourceType: "embed",
        title: embed.title ?? undefined,
        description: embed.description ?? undefined,
        width: source.width ?? undefined,
        height: source.height ?? undefined,
        directUrl: looksLikeDirectMediaUrl(source.url) ? source.url : undefined,
        proxyUrl: source.proxyUrl ?? undefined,
        pageUrl,
        validationStatus: "unvalidated",
        renderMode: isPageMediaUrl(source.url) ? "raw_url" : "unknown",
        caption: "",
        tags: []
      });
    }
    if (pageUrl && ![...media.values()].some((item) => item.pageUrl === pageUrl || item.url === pageUrl)) {
      remember(mediaInputFromUrl(pageUrl, message.channelId, {
        ...base,
        sourceType: "embed",
        title: embed.title ?? undefined,
        description: embed.description ?? undefined,
        hint
      }));
    }
  }

  for (const match of message.content.matchAll(/https?:\/\/\S+/gi)) {
    const url = parseMediaUrl(match[0].replace(/[>)\].,!?'";:]+$/g, ""));
    if (url) remember(mediaInputFromUrl(url, message.channelId, { ...base, sourceType: "text-url", hint }));
  }

  for (const sticker of message.stickers.values()) {
    remember({
      ...base,
      url: sticker.url,
      kind: "sticker",
      sourceType: "sticker",
      stickerId: sticker.id,
      title: sticker.name,
      description: sticker.description ?? undefined,
      tags: sticker.tags ? expressionTerms(sticker.tags) : [],
      directUrl: sticker.url,
      validationStatus: "unvalidated",
      renderMode: "unknown",
      caption: ""
    });
  }

  for (const match of message.content.matchAll(/<(a?):([A-Za-z0-9_]{2,32}):(\d{17,22})>/g)) {
    const animated = match[1] === "a";
    const name = match[2] ?? "emoji";
    const id = match[3];
    if (!id) continue;
    const url = `https://cdn.discordapp.com/emojis/${id}.${animated ? "gif" : "png"}`;
    remember({
      ...base,
      url,
      kind: "emoji",
      sourceType: "inline-emoji",
      emojiId: id,
      emojiName: name,
      filename: `${name}.${animated ? "gif" : "png"}`,
      title: name,
      contentType: animated ? "image/gif" : "image/png",
      directUrl: url,
      validationStatus: "unvalidated",
      renderMode: "unknown",
      caption: "",
      tags: [name]
    });
  }

  return [...media.values()];
}

function mediaHint(message: Message): string {
  const parts = [
    message.content,
    ...[...message.attachments.values()].map((attachment) => attachment.name ?? ""),
    ...message.embeds.flatMap((embed) => [embed.title ?? "", embed.description ?? "", embed.author?.name ?? ""])
  ];
  return parts.join(" ").trim() || "discord media";
}

function mediaKind(url: string, contentType = ""): "gif" | "image" {
  return contentType.includes("gif") || /(?:\.gif(?:[?#].*)?$|tenor\.com|giphy\.com|gifv)/i.test(url) ? "gif" : "image";
}

function mediaInputFromUrl(url: string, channelId: string, options: Partial<MediaInput> = {}): MediaInput {
  const pageUrl = options.pageUrl ?? (isPageMediaUrl(url) ? url : undefined);
  const directUrl = options.directUrl ?? (!pageUrl && looksLikeDirectMediaUrl(url) ? url : undefined);
  return {
    ...options,
    url,
    channelId,
    kind: options.kind ?? mediaKind(url, options.contentType),
    hint: options.hint?.trim() || url,
    pageUrl,
    directUrl,
    status: options.status ?? "seen",
    validationStatus: options.validationStatus ?? "unvalidated",
    renderMode: options.renderMode ?? (pageUrl ? "raw_url" : "unknown"),
    caption: options.caption ?? "",
    tags: options.tags ?? []
  };
}

function rememberTransientMedia(item: MediaInput): MediaMemory | MediaInput {
  memory.rememberMedia(item);
  return memory.getMedia(item.url, item.channelId) ?? item;
}

function isCacheableMedia(item: MediaInput): boolean {
  return mediaCacheUrls(item).length > 0 && item.renderMode !== "raw_url";
}

async function cacheAndUpdateMedia(item: MediaCandidate): Promise<CachedMedia> {
  const urls = mediaCacheUrls(item);
  if (urls.length === 0) {
    return {
      directUrl: item.url,
      status: "invalid",
      validationStatus: "invalid",
      validationError: "no direct media URL available",
      validatedAt: Date.now(),
      renderMode: "raw_url"
    };
  }

  let last: CachedMedia | undefined;
  for (const url of urls) {
    const cached = await cacheMediaUrl(url, mediaCacheConfig, item.contentType);
    last = cached;
    if (cached.validationStatus === "valid") {
      memory.updateMedia(item.url, item.channelId, mediaPatchFromCache(cached));
      return cached;
    }
  }

  const failed = last ?? {
    directUrl: item.url,
    status: "failed" as const,
    validationStatus: "failed" as const,
    validationError: "no media URLs validated",
    validatedAt: Date.now(),
    renderMode: "raw_url" as const
  };
  memory.updateMedia(item.url, item.channelId, mediaPatchFromCache(failed));
  return failed;
}

function mediaPatchFromCache(cached: CachedMedia): Partial<MediaMemory> {
  return {
    directUrl: cached.directUrl,
    contentType: cached.contentType,
    size: cached.size,
    sha256: cached.sha256,
    localPath: cached.localPath,
    status: cached.status,
    validationStatus: cached.validationStatus,
    validationError: cached.validationError,
    validatedAt: cached.validatedAt,
    renderMode: cached.renderMode
  };
}

async function cacheVisionImages(images: ChatImageInput[]): Promise<ChatImageInput[]> {
  const prepared = await Promise.all(images.map(cacheVisionImage));
  return prepared.filter((image): image is ChatImageInput => image !== null);
}

async function cacheVisionImage(image: ChatImageInput): Promise<ChatImageInput | null> {
  const cached = mediaForImage(image);
  if (cached?.localPath) return imageWithCachedMedia(image, cached);

  const result = await cacheMediaUrl(image.url, mediaCacheConfig, image.contentType);
  if (result.validationStatus === "valid") {
    if (image.channelId) memory.updateMedia(image.url, image.channelId, mediaPatchFromCache(result));
    return {
      ...image,
      contentType: result.contentType ?? image.contentType,
      localPath: result.localPath,
      alternateUrls: image.alternateUrls
    };
  }

  if (image.channelId) memory.updateMedia(image.url, image.channelId, mediaPatchFromCache(result));
  return null;
}

function mediaForImage(image: ChatImageInput): MediaMemory | undefined {
  if (!image.channelId) return undefined;
  for (const url of [image.url, ...(image.alternateUrls ?? [])]) {
    const media = memory.getMedia(url, image.channelId);
    if (media) return media;
  }
  return undefined;
}

function imageWithCachedMedia(image: ChatImageInput, media: MediaMemory): ChatImageInput {
  return {
    ...image,
    contentType: media.contentType ?? image.contentType,
    localPath: media.localPath ?? image.localPath,
    alternateUrls: [...new Set([...(image.alternateUrls ?? []), media.proxyUrl, media.directUrl].filter((url): url is string => Boolean(url)))]
  };
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
  const current = imageInputsFromMessage(message, "current-message");
  const referenced = referencedMessage ? imageInputsFromMessage(referencedMessage, "referenced-message") : [];
  return [...current, ...referenced].slice(0, 4);
}

function imageInputsFromMessage(message: Message, source: "current-message" | "referenced-message"): ChatImageInput[] {
  const provenance = {
    source,
    channelId: message.channelId,
    guildId: message.guildId ?? undefined,
    authorId: message.author.id,
    authorName: displayName(message),
    messageId: message.id
  } satisfies Pick<ChatImageInput, "source" | "channelId" | "guildId" | "authorId" | "authorName" | "messageId">;
  return [
    ...imageInputsFromAttachments(message.attachments, provenance),
    ...imageInputsFromEmbeds(message.embeds, provenance),
    ...imageInputsFromText(message.content, provenance)
  ];
}

function imageInputsFromAttachments(attachments: Message["attachments"] | undefined, provenance: Pick<ChatImageInput, "source" | "channelId" | "guildId" | "authorId" | "authorName" | "messageId">): ChatImageInput[] {
  return [...(attachments?.values() ?? [])].flatMap((attachment) => imageInputFromAttachment(attachment, { ...provenance, sourceType: "attachment" }));
}

function imageInputFromAttachment(attachment: Attachment, provenance: Pick<ChatImageInput, "source" | "sourceType" | "channelId" | "guildId" | "authorId" | "authorName" | "messageId">): ChatImageInput[] {
  const contentType = attachment.contentType ?? "";
  const name = attachment.name ?? "";
  const looksLikeImage = contentType.startsWith("image/") || looksLikeMediaUrl(name);
  const cached = provenance.channelId ? memory.getMedia(attachment.url, provenance.channelId) : undefined;
  return looksLikeImage ? [{
    url: attachment.url,
    detail: "auto",
    contentType: cached?.contentType ?? attachment.contentType ?? undefined,
    localPath: cached?.localPath,
    alternateUrls: [attachment.proxyURL].filter((url): url is string => typeof url === "string" && url.length > 0),
    ...provenance
  }] : [];
}

function imageInputsFromEmbeds(embeds: Message["embeds"] | undefined, provenance: Pick<ChatImageInput, "source" | "channelId" | "guildId" | "authorId" | "authorName" | "messageId">): ChatImageInput[] {
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
    return urls.map((url) => {
      const cached = provenance.channelId ? memory.getMedia(url, provenance.channelId) : undefined;
      return {
        url,
        detail: "auto" as const,
        contentType: cached?.contentType,
        localPath: cached?.localPath,
        alternateUrls: [cached?.proxyUrl, cached?.directUrl].filter((alternate): alternate is string => Boolean(alternate) && alternate !== url),
        ...provenance,
        sourceType: "embed" as const
      };
    });
  });
}

function imageInputsFromText(content: string, provenance: Pick<ChatImageInput, "source" | "channelId" | "guildId" | "authorId" | "authorName" | "messageId">): ChatImageInput[] {
  return [...content.matchAll(/https?:\/\/\S+/gi)]
    .map((match) => match[0].replace(/[>)\].,!?'";:]+$/g, ""))
    .filter(looksLikeMediaUrl)
    .map((url) => {
      const cached = provenance.channelId ? memory.getMedia(url, provenance.channelId) : undefined;
      return {
        url,
        detail: "auto" as const,
        contentType: cached?.contentType,
        localPath: cached?.localPath,
        alternateUrls: [cached?.proxyUrl, cached?.directUrl].filter((alternate): alternate is string => Boolean(alternate) && alternate !== url),
        ...provenance,
        sourceType: "text-url" as const
      };
    });
}

function looksLikeMediaUrl(value: string): boolean {
  return /\.(?:png|jpe?g|webp|gif)(?:[?#].*)?$/i.test(value) || /(?:tenor\.com|media\.tenor\.com|giphy\.com|media\.giphy\.com|cdn\.discordapp\.com|media\.discordapp\.net)/i.test(value);
}

function looksLikeDirectMediaUrl(value: string): boolean {
  return /\.(?:png|jpe?g|webp|gif|avif)(?:[?#].*)?$/i.test(value);
}

function isPageMediaUrl(value: string): boolean {
  if (looksLikeDirectMediaUrl(value)) return false;
  return /(?:^|\.)tenor\.com|(?:^|\.)giphy\.com/i.test(hostOf(value));
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

type MediaCandidate = MediaInput | MediaMemory;
type MediaSendPayload = string | { content?: string; embeds?: EmbedBuilder[]; files?: AttachmentBuilder[] };
type MediaSendPlan = {
  primary: MediaSendPayload;
  uploadFallback?: MediaSendPayload;
  rawFallback: string;
};
type ResolvedEmoji = { value: GuildEmoji | string; media?: MediaMemory };
type ResolvedSticker = { sticker: Sticker; media?: MediaMemory };

async function mediaReplyPayload(media: MediaCandidate): Promise<MediaSendPayload> {
  return (await mediaSendPlan(media)).primary;
}

async function mediaSendPlan(media: MediaCandidate): Promise<MediaSendPlan> {
  const prepared = await prepareMediaForSend(media);
  const attachment = mediaAttachment(prepared);
  const directUrl = mediaDirectUrl(prepared);
  const rawFallback = prepared.pageUrl ?? directUrl ?? prepared.url;
  const uploadFallback = attachment ? { files: [attachment] } : undefined;
  if (prepared.renderMode === "upload_file" && uploadFallback) {
    return { primary: uploadFallback, rawFallback };
  }
  if (directUrl && prepared.validationStatus === "valid" && isEmbeddableImageType(prepared.contentType)) {
    return { primary: { embeds: [mediaEmbed(directUrl)] }, uploadFallback, rawFallback };
  }

  if (uploadFallback) return { primary: uploadFallback, rawFallback };
  return { primary: rawFallback, rawFallback };
}

async function replyWithMedia(interaction: ChatInputCommandInteraction, media: MediaCandidate): Promise<void> {
  const plan = await mediaSendPlan(media);
  try {
    await sendInteractionMedia(interaction, plan.primary);
    recordMediaSend(media, true);
  } catch (error) {
    recordMediaSend(media, false);
    logger.warn("media reply failed, falling back", { url: media.url, error: redactSecrets(error) });
    if (plan.uploadFallback) {
      updateMediaRenderMode(media, "upload_file");
      try {
        await sendInteractionMedia(interaction, plan.uploadFallback);
        recordMediaSend(media, true);
        return;
      } catch (fallbackError) {
        recordMediaSend(media, false);
        logger.warn("media upload fallback failed", { url: media.url, error: redactSecrets(fallbackError) });
      }
    }
    updateMediaRenderMode(media, "raw_url");
    try {
      await sendInteractionMedia(interaction, plan.rawFallback);
      recordMediaSend(media, true);
    } catch (fallbackError) {
      recordMediaSend(media, false);
      throw fallbackError;
    }
  }
}

async function replyToMessageWithMedia(message: Message, media: MediaCandidate): Promise<void> {
  const plan = await mediaSendPlan(media);
  try {
    await message.reply(plan.primary);
    recordMediaSend(media, true);
  } catch (error) {
    recordMediaSend(media, false);
    logger.warn("message media reply failed, falling back", { url: media.url, error: redactSecrets(error) });
    if (plan.uploadFallback) {
      updateMediaRenderMode(media, "upload_file");
      try {
        await message.reply(plan.uploadFallback);
        recordMediaSend(media, true);
        return;
      } catch (fallbackError) {
        recordMediaSend(media, false);
        logger.warn("message media upload fallback failed", { url: media.url, error: redactSecrets(fallbackError) });
      }
    }
    updateMediaRenderMode(media, "raw_url");
    try {
      await message.reply(plan.rawFallback);
      recordMediaSend(media, true);
    } catch (fallbackError) {
      recordMediaSend(media, false);
      throw fallbackError;
    }
  }
}

async function sendMediaToChannel(channel: { send: (content: string | MediaSendPayload) => Promise<unknown> }, media: MediaCandidate): Promise<void> {
  const plan = await mediaSendPlan(media);
  try {
    await channel.send(plan.primary);
    recordMediaSend(media, true);
  } catch (error) {
    recordMediaSend(media, false);
    logger.warn("channel media send failed, falling back", { url: media.url, error: redactSecrets(error) });
    if (plan.uploadFallback) {
      updateMediaRenderMode(media, "upload_file");
      try {
        await channel.send(plan.uploadFallback);
        recordMediaSend(media, true);
        return;
      } catch (fallbackError) {
        recordMediaSend(media, false);
        logger.warn("channel media upload fallback failed", { url: media.url, error: redactSecrets(fallbackError) });
      }
    }
    updateMediaRenderMode(media, "raw_url");
    try {
      await channel.send(plan.rawFallback);
      recordMediaSend(media, true);
    } catch (fallbackError) {
      recordMediaSend(media, false);
      throw fallbackError;
    }
  }
}

async function sendInteractionMedia(interaction: ChatInputCommandInteraction, payload: MediaSendPayload): Promise<void> {
  if (interaction.deferred || interaction.replied) await interaction.editReply(payload);
  else await interaction.reply(payload);
}

function recordMediaSend(media: MediaCandidate, success: boolean): void {
  memory.recordMediaSend(media.url, media.channelId, success);
}

function updateMediaRenderMode(media: MediaCandidate, renderMode: "upload_file" | "raw_url"): void {
  memory.updateMedia(media.url, media.channelId, { renderMode });
}

async function prepareMediaForSend(media: MediaCandidate): Promise<MediaCandidate> {
  if (media.localPath && isEmbeddableImageType(media.contentType) && (media.size ?? 0) <= config.mediaUploadMaxBytes) {
    return { ...media, renderMode: "upload_file", validationStatus: "valid" };
  }
  if (media.renderMode === "raw_url" || isPageMediaUrl(media.url)) return { ...media, renderMode: "raw_url" };

  const directUrl = mediaDirectUrl(media);
  if (!directUrl) return { ...media, renderMode: "raw_url" };
  if (media.validationStatus === "valid" && isEmbeddableImageType(media.contentType)) return media;

  const cached = await cacheAndUpdateMedia(media);
  return { ...media, ...mediaPatchFromCache(cached) };
}

function mediaAttachment(media: MediaCandidate): AttachmentBuilder | undefined {
  if (!media.localPath || !isEmbeddableImageType(media.contentType)) return undefined;
  if ((media.size ?? Number.POSITIVE_INFINITY) > config.mediaUploadMaxBytes) return undefined;
  const fallbackName = `media.${extensionForContentType(media.contentType)}`;
  return new AttachmentBuilder(media.localPath, { name: safeFilename(media.filename ?? fallbackName) });
}

function isEmbeddableImageType(contentType: string | undefined): contentType is "image/gif" | "image/png" | "image/jpeg" | "image/webp" {
  return isSupportedImageContentType(contentType);
}

function rawMediaUrl(media: MediaCandidate): string {
  return media.pageUrl ?? mediaDirectUrl(media) ?? media.url;
}

function mediaDirectUrl(media: Pick<MediaCandidate, "url" | "directUrl" | "pageUrl">): string | undefined {
  if (media.directUrl) return media.directUrl;
  if (!media.pageUrl && !isPageMediaUrl(media.url) && looksLikeDirectMediaUrl(media.url)) return media.url;
  return undefined;
}

function mediaCacheUrls(media: MediaCandidate): string[] {
  return [...new Set([mediaDirectUrl(media), media.proxyUrl].filter((url): url is string => typeof url === "string" && !isPageMediaUrl(url)))];
}

function safeFilename(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120) || "media.png";
}

function hostOf(value: string): string {
  try {
    return new URL(value).hostname;
  } catch {
    return "";
  }
}

function resolveGuildEmoji(guild: Guild, query: string): ResolvedEmoji | undefined {
  const terms = expressionTerms(query);
  const unicode = terms.length === 0 ? resolveUnicodeEmoji(query) : undefined;
  if (unicode) return { value: unicode };
  if (terms.length === 0) return undefined;
  const learned = resolveLearnedEmoji(guild, query);
  if (learned) return learned;
  const emoji = bestEmoji([...guild.emojis.cache.values()], query);
  if (emoji) return { value: emoji };
  return undefined;
}

function resolveLearnedEmoji(guild: Guild, query: string): ResolvedEmoji | undefined {
  const learned = memory.findMedia(query, "", "emoji", guild.id);
  if (!learned) return undefined;
  if (learned.emojiId) {
    const emoji = guild.emojis.cache.get(learned.emojiId);
    if (emoji && emoji.available !== false) return { value: emoji, media: learned };
  }
  if (learned.url.startsWith("unicode-emoji:")) {
    return { value: decodeURIComponent(learned.url.slice("unicode-emoji:".length)), media: learned };
  }
  if (learned.emojiName) {
    const emoji = bestEmoji([...guild.emojis.cache.values()], learned.emojiName);
    if (emoji && emoji.available !== false) return { value: emoji, media: learned };
  }
  return undefined;
}

async function resolveGuildSticker(guild: Guild, query: string): Promise<ResolvedSticker | undefined> {
  if (expressionTerms(query).length === 0) return undefined;
  const stickers = await guildStickers(guild);
  const learned = memory.findMedia(query, "", "sticker", guild.id);
  if (learned) {
    const sticker = learned.stickerId
      ? stickers.find((candidate) => candidate.id === learned.stickerId)
      : bestSticker(stickers, learned.title ?? learned.filename ?? learned.hint);
    if (sticker) return { sticker, media: learned };
  }
  const sticker = bestSticker(stickers, query);
  return sticker ? { sticker } : undefined;
}

async function guildStickers(guild: Guild): Promise<Sticker[]> {
  const now = Date.now();
  const cached = guildStickerSnapshots.get(guild.id);
  if (cached && now - cached.fetchedAt < config.expressionCacheTtlMs) return cached.stickers;

  try {
    await guild.stickers.fetch();
    const stickers = [...guild.stickers.cache.values()];
    guildStickerSnapshots.set(guild.id, { fetchedAt: now, stickers });
    return stickers;
  } catch {
    return cached?.stickers ?? [...guild.stickers.cache.values()];
  }
}

function bestEmoji(emojis: GuildEmoji[], query: string): GuildEmoji | undefined {
  return emojis
    .map((emoji) => ({ emoji, score: scoreNamedThing(query, [emoji.name ?? "", emoji.identifier]) }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || a.emoji.name.localeCompare(b.emoji.name))[0]?.emoji;
}

function bestSticker(stickers: Sticker[], query: string): Sticker | undefined {
  return stickers
    .map((sticker) => ({ sticker, score: scoreNamedThing(query, [sticker.name, sticker.description ?? "", sticker.tags ?? ""]) }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || a.sticker.name.localeCompare(b.sticker.name))[0]?.sticker;
}

function recordResolvedMedia(media: MediaMemory | undefined, success: boolean): void {
  if (media) memory.recordMediaSend(media.url, media.channelId, success);
}

function resolveUnicodeEmoji(query: string): string | undefined {
  return query.trim().match(/\p{Extended_Pictographic}(?:[\uFE0E\uFE0F\u{1F3FB}-\u{1F3FF}]|\u200D\p{Extended_Pictographic})*/u)?.[0];
}

function scoreNamedThing(query: string, values: string[]): number {
  const terms = expressionTerms(query);
  const haystack = values.join(" ").toLowerCase();
  if (terms.length === 0) return 0;
  let score = 0;
  for (const term of terms) {
    if (haystack === term) score += 10;
    else if (haystack.split(/\s+/).includes(term)) score += 6;
    else if (haystack.includes(term)) score += 3;
  }
  return score;
}

function expressionTerms(value: string): string[] {
  return value.toLowerCase().match(/[a-z0-9_'-]{2,32}/g) ?? [];
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
  const first = chunks.shift() ?? "model returned an empty response.";
  await interaction.editReply(first);
  for (const chunk of chunks) {
    await interaction.followUp({ content: chunk, flags: ephemeral ? MessageFlags.Ephemeral : undefined });
  }
}

async function sendChunkedReply(message: Message, text: string): Promise<void> {
  const chunks = chunkDiscord(text);
  const first = chunks.shift() ?? "model returned an empty response.";
  await message.reply(first);
  if (!canSend(message.channel)) return;
  for (const chunk of chunks) await message.channel.send(chunk);
}

function canSend(channel: unknown): channel is {
  send: (content: string | { content?: string; embeds?: EmbedBuilder[]; files?: AttachmentBuilder[]; stickers?: string[] }) => Promise<unknown>;
  sendTyping?: () => Promise<unknown>;
} {
  return typeof (channel as { send?: unknown }).send === "function";
}

function canFetchMessages(channel: unknown): channel is MessageFetchableChannel {
  const maybe = channel as Partial<MessageFetchableChannel> & { isTextBased?: () => boolean };
  return Boolean(
    typeof maybe.id === "string" &&
    typeof maybe.messages?.fetch === "function" &&
    (typeof maybe.isTextBased !== "function" || maybe.isTextBased())
  );
}

function guildIdFromChannel(channel: unknown): string | undefined {
  const guildId = (channel as { guildId?: unknown }).guildId;
  return typeof guildId === "string" ? guildId : undefined;
}

async function backfillMemory(readyClient: Client<true>): Promise<void> {
  if (!config.backfillEnabled) return;
  if (config.memoryBackfillMessages <= 0) return;
  const channels = await backfillChannels(readyClient);
  for (const channel of channels) {
    let remaining = config.memoryBackfillMessages;
    let before: string | undefined;
    const rememberedMessages: Parameters<typeof memory.rememberMany>[1] = [];
    const rememberedMedia: Parameters<typeof memory.rememberMediaMany>[0] = [];
    try {
      while (remaining > 0) {
        const batch = await channel.messages.fetch({ limit: Math.min(100, remaining), before });
        const messages = [...batch.values()].sort((a, b) => b.createdTimestamp - a.createdTimestamp);
        if (messages.length === 0) break;
        before = messages.at(-1)?.id;
        for (const message of messages) {
          if (message.author.bot) continue;
          rememberedMedia.push(...mediaInputsFromMessage(message));
          const content = message.content.trim();
          if (!content) continue;
          rememberedMessages.push({
            role: "user",
            authorId: message.author.id,
            authorName: displayName(message),
            content: message.content,
            messageId: message.id,
            createdAt: message.createdTimestamp,
            guildId: message.guildId ?? undefined,
            hasAttachments: message.attachments.size > 0,
            hasEmbeds: message.embeds.length > 0,
            hasStickers: message.stickers.size > 0
          });
        }
        remaining -= messages.length;
        if (messages.length < 100) break;
      }
      memory.rememberMany(channel.id, rememberedMessages);
      memory.rememberMediaMany(rememberedMedia);
    } catch (error) {
      logger.warn("memory backfill failed for channel", { channelId: channel.id, error: redactSecrets(error) });
    }
  }
  await memory.flush();
  logger.info("memory backfill complete", { channels: channels.length });
}

async function backfillChannels(readyClient: Client<true>): Promise<MessageFetchableChannel[]> {
  const channels: MessageFetchableChannel[] = [];
  if (config.allowedChannelIds.size > 0) {
    for (const channelId of config.allowedChannelIds) {
      const channel = await readyClient.channels.fetch(channelId).catch(() => null);
      if (canFetchMessages(channel) && isChannelAllowed(channel.id)) channels.push(channel);
    }
    return channels;
  }

  if (!config.backfillAllChannels) return channels;

  for (const guild of readyClient.guilds.cache.values()) {
    const guildChannels = await guild.channels.fetch().catch(() => null);
    for (const channel of guildChannels?.values() ?? []) {
      if (canFetchMessages(channel) && isChannelAllowed(channel.id)) channels.push(channel);
    }
  }
  return channels;
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
      const guildId = guildIdFromChannel(channel);
      await channel.sendTyping?.().catch(() => undefined);

      if (autopost.mode === "chat" || autopost.mode === "both") {
        const prompt = buildAutoPostChatPrompt(autopost);
        const history = memory.get(channelId);
        const response = await ai.chat({
          systemPrompt,
          prompt,
          authorName: config.botName,
          history,
          memoryContext: memory.context(channelId, prompt, config.memoryRecallMessages, guildId),
          personaContext: serverPersonaProfile(guildId, channelId)
        });
        await channel.send(response);
        memory.remember(channelId, {
          role: "assistant",
          authorId: client.user.id,
          authorName: config.botName,
          content: response,
          guildId
        });
      }

      if (autopost.mode === "image" || autopost.mode === "both") {
        const prompt = buildAutoPostImagePrompt(autopost);
        const history = memory.get(channelId);
        const imagePrompt = await ai.chat({
          systemPrompt,
          prompt,
          authorName: config.botName,
          history,
          memoryContext: memory.context(channelId, prompt, config.memoryRecallMessages, guildId),
          personaContext: serverPersonaProfile(guildId, channelId)
        });
        const image = await ai.image(imagePrompt, autopost.aspectRatio);
        await sendImageToChannel(channel, image);
        memory.remember(channelId, {
          role: "assistant",
          authorId: client.user.id,
          authorName: config.botName,
          content: `[autopost image] ${imagePrompt}`,
          guildId
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
    "Generate one Discord autopost message for the current channel.",
    "Use channel memory and server persona context when provided. If no server persona context is provided, no learned server persona is available; generate using task mechanics only.",
    "Do not announce that this is scheduled. Keep it short enough for Discord.",
    autopost.prompt ? `Channel-configured instruction: ${autopost.prompt}` : "No channel-configured instruction; use recent channel memory."
  ].join("\n");
}

function buildAutoPostImagePrompt(autopost: AutoPostConfig): string {
  return [
    "Generate one concise image-generation prompt for the current Discord channel.",
    "Base it on recent channel memory, the configured instruction, and server persona context if provided. Return only the prompt, no explanation.",
    "Preserve concrete visual subject, setting, action, and composition. Do not add captions or text unless the context or configured instruction asks for it.",
    autopost.prompt ? `Channel-configured instruction: ${autopost.prompt}` : "No channel-configured instruction; use recent channel memory."
  ].join("\n");
}

async function editImageReply(interaction: ChatInputCommandInteraction, image: GeneratedImage): Promise<void> {
  try {
    logger.debug("uploading generated image", generatedImageLogFields(image));
    await uploadGeneratedInteractionImage(interaction, image);
  } catch (error) {
    logger.warn("image attachment upload failed", { ...generatedImageLogFields(image), error: redactSecrets(error) });
    await interaction.editReply({ content: "image generated, but Discord did not accept the upload before timing out. try again in a bit or lower IMAGE_WIDTH/IMAGE_HEIGHT.", embeds: [], files: [] });
  }
}

async function sendImageToChannel(channel: { id: string; send: (content: string | { embeds?: EmbedBuilder[]; files?: AttachmentBuilder[] }) => Promise<unknown> }, image: GeneratedImage): Promise<void> {
  try {
    logger.debug("uploading generated channel image", generatedImageLogFields(image));
    await uploadGeneratedChannelImage(channel.id, image);
  } catch (error) {
    logger.warn("image channel upload failed", { ...generatedImageLogFields(image), error: redactSecrets(error) });
    await channel.send("image generated, but Discord did not accept the upload before timing out.");
  }
}

async function uploadGeneratedInteractionImage(interaction: ChatInputCommandInteraction, image: GeneratedImage): Promise<void> {
  const response = await withTimeout(fetch(`${discordApiBaseUrl}/webhooks/${config.discordClientId}/${interaction.token}/messages/@original`, {
    method: "PATCH",
    body: generatedImageForm(image)
  }), discordUploadTimeoutMs, "Discord image upload timed out");
  await assertDiscordUploadResponse(response, "Discord interaction image upload");
}

async function uploadGeneratedChannelImage(channelId: string, image: GeneratedImage): Promise<void> {
  const response = await withTimeout(fetch(`${discordApiBaseUrl}/channels/${channelId}/messages`, {
    method: "POST",
    headers: { Authorization: `Bot ${config.discordToken}` },
    body: generatedImageForm(image)
  }), discordUploadTimeoutMs, "Discord channel image upload timed out");
  await assertDiscordUploadResponse(response, "Discord channel image upload");
}

function generatedImageForm(image: GeneratedImage): FormData {
  const form = new FormData();
  form.append("payload_json", JSON.stringify({ attachments: [{ id: 0, filename: image.filename }] }));
  form.append("files[0]", new Blob([new Uint8Array(image.bytes)], { type: image.contentType }), image.filename);
  return form;
}

async function assertDiscordUploadResponse(response: Response, label: string): Promise<void> {
  if (response.ok) return;
  const body = (await response.text()).replace(/\s+/g, " ").slice(0, 300);
  throw new Error(`${label} failed with HTTP ${response.status}: ${body}`);
}

function generatedImageLogFields(image: GeneratedImage): Record<string, string | number> {
  return {
    bytes: image.bytes.length,
    contentType: image.contentType,
    filename: image.filename
  };
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
  const content = `request failed: ${formatRequestError(error)}`;
  if (interaction.deferred || interaction.replied) {
    await interaction.editReply(content).catch(() => interaction.followUp({ content, flags: MessageFlags.Ephemeral }));
    return;
  }
  await interaction.reply({ content, flags: MessageFlags.Ephemeral });
}

function formatRequestError(error: unknown): string {
  const text = redactSecrets(error)
    .replace(/https?:\/\/\S+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const rateLimit = text.match(/Venice rate limited; retry in \d+s/i)?.[0];
  return truncate(rateLimit ?? text, 1500);
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}...` : value;
}

async function shutdown(signal: string, exitCode = 0): Promise<void> {
  logger.info("shutting down", { signal });
  if (autoPostTimer) clearTimeout(autoPostTimer);
  if (mediaAnalysisResumeTimer) clearTimeout(mediaAnalysisResumeTimer);
  await memory.flush();
  client.destroy();
  process.exit(exitCode);
}
