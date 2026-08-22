"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type {
  AgentDataFreshness,
  AgentEvidenceRow,
  AgentResponse,
  AgentToolCall,
  AgentUsage,
} from "@/lib/agent/types";
import { PageHeader, Callout, Spinner } from "@/components/ui";
import { EngineStatus } from "@/components/EngineStatus";
import { ProvenanceCell, useColumnProvenance } from "@/components/DataTable";
import { formatInt, formatTimestamp, relativeTime } from "@/lib/format";
import { TOOL_ORDER } from "@/lib/agent/toolOrder";

interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  at: string;
  hint?: string;
  notImplemented?: boolean;
  error?: boolean;
  meta?: {
    model: string | null;
    usage: AgentUsage | null;
    elapsed_ms?: number;
    toolCalls: number;
    /** Whose credential paid for this answer, as the browser knows it. */
    source: "your key" | "server default";
  };
}

interface AgentConfig {
  configured: boolean;
  active: { provider: string; model: string; source: "user" | "server" } | null;
  server_default: { provider: string; model: string; env_key: string } | null;
  /** Models this deployment will run on its own key. Bounded server side, see serverModelChoices. */
  model_choices: { id: string; label: string }[];
}

const DEMO_PROMPTS = [
  "Which properties have roofs older than 15 years and have not exchanged ownership in more than 10 years?",
  "Which properties are near public transportation and also have regional owners?",
  "Which properties appear to be strong candidates for further review based on ownership age, roof age, and location signals?",
];

/**
 * Named, not described. The descriptions lived in a sidebar card that repeated on every answer;
 * what the names have to carry is the claim that the agent can only read.
 */
const TOOL_NAMES = TOOL_ORDER;

const EVIDENCE_META = new Set(["property_id", "address", "source_system", "source_url", "fetched_at", "via"]);

function ToolCallRow({ call, index }: { call: AgentToolCall; index: number }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="border-b border-border px-3 py-2 last:border-b-0">
      <button
        type="button"
        className="flex w-full items-center gap-2 text-left"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
      >
        <span className="mono text-faint text-[11px]">{index + 1}</span>
        <span className={`badge ${call.error ? "badge-warn" : "badge-accent"}`}>{call.name}</span>
        <span className="flex-1 truncate text-[12px] text-muted" title={call.output_summary}>
          {call.output_summary}
        </span>
        <span className="mono text-[11px] text-faint">{call.elapsed_ms} ms</span>
        <span className="text-faint text-[11px]">{open ? "hide" : "json"}</span>
      </button>
      {open ? (
        <div className="mt-1.5 space-y-1">
          <div className="text-[11px] text-faint">input</div>
          <pre className="block" style={{ fontSize: 11 }}>
            {JSON.stringify(call.input, null, 2)}
          </pre>
          <div className="text-[11px] text-faint">result</div>
          <pre className="block" style={{ fontSize: 11 }}>
            {JSON.stringify(
              {
                row_count: call.row_count,
                total_matched: call.total_matched ?? null,
                elapsed_ms: call.elapsed_ms,
                error: call.error ?? null,
                ...(call.result ?? {}),
              },
              null,
              2,
            )}
          </pre>
        </div>
      ) : null}
    </li>
  );
}

