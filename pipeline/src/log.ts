/** Structured JSON-lines logger. Never log secrets: callers pass fields explicitly. */
export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Logger {
  debug(event: string, fields?: Record<string, unknown>): void;
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
  child(bound: Record<string, unknown>): Logger;
}

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function safe(value: unknown): unknown {
  if (value instanceof Error) return { name: value.name, message: value.message, stack: value.stack };
  if (typeof value === "bigint") return value.toString();
  return value;
}

export function createLogger(
  bound: Record<string, unknown> = {},
  minLevel: LogLevel = (process.env.LOG_LEVEL as LogLevel | undefined) ?? "info",
  sink: (line: string) => void = (line) => process.stdout.write(line + "\n"),
): Logger {
  const emit = (level: LogLevel, event: string, fields?: Record<string, unknown>) => {
    if (LEVELS[level] < LEVELS[minLevel]) return;
    const record: Record<string, unknown> = { ts: new Date().toISOString(), level, event, ...bound };
    if (fields) for (const [k, v] of Object.entries(fields)) record[k] = safe(v);
    sink(JSON.stringify(record, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
  };
  return {
    debug: (e, f) => emit("debug", e, f),
    info: (e, f) => emit("info", e, f),
    warn: (e, f) => emit("warn", e, f),
    error: (e, f) => emit("error", e, f),
    child: (more) => createLogger({ ...bound, ...more }, minLevel, sink),
  };
}

export const log = createLogger({ service: "duval-oracle-pipeline" });
