import { config, type LogLevel, redactSecrets } from "./config.js";

const weights: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40
};

function shouldLog(level: LogLevel): boolean {
  return weights[level] >= weights[config.logLevel];
}

function write(level: LogLevel, message: string, extra?: unknown): void {
  if (!shouldLog(level)) return;
  const line = {
    level,
    time: new Date().toISOString(),
    message,
    ...(extra === undefined ? {} : { extra: redactSecrets(extra) })
  };
  const output = JSON.stringify(line);
  if (level === "error") console.error(output);
  else if (level === "warn") console.warn(output);
  else console.log(output);
}

export const logger = {
  debug: (message: string, extra?: unknown) => write("debug", message, extra),
  info: (message: string, extra?: unknown) => write("info", message, extra),
  warn: (message: string, extra?: unknown) => write("warn", message, extra),
  error: (message: string, extra?: unknown) => write("error", message, extra)
};
