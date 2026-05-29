type LogMeta = Record<string, unknown>;
type LogLevel = "silent" | "error" | "warn" | "info";

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  silent: 0,
  error: 1,
  warn: 2,
  info: 3
};

function currentLevel(): LogLevel {
  const value = process.env.LOG_LEVEL?.trim().toLowerCase();
  if (value === "silent" || value === "error" || value === "warn" || value === "info") return value;
  return "info";
}

function write(level: string, message: string, meta?: LogMeta): void {
  if (LEVEL_WEIGHT[level as LogLevel] > LEVEL_WEIGHT[currentLevel()]) return;

  const line = {
    level,
    message,
    time: new Date().toISOString(),
    ...(meta ? { meta } : {})
  };
  console.log(JSON.stringify(line));
}

export const logger = {
  info: (message: string, meta?: LogMeta) => write("info", message, meta),
  warn: (message: string, meta?: LogMeta) => write("warn", message, meta),
  error: (message: string, meta?: LogMeta) => write("error", message, meta)
};
