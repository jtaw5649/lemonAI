import { REST, Routes } from "discord.js";
import { commands } from "./commands.js";
import { config } from "./config.js";
import { logger } from "./logger.js";

const rest = new REST({ version: "10" }).setToken(config.discordToken);

const route = config.discordGuildId
  ? Routes.applicationGuildCommands(config.discordClientId, config.discordGuildId)
  : Routes.applicationCommands(config.discordClientId);

logger.info("deploying slash commands", {
  scope: config.discordGuildId ? "guild" : "global",
  commandCount: commands.length
});

await rest.put(route, { body: commands });

logger.info("slash commands deployed", {
  scope: config.discordGuildId ? "guild" : "global"
});
