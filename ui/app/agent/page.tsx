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
import { formatTimestamp, relativeTime } from "@/lib/format";

interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  at: string;
  hint?: string;
  notImplemented?: boolean;
  error?: boolean;
  meta?: { model: string | null; usage: AgentUsage | null; elapsed_ms?: number; toolCalls: number };
}

const DEMO_PROMPTS = [
  "Which properties have roofs older than 15 years and have not exchanged ownership in more than 10 years?",
  "Which properties are near public transportation and also have regional owners?",
  "Which properties appear to be strong candidates for further review based on ownership age, roof age, and location signals?",
];

const TOOLS = [
  { name: "get_schema", description: "DESCRIBE the published query table plus the six question rules, so the agent knows the columns before it writes SQL." },
  { name: "preset_question", description: "Run one of the eight question presets, the exact SQL the Questions page runs, with evidence and provenance columns and a total match count." },
  { name: "run_sql", description: "A single read only SELECT over the view properties in server side DuckDB, capped at 200 rows, for combinations and rankings." },
  { name: "get_property", description: "Fetch one parcel by folio, including the per property JSON on IPFS when it is published." },
  { name: "get_run_history", description: "Read the pipeline run history for freshness, sources, deltas and documented limitations." },
];

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

function EvidenceTable({ rows }: { rows: AgentEvidenceRow[] }) {
  const matched = new Set<string>();
  for (const row of rows) for (const key of Object.keys(row)) if (!EVIDENCE_META.has(key)) matched.add(key);
  const columns = [...matched].slice(0, 8);
  return (
    <div className="overflow-auto">
      <table className="w-full text-[11.5px]">
        <thead>
          <tr className="text-left text-faint">
            <th className="px-2 py-1 font-semibold">property_id</th>
            <th className="px-2 py-1 font-semibold">address</th>
            {columns.map((column) => (
              <th key={column} className="px-2 py-1 font-semibold mono">
                {column}
              </th>
            ))}
            <th className="px-2 py-1 font-semibold">source</th>
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
              <td className="px-2 py-1 whitespace-nowrap">
                <span className="badge badge-neutral">{row.source_system ?? "unknown"}</span>{" "}
                {row.source_url ? (
                  <a className="mono" href={row.source_url} target="_blank" rel="noreferrer">
                    source
                  </a>
                ) : null}
                <div className="mono text-faint">{formatTimestamp(row.fetched_at ?? null)}</div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
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
  const [configured, setConfigured] = useState<boolean | null>(null);
  const scroller = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/agent", { method: "GET" })
      .then((response) => response.json())
      .then((payload: { configured?: boolean }) => {
        if (!cancelled) setConfigured(Boolean(payload.configured));
      })
      .catch(() => {
        if (!cancelled) setConfigured(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const send = async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || pending) return;

    const outgoing: ChatMessage = {
      id: `u-${Date.now()}`,
      role: "user",
      text: trimmed,
      at: new Date().toISOString(),
    };
    setMessages((current) => [...current, outgoing]);
    setInput("");
    setPending(true);

    try {
      const response = await fetch("/api/agent", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          messages: [...messages, outgoing]
            .filter((message) => message.role !== "system" && !message.notImplemented && !message.error)
            .map((message) => ({ role: message.role, content: message.text })),
        }),
      });

      const payload = (await response.json()) as AgentResponse;
      const notImplemented = payload.status === "not_implemented" || response.status === 501;
      const failed = payload.status === "error" || (!response.ok && !notImplemented);

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
        {configured === false ? (
          <span className="badge badge-warn">agent not configured: set ANTHROPIC_API_KEY</span>
        ) : configured === true ? (
          <span className="badge badge-good">agent configured</span>
        ) : null}
        <FreshnessBadge freshness={freshness} />
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_380px]">
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
            {pending ? <Spinner label="Thinking, running tools" /> : null}
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

        <aside className="space-y-4">
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

          <div className="card">
            <div className="border-b border-border px-3 py-2 text-[12px] font-semibold">
              Evidence {evidence.length > 0 ? `(${evidence.length} parcels)` : ""}
            </div>
            {evidence.length === 0 ? (
              <div className="px-3 py-3 text-[12px] text-faint">
                Rows the answer rests on land here, each with the matched columns, its source
                system, source URL and collection timestamp.
              </div>
            ) : (
              <EvidenceTable rows={evidence} />
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

          <div className="card card-pad">
            <div className="text-[12px] font-semibold">Tools the agent is given</div>
            <ul className="mt-2 space-y-2 text-[12px]">
              {TOOLS.map((tool) => (
                <li key={tool.name}>
                  <span className="mono font-semibold">{tool.name}</span>
                  <div className="text-muted">{tool.description}</div>
                </li>
              ))}
            </ul>
            <p className="mt-3 text-[12px] text-muted">
              The same questions are answerable on the <Link href="/questions">Questions</Link> page,
              which runs those rules directly in the browser.
            </p>
          </div>
        </aside>
      </div>
    </div>
  );
}
