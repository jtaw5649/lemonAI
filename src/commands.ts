import { SlashCommandBuilder } from "discord.js";

export const aspectRatios = [
  "1:1",
  "16:9",
  "9:16",
  "4:3",
  "3:4",
  "3:2",
  "2:3",
  "2:1",
  "1:2",
  "19.5:9",
  "9:19.5",
  "20:9",
  "9:20",
  "auto"
] as const;

export const commands = [
  new SlashCommandBuilder()
    .setName("chat")
    .setDescription("Ask lemonAI for a chaotic reply, optionally with an image.")
    .addStringOption((option) =>
      option
        .setName("prompt")
        .setDescription("What should lemonAI respond to?")
        .setRequired(true)
        .setMaxLength(1800)
    )
    .addBooleanOption((option) =>
      option
        .setName("private")
        .setDescription("Only show the reply to you. Private replies are not saved to memory.")
        .setRequired(false)
    )
    .addAttachmentOption((option) =>
      option
        .setName("image")
        .setDescription("Optional image for lemonAI to inspect.")
        .setRequired(false)
    ),
  new SlashCommandBuilder()
    .setName("image")
    .setDescription("Generate a Pollinations shitpost image.")
    .addStringOption((option) =>
      option
        .setName("prompt")
        .setDescription("Describe the image.")
        .setRequired(true)
        .setMaxLength(1500)
    )
    .addStringOption((option) => {
      option
        .setName("aspect_ratio")
        .setDescription("Image aspect ratio.")
        .setRequired(false);
      for (const ratio of aspectRatios) option.addChoices({ name: ratio, value: ratio });
      return option;
    })
    .addBooleanOption((option) => {
      return option
        .setName("adult")
        .setDescription("Generate with Pollinations safe=false/private=true.")
        .setRequired(false);
    }),
  new SlashCommandBuilder()
    .setName("reset")
    .setDescription("Clear lemonAI memory for this channel."),
  new SlashCommandBuilder()
    .setName("autopost")
    .setDescription("Configure automatic lemonAI posting for this channel.")
    .addSubcommand((subcommand) =>
      subcommand
        .setName("set")
        .setDescription("Turn on scheduled AI chat/image posting in this channel.")
        .addStringOption((option) =>
          option
            .setName("mode")
            .setDescription("What lemonAI should automatically post.")
            .setRequired(true)
            .addChoices(
              { name: "chat", value: "chat" },
              { name: "image", value: "image" },
              { name: "both", value: "both" }
            )
        )
        .addIntegerOption((option) =>
          option
            .setName("interval_minutes")
            .setDescription("How often to post. Minimum 1 minute.")
            .setRequired(true)
            .setMinValue(1)
            .setMaxValue(10080)
        )
        .addStringOption((option) =>
          option
            .setName("prompt")
            .setDescription("Optional vibe/instructions. Empty means infer from channel memory.")
            .setRequired(false)
            .setMaxLength(1500)
        )
        .addStringOption((option) => {
          option
            .setName("aspect_ratio")
            .setDescription("Image aspect ratio for image/both mode.")
            .setRequired(false);
          for (const ratio of aspectRatios) option.addChoices({ name: ratio, value: ratio });
          return option;
        })
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("off")
        .setDescription("Turn off scheduled posting in this channel.")
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("status")
        .setDescription("Show scheduled posting config for this channel.")
    ),
  new SlashCommandBuilder()
    .setName("help")
    .setDescription("Show lemonAI usage and setup hints.")
].map((command) => command.toJSON());
