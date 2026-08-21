/**
 * Structured, one line JSON logs for the agent route. Vercel and local dev
 * both show stdout, and a JSON line per event is what the kit's observability
 * rules ask for when there is no LangSmith key configured.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

export function logAgent(level: LogLevel, message: string, fields: Record<string, unknown> = {}) {
  if (process.env.AGENT_LOG === "off" || process.env.NODE_ENV === "test") return;
  const line = JSON.stringify({ at: new Date().toISOString(), level, scope: "agent", message, ...fields });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.info(line);
}
