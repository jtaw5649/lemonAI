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
    .setDescription("Ask lemonAI for a chaotic free-model reply.")
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
    }),
  new SlashCommandBuilder()
    .setName("reset")
    .setDescription("Clear lemonAI memory for this channel."),
  new SlashCommandBuilder()
    .setName("help")
    .setDescription("Show lemonAI usage and setup hints.")
].map((command) => command.toJSON());