function cellText(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/**
 * Pinned to the right edge, for the reason DataTable pins its own provenance column: this table
 * scrolls sideways inside a 420px box, and a stack of source badges in its last column is exactly
 * what the container edge slices.
 */
const STICKY_PROVENANCE = "md:sticky md:right-0 md:border-l md:border-border md:bg-surface";

function EvidenceTable({ rows }: { rows: AgentEvidenceRow[] }) {
  const matched = new Set<string>();
  for (const row of rows) for (const key of Object.keys(row)) if (!EVIDENCE_META.has(key)) matched.add(key);
  // At full width there is room for the columns that actually justify the answer, so the cap goes
  // up. The container scrolls in both directions rather than the page doing it: a wide table must
  // never make the whole page scroll sideways, and 25 rows of evidence should not push the
  // assumptions below it off the screen.
  const columns = [...matched].slice(0, 14);
  /*
   * The same column to family map the results grid reads, from the same parquet footer. The engine
   * is already attached on this page (EngineStatus boots it), so this is a footer read against an
   * open file, and a failure resolves to null and degrades the cell rather than breaking the table.
   */
  const provenance = useColumnProvenance(rows.length > 0);
  /*
   * What the provenance names is the provenance OF THE VALUES ON SCREEN, so it resolves over the
   * columns this table actually renders. Evidence rows carry no `<family>_source` columns at all
   * (lib/agent/tools.ts strips every provenance column out of the matched set), which is precisely
   * why the map is needed: without it there is nothing on the row to attribute a Starbucks distance
   * to, and the cell falls back to the appraisal roll spine that was the bug.
   */
  const provenanceColumns = ["property_id", ...columns];
  return (
    <div className="overflow-auto" style={{ maxHeight: 420 }}>
      <table className="w-full text-[11.5px]" style={{ minWidth: 720 }}>
        <thead className="sticky top-0 z-10" style={{ background: "var(--color-surface)" }}>
          <tr className="text-left text-faint">
            <th className="px-2 py-1 font-semibold">property_id</th>
            <th className="px-2 py-1 font-semibold">address</th>
            {columns.map((column) => (
              <th key={column} className="px-2 py-1 font-semibold mono">
                {column}
              </th>
            ))}
            <th className={`px-2 py-1 font-semibold ${STICKY_PROVENANCE}`}>provenance</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={`${row.property_id}-${index}`} className="border-t border-border align-top">
              <td className="px-2 py-1 mono whitespace-nowrap">
                <Link prefetch={false} href={`/property/${encodeURIComponent(row.property_id)}`}>
                  {row.property_id}
                </Link>
              </td>
              <td className="px-2 py-1">{row.address ?? "not available"}</td>
              {columns.map((column) => (
                <td key={column} className="px-2 py-1 mono whitespace-nowrap">
                  {cellText(row[column])}
                </td>
              ))}
              <td className={`px-2 py-1 whitespace-nowrap md:z-[1] ${STICKY_PROVENANCE}`}>
                <ProvenanceCell row={row} columns={provenanceColumns} map={provenance} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** The stream ended before the answer line arrived. Recoverable: ask again without streaming. */
class StreamDropped extends Error {
  constructor() {
    super("The connection closed before the answer arrived.");
    this.name = "StreamDropped";
  }
}

interface ProgressEvent {
  id: string;
  phase: "started" | "finished";
  label: string;
  tool?: string;
  elapsed_ms?: number;
  row_count?: number | null;
  error?: string | null;
}

/**
 * Read the NDJSON turn: progress lines while the work happens, then one result line.
 *
 * Falls back to parsing the whole body as JSON when the server did not stream, so an older
 * deployment, a proxy that strips the content type, or the plain JSON path all still work.
 */
async function readAgentStream(
  response: Response,
  onProgress: (event: ProgressEvent) => void,
): Promise<AgentResponse> {
  const body = response.body;
  if (!body || !(response.headers.get("content-type") ?? "").includes("application/x-ndjson")) {
    return (await response.json()) as AgentResponse;
  }

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let result: AgentResponse | null = null;

  const handle = (line: string) => {
    const text = line.trim();
    if (!text) return;
    let parsed: { type?: string; response?: AgentResponse } & ProgressEvent;
    try {
      parsed = JSON.parse(text);
    } catch {
      return; // a truncated line is not worth failing the whole answer over
    }
    // "ping" is the keepalive that stops an idle stream being dropped mid turn; it carries nothing.
    if (parsed.type === "ping") return;
    if (parsed.type === "progress") onProgress(parsed);
    else if (parsed.type === "result" && parsed.response) result = parsed.response;
  };

  /*
   * A stall watchdog. The server sends a ping every ten seconds, so silence for far longer than
   * that means the connection is dead even though neither end has said so - and a fetch whose body
   * never ends and never errors leaves the page waiting forever with a progress log that stopped
   * moving. Treat it as a drop, which the caller already knows how to retry without streaming.
   */
  const STALL_MS = 45_000;
  const readWithWatchdog = async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stalled = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new StreamDropped()), STALL_MS);
    });
    try {
      return await Promise.race([reader.read(), stalled]);
    } finally {
      clearTimeout(timer);
    }
  };

  for (;;) {
    let chunk;
    try {
      chunk = await readWithWatchdog();
    } catch (error) {
      if (error instanceof StreamDropped) {
        void reader.cancel().catch(() => undefined);
        throw error;
      }
      // The connection died mid turn. Distinguished from every other failure so the caller can
      // retry without streaming rather than telling the reader the endpoint is unreachable.
      throw new StreamDropped();
    }
    const { done, value } = chunk;
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) handle(line);
  }
  handle(buffer);

  if (!result) throw new StreamDropped();
  return result;
}

