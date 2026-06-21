import {
  ActivityType,
  AttachmentBuilder,
  ChatInputCommandInteraction,
  Client,
  Events,
  GatewayIntentBits,
  Message,
  MessageFlags,
  Partials
} from "discord.js";
import { config, redactSecrets } from "./config.js";
import { AiClient } from "./ai-client.js";
import { logger } from "./logger.js";
import { MemoryStore } from "./memory.js";
import { buildSystemPrompt } from "./persona.js";
import { CooldownBucket, formatRemaining } from "./rate-limit.js";

const memory = new MemoryStore(config.memoryPath, config.maxHistoryMessages);
const ai = new AiClient(config);
const systemPrompt = buildSystemPrompt({ botName: config.botName, maxResponseChars: config.maxResponseChars });
const userCooldown = new CooldownBucket(config.userCooldownMs);
const channelCooldown = new CooldownBucket(config.channelCooldownMs);
const imageCooldown = new CooldownBucket(config.imageCooldownMs);

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
      case "reset":
        await handleResetCommand(interaction);
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

  const prompt = extractMentionPrompt(message, content);
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
    const response = await ai.chat({
      systemPrompt,
      prompt,
      authorName: displayName(message),
      history: memory.get(message.channelId)
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
    history: privateReply ? [] : memory.get(interaction.channelId)
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
  const limited = imageCooldown.take(interaction.user.id);
  if (limited) {
    await interaction.reply({ content: `image gremlin is reloading. wait ${formatRemaining(limited)}`, flags: MessageFlags.Ephemeral });
    return;
  }

  await interaction.deferReply();
  const image = await ai.image(prompt, aspectRatio);
  const attachment = new AttachmentBuilder(image.bytes, { name: image.filename });
  await interaction.editReply({
    content: `generated by ${config.botName}: ${truncate(prompt, 180)}`,
    files: [attachment]
  });
}

async function handleResetCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  memory.reset(interaction.channelId);
  await interaction.reply({ content: "channel memory deleted. lemon lobotomy complete.", flags: MessageFlags.Ephemeral });
}

async function handleHelpCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.reply({
    content: [
      `**${config.botName}**`,
      "`/chat prompt:` chaotic OpenRouter free-model reply",
      "`/image prompt:` Pollinations image",
      "`/reset` wipe this channel's memory",
      "Mention me or start with `lemonai` for inline replies if auto-reply is enabled."
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

function extractMentionPrompt(message: Message, content: string): string | null {
  const botId = client.user?.id;
  const mentioned = botId ? message.mentions.users.has(botId) : false;
  const normalized = content.toLowerCase();
  const nameTriggered = normalized.startsWith("lemonai") || normalized.startsWith("lemon ai");
  if (!mentioned && !nameTriggered) return null;

  const withoutMention = botId
    ? content.replace(new RegExp(`<@!?${botId}>`, "g"), "")
    : content;
  const withoutName = withoutMention.replace(/^lemon\s*ai[:,\s-]*/i, "").trim();
  return withoutName || "say something unhinged but useful";
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

function canSend(channel: unknown): channel is { send: (content: string) => Promise<unknown> } {
  return typeof (channel as { send?: unknown }).send === "function";
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
  await memory.flush();
  client.destroy();
  process.exit(exitCode);
}
