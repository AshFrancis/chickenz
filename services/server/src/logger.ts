/** Structured JSON logger — zero dependencies. */

const LEVELS = ["debug", "info", "warn", "error"] as const;
type Level = (typeof LEVELS)[number];

const levelIndex: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };

function getMinLevel(): Level {
  const env = (process.env.LOG_LEVEL ?? "info").toLowerCase();
  if (LEVELS.includes(env as Level)) return env as Level;
  return "info";
}

const minLevel = getMinLevel();

function emit(level: Level, mod: string, msg: string, extra?: Record<string, unknown>) {
  if (levelIndex[level] < levelIndex[minLevel]) return;

  const entry: Record<string, unknown> = {
    ts: new Date().toISOString(),
    level,
    mod,
    msg,
  };
  if (extra) Object.assign(entry, extra);

  const line = JSON.stringify(entry);
  if (level === "error") {
    console.error(line);
  } else if (level === "warn") {
    console.warn(line);
  } else {
    console.log(line);
  }
}

export interface Logger {
  debug(msg: string, extra?: Record<string, unknown>): void;
  info(msg: string, extra?: Record<string, unknown>): void;
  warn(msg: string, extra?: Record<string, unknown>): void;
  error(msg: string, extra?: Record<string, unknown>): void;
}

export function createLogger(mod: string): Logger {
  return {
    debug: (msg, extra?) => emit("debug", mod, msg, extra),
    info: (msg, extra?) => emit("info", mod, msg, extra),
    warn: (msg, extra?) => emit("warn", mod, msg, extra),
    error: (msg, extra?) => emit("error", mod, msg, extra),
  };
}