function FreshnessBadge({ freshness }: { freshness: AgentDataFreshness | null }) {
  if (!freshness) return null;
  const label = freshness.finished_at
    ? `data as of ${formatTimestamp(freshness.finished_at)} (${relativeTime(freshness.finished_at)})`
    : "run history not available";
  return (
    <div className="flex flex-wrap items-center gap-2 text-[11.5px]">
      <span className={`badge ${freshness.is_sample ? "badge-warn" : "badge-good"}`}>
        {freshness.is_sample ? "SAMPLE run history" : "published run history"}
      </span>
      <span className="text-muted">{label}</span>
      {freshness.run_id ? (
        <Link className="mono" prefetch={false} href="/runs">
          run {freshness.run_id}
        </Link>
      ) : null}
    </div>
  );
}

export default function AgentPage() {
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: "intro",
      role: "system",
      text: "Ask a property intelligence question in plain English. The agent plans tool calls, runs read only SQL against the published parquet in server side DuckDB, and answers with the rows it used.",
      at: new Date().toISOString(),
    },
  ]);
  const [input, setInput] = useState("");
  const [pending, setPending] = useState(false);
  const [toolCalls, setToolCalls] = useState<AgentToolCall[]>([]);
  const [evidence, setEvidence] = useState<AgentEvidenceRow[]>([]);
  const [assumptions, setAssumptions] = useState<string[]>([]);
  const [freshness, setFreshness] = useState<AgentDataFreshness | null>(null);
  const [config, setConfig] = useState<AgentConfig | null>(null);
  // Real events from the server, appended as they arrive. Never a scripted timer: a fake sequence
  // would keep animating after the work stalled, which is exactly when it must not.
  const [progress, setProgress] = useState<{ id: string; label: string; done: boolean; detail: string | null }[]>([]);
  const scroller = useRef<HTMLDivElement | null>(null);
  // Which of the offered models answers the next question. Null until the config arrives, then the
  // server's own default, so the dropdown never starts on something the server would not run.
  const [model, setModel] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/agent", { method: "GET" })
      .then((response) => response.json())
      .then((payload: AgentConfig) => {
        if (cancelled) return;
        setConfig(payload);
        setModel(payload.server_default?.model ?? payload.model_choices?.[0]?.id ?? null);
      })
      .catch(() => {
        if (!cancelled) setConfig(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // What produced the rows, so the collapsed summary says something useful rather than just a count.
  const evidenceSource =
    (evidence[0] as { via?: string } | undefined)?.via ??
    [...toolCalls].reverse().find((call) => !call.error && (call.row_count ?? 0) > 0)?.name ??
    null;

  const choices = config?.model_choices ?? [];
  const providerLabel = config?.server_default?.provider ?? null;

  // The chosen model rides on each request rather than being captured once, so changing the
  // dropdown takes effect on the next question with no reload.
  const send = async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || pending) return;

    setProgress([]);

    const outgoing: ChatMessage = {
      id: `u-${Date.now()}`,
      role: "user",
      text: trimmed,
      at: new Date().toISOString(),
    };
    setMessages((current) => [...current, outgoing]);
    setInput("");
    setPending(true);

    // One request builder, used twice: once asking for the progress stream, and again as plain
    // JSON if that stream is cut off before the answer arrives.
    const ask = (accept: string) =>
      fetch("/api/agent", {
        method: "POST",
        // The credential rides on this one request and is not persisted server
        // side. With nothing stored, credentialHeaders is empty and the server
        // answers with its own configuration, or 501 when it has none.
        // Only the model travels. The server validates it against the list it published, so a
        // hand-written header cannot point this deployment's key at a model it does not offer.
        headers: {
          "content-type": "application/json",
          accept,
          ...(model ? { "x-llm-model": model } : {}),
        },
        body: JSON.stringify({
          messages: [...messages, outgoing]
            .filter((message) => message.role !== "system" && !message.notImplemented && !message.error)
            .map((message) => ({ role: message.role, content: message.text })),
        }),
      });

    const onProgressEvent = (event: ProgressEvent) => {
      setProgress((current) => {
        const detail = [
          event.row_count === null || event.row_count === undefined ? null : `${formatInt(event.row_count)} rows`,
          event.elapsed_ms === undefined ? null : `${(event.elapsed_ms / 1000).toFixed(1)}s`,
          event.error ? "failed" : null,
        ]
          .filter(Boolean)
          .join(" · ");

        if (event.phase === "started") {
          return [...current, { id: event.id, label: event.label, done: false, detail: null }];
        }
        // Close the line this event was paired with, wherever it sits. Matching by id keeps every
        // line in the order the work actually happened.
        const at = current.findIndex((entry) => entry.id === event.id);
        if (at === -1) {
          return [...current, { id: event.id, label: event.label, done: true, detail: detail || null }];
        }
        return current.map((entry, i) =>
          i === at ? { ...entry, label: event.label, done: true, detail: detail || null } : entry,
        );
      });
    };

    try {
      let payload: AgentResponse;
      try {
        payload = await readAgentStream(await ask("application/x-ndjson"), onProgressEvent);
      } catch (streamError: unknown) {
        // The stream was cut before the answer. That is a transport failure, not a failed answer,
        // and telling the reader the endpoint is unreachable when it is not would be wrong. Ask once
        // more without streaming, which is a single response with nothing to keep alive.
        if (!(streamError instanceof StreamDropped)) throw streamError;
        setProgress((current) => [
          ...current.map((entry) => ({ ...entry, done: true })),
          { id: "retry", label: "Connection dropped, asking again without the live log", done: false, detail: null },
        ]);
        payload = (await (await ask("application/json")).json()) as AgentResponse;
      }
      const notImplemented = payload.status === "not_implemented";
      const failed = payload.status === "error";

      setToolCalls(payload.toolCalls ?? payload.tool_calls ?? []);
      setEvidence(payload.evidence ?? []);
      setAssumptions(payload.assumptions ?? []);
      if (payload.data_freshness) setFreshness(payload.data_freshness);
      setMessages((current) => [
        ...current,
        {
          id: `a-${Date.now()}`,
          role: "assistant",
          text: payload.answer ?? payload.message,
          hint: payload.hint,
          notImplemented,
          error: failed,
          meta: {
            model: payload.model ?? null,
            usage: payload.usage ?? null,
            elapsed_ms: payload.elapsed_ms,
            toolCalls: (payload.toolCalls ?? payload.tool_calls ?? []).length,
            source: "server default",
          },
          at: new Date().toISOString(),
        },
      ]);
    } catch (error: unknown) {
      setMessages((current) => [
        ...current,
        {
          id: `e-${Date.now()}`,
          role: "assistant",
          text: `Could not reach the agent endpoint: ${
            error instanceof Error ? error.message : String(error)
          }`,
          error: true,
          at: new Date().toISOString(),
        },
      ]);
    } finally {
      setPending(false);
      requestAnimationFrame(() => {
        scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: "smooth" });
      });
    }
  };

  return (
    <div>
      <PageHeader
        title="Agent"
        lead="The same dataset, asked in plain English. The transcript panel shows every tool call the agent made and the evidence panel shows the rows the answer rests on, so an answer can always be traced back to a county record."
      />

    <div className="mb-4 flex flex-wrap items-center gap-3">
        <EngineStatus compact />
        {choices.length > 0 ? (
          <label className="flex flex-wrap items-center gap-1.5 text-[11.5px] text-faint">
            model
            <select
              className="field"
              value={model ?? ""}
              onChange={(event) => setModel(event.target.value)}
              disabled={pending}
              aria-label="Model"
            >
              {choices.map((choice) => (
                <option key={choice.id} value={choice.id}>
                  {choice.label}
                </option>
              ))}
            </select>
            {providerLabel ? <span className="mono text-muted">{providerLabel}</span> : null}
          </label>
        ) : config && !config.configured ? (
          <span className="badge badge-warn">no model configured</span>
        ) : null}
        <FreshnessBadge freshness={freshness} />
      </div>

      <div className="card flex flex-col" style={{ minHeight: 560 }}>
          <div ref={scroller} className="flex-1 space-y-3 overflow-auto px-4 py-4">
            {messages.map((message) => (
              <div key={message.id}>
                {message.role === "system" ? (
                  <div className="text-[12px] text-faint">{message.text}</div>
                ) : message.role === "user" ? (
                  <div className="flex justify-end">
                    <div className="max-w-[85%] rounded-lg rounded-br-sm bg-accent-soft px-3 py-2 text-[13px] text-accent">
                      {message.text}
                    </div>
                  </div>
                ) : (
                  <div className="flex justify-start">
                    <div
                      className={`max-w-[95%] rounded-lg rounded-bl-sm border px-3 py-2 text-[13px] ${
                        message.notImplemented || message.error
                          ? "border-warn/40 bg-warn-soft text-warn"
                          : "border-border bg-sunken text-text"
                      }`}
                    >
                      {message.notImplemented ? (
                        <div className="mb-1 text-[11px] font-bold uppercase tracking-wide">
                          agent not configured
                        </div>
                      ) : message.error ? (
                        <div className="mb-1 text-[11px] font-bold uppercase tracking-wide">
                          agent error
                        </div>
                      ) : null}
                      <div className="markdown">
                        <ReactMarkdown
                          remarkPlugins={[remarkGfm]}
                          components={{
                            a: ({ href, children }) => (
                              <a href={href} target="_blank" rel="noreferrer">
                                {children}
                              </a>
                            ),
                            table: ({ children }) => (
                              <div className="overflow-auto">
                                <table className="my-2 w-full text-[12px]">{children}</table>
                              </div>
                            ),
                            th: ({ children }) => (
                              <th className="border-b border-border px-2 py-1 text-left font-semibold">{children}</th>
                            ),
                            td: ({ children }) => (
                              <td className="border-b border-border px-2 py-1 align-top mono">{children}</td>
                            ),
                            h1: ({ children }) => <div className="mt-2 text-[13px] font-bold">{children}</div>,
                            h2: ({ children }) => <div className="mt-2 text-[13px] font-bold">{children}</div>,
                            h3: ({ children }) => <div className="mt-2 text-[12.5px] font-semibold">{children}</div>,
                            ul: ({ children }) => <ul className="my-1 list-disc pl-5">{children}</ul>,
                            ol: ({ children }) => <ol className="my-1 list-decimal pl-5">{children}</ol>,
                            p: ({ children }) => <p className="my-1">{children}</p>,
                            code: ({ children }) => <code className="mono text-[12px]">{children}</code>,
                          }}
                        >
                          {message.text}
                        </ReactMarkdown>
                      </div>
                      {message.hint ? (
                        <div className="mt-2 border-t border-current/20 pt-2 text-[12px] opacity-90">
                          {message.hint}
                        </div>
                      ) : null}
                      {message.meta && !message.notImplemented && !message.error ? (
                        <div className="mt-2 flex flex-wrap gap-x-3 text-[11px] text-faint mono">
                          <span>{message.meta.model ?? "model unknown"}</span>
                          <span>{message.meta.source}</span>
                          <span>{message.meta.toolCalls} tool calls</span>
                          {message.meta.usage ? (
                            <span>
                              {message.meta.usage.steps} steps, {message.meta.usage.input_tokens ?? "?"} in /{" "}
                              {message.meta.usage.output_tokens ?? "?"} out
                              {message.meta.usage.cache_read_tokens ? `, ${message.meta.usage.cache_read_tokens} cached` : ""}
                            </span>
                          ) : null}
                          {message.meta.elapsed_ms !== undefined ? <span>{(message.meta.elapsed_ms / 1000).toFixed(1)} s</span> : null}
                        </div>
                      ) : null}
                    </div>
                  </div>
                )}
              </div>
            ))}
            {pending ? (
              <div className="space-y-1.5">
                {progress.length === 0 ? <Spinner label="Starting" /> : null}
                {progress.map((step, index) => (
                  <div key={`${step.label}-${index}`} className="flex items-center gap-2 text-[12px]">
                    <span className={step.done ? "text-good" : "text-accent"} aria-hidden="true">
                      {step.done ? "✓" : "…"}
                    </span>
                    <span className={step.done ? "text-muted" : "text-text"}>{step.label}</span>
                    {step.detail ? <span className="mono text-[11px] text-faint">{step.detail}</span> : null}
                  </div>
                ))}
              </div>
            ) : null}
          </div>

          <div className="border-t border-border px-4 py-3">
            <div className="mb-2 flex flex-wrap gap-1.5">
              {DEMO_PROMPTS.map((prompt) => (
                <button
                  key={prompt}
                  type="button"
                  className="btn btn-sm"
                  disabled={pending}
                  onClick={() => void send(prompt)}
                  title={prompt}
                >
                  {prompt.length > 64 ? `${prompt.slice(0, 62)}...` : prompt}
                </button>
              ))}
            </div>
            <form
              className="flex gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                void send(input);
              }}
            >
              <input
                className="field flex-1"
                aria-label="Ask a property intelligence question"
                placeholder="Ask about roofs, water views, ownership age, owners, transit or Starbucks"
                value={input}
                onChange={(event) => setInput(event.target.value)}
                disabled={pending}
              />
              <button type="submit" className="btn btn-primary" disabled={pending || !input.trim()}>
                send
              </button>
            </form>
          </div>

      </div>

      {/*
        Below the chat, at full width. It used to be a 380px rail beside the answer, which meant the
        evidence table - the widest thing on the page, one row per parcel with its matched columns
        and provenance - was squeezed into a third of the screen. It reads as the working behind the
        answer, so it belongs after it.
      */}
      <div className="mt-4 space-y-4">
          <div className="card">
            <div className="border-b border-border px-3 py-2 text-[12px] font-semibold">
              Tool call transcript {toolCalls.length > 0 ? `(${toolCalls.length})` : ""}
            </div>
            {toolCalls.length === 0 ? (
              <div className="px-3 py-3 text-[12px] text-faint">
                No tool calls yet. Every call the agent makes appears here with its arguments and
                its result, so the answer can be audited rather than trusted.
              </div>
            ) : (
              <ul>
                {toolCalls.map((call, index) => (
                  <ToolCallRow key={`${call.name}-${index}`} call={call} index={index} />
                ))}
              </ul>
            )}
          </div>

          {/*
            Evidence is required - the assignment asks for source backed answers - but the answer
            above already prints the rows. Repeating the same table, always open, in a narrow
            column read as clutter rather than proof. It is the same rows straight from DuckDB
            rather than the model's retelling, which is the point, so it stays one click away with
            a summary that says what it holds.
          */}
          <div className="card">
            {evidence.length === 0 ? (
              <>
                <div className="border-b border-border px-3 py-2 text-[12px] font-semibold">Evidence</div>
                <div className="px-3 py-3 text-[12px] text-faint">
                  Rows the answer rests on land here, each with the matched columns, its source
                  system, source URL and collection timestamp.
                </div>
              </>
            ) : (
              <details>
                <summary className="cursor-pointer border-b border-border px-3 py-2 text-[12px] font-semibold marker:text-faint">
                  Evidence ({evidence.length} parcels)
                  <span className="ml-1 font-normal text-faint">
                    {evidenceSource ? `from ${evidenceSource}` : "as returned by the tool"} - show rows
                  </span>
                </summary>
                <EvidenceTable rows={evidence} />
              </details>
            )}
          </div>

          {assumptions.length > 0 ? (
            <Callout tone="warn" title="Assumptions and missing data">
              <ul className="list-disc pl-4">
                {assumptions.map((assumption) => (
                  <li key={assumption}>{assumption}</li>
                ))}
              </ul>
            </Callout>
          ) : null}

          {/*
            The full tool catalogue used to sit here as a card. It is reference material, identical
            on every answer, and it pushed the evidence it was meant to explain below the fold. The
            names alone carry the claim that matters - the agent may only read - and the transcript
            above shows which ones actually ran.
          */}
          <p className="text-[11.5px] text-muted">
            Read-only tools: <span className="mono">{TOOL_NAMES.join(", ")}</span>. The same
            questions run without a model at all on the <Link href="/questions">Questions</Link> page.
          </p>
      </div>
    </div>
  );
}
