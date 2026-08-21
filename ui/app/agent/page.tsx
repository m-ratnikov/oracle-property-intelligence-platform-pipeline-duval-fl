"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import type { AgentResponse, AgentToolCall, AgentEvidenceRow } from "@/app/api/agent/route";
import { PageHeader, Callout, Spinner } from "@/components/ui";
import { EngineStatus } from "@/components/EngineStatus";
import { formatTimestamp } from "@/lib/format";

interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  at: string;
  hint?: string;
  notImplemented?: boolean;
}

const DEMO_PROMPTS = [
  "Which properties have roofs older than 15 years and have not exchanged ownership in more than 10 years?",
  "Which properties are near public transportation and also have regional owners?",
  "Which properties appear to be strong candidates for further review based on ownership age, roof age, and location signals?",
];

const TOOLS = [
  { name: "get_schema", description: "DESCRIBE the published query table so the agent knows the columns before it writes SQL." },
  { name: "run_sql", description: "A single read only SELECT over the view properties, executed against the parquet on IPFS." },
  { name: "get_property", description: "Fetch one parcel by folio, including the per property JSON when it is published." },
  { name: "get_evidence", description: "Return source_system, source_url and fetched_at for the rows behind an answer." },
];

function ToolCallRow({ call }: { call: AgentToolCall }) {
  return (
    <li className="border-b border-border px-3 py-2 last:border-b-0">
      <div className="flex items-center gap-2">
        <span className="badge badge-accent">{call.name}</span>
        {call.summary ? <span className="text-[12px] text-muted">{call.summary}</span> : null}
      </div>
      <pre className="block mt-1.5" style={{ fontSize: 11 }}>
        {JSON.stringify(call.input, null, 2)}
      </pre>
      {call.result ? (
        <pre className="block mt-1" style={{ fontSize: 11 }}>
          {JSON.stringify(call.result, null, 2)}
        </pre>
      ) : null}
    </li>
  );
}

function EvidenceRow({ row }: { row: AgentEvidenceRow }) {
  return (
    <li className="border-b border-border px-3 py-2 text-[12px] last:border-b-0">
      <Link className="mono" prefetch={false} href={`/property/${encodeURIComponent(row.property_id)}`}>
        {row.property_id}
      </Link>
      <div className="mt-1 flex flex-wrap items-center gap-2 text-[11.5px]">
        <span className="badge badge-neutral">{row.source_system ?? "unknown source"}</span>
        {row.source_url ? (
          <a className="mono" href={row.source_url} target="_blank" rel="noreferrer">
            source
          </a>
        ) : null}
        <span className="mono text-faint">{formatTimestamp(row.fetched_at ?? null)}</span>
      </div>
    </li>
  );
}

export default function AgentPage() {
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: "intro",
      role: "system",
      text: "Ask a property intelligence question in plain English. The agent plans a tool call, runs read only SQL against the published parquet, and answers with the rows it used.",
      at: new Date().toISOString(),
    },
  ]);
  const [input, setInput] = useState("");
  const [pending, setPending] = useState(false);
  const [toolCalls, setToolCalls] = useState<AgentToolCall[]>([]);
  const [evidence, setEvidence] = useState<AgentEvidenceRow[]>([]);
  const [assumptions, setAssumptions] = useState<string[]>([]);
  const scroller = useRef<HTMLDivElement | null>(null);

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
            .filter((message) => message.role !== "system")
            .map((message) => ({ role: message.role, content: message.text })),
        }),
      });

      const payload = (await response.json()) as AgentResponse;

      setToolCalls(payload.toolCalls ?? []);
      setEvidence(payload.evidence ?? []);
      setAssumptions(payload.assumptions ?? []);
      setMessages((current) => [
        ...current,
        {
          id: `a-${Date.now()}`,
          role: "assistant",
          text: payload.message,
          hint: payload.hint,
          notImplemented: payload.status === "not_implemented" || response.status === 501,
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
          notImplemented: true,
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

      <div className="mb-4">
        <EngineStatus compact />
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="card flex flex-col" style={{ minHeight: 520 }}>
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
                      className={`max-w-[90%] rounded-lg rounded-bl-sm border px-3 py-2 text-[13px] ${
                        message.notImplemented
                          ? "border-warn/40 bg-warn-soft text-warn"
                          : "border-border bg-sunken text-text"
                      }`}
                    >
                      {message.notImplemented ? (
                        <div className="mb-1 text-[11px] font-bold uppercase tracking-wide">
                          agent not wired yet
                        </div>
                      ) : null}
                      <div>{message.text}</div>
                      {message.hint ? (
                        <div className="mt-2 border-t border-current/20 pt-2 text-[12px] opacity-90">
                          {message.hint}
                        </div>
                      ) : null}
                    </div>
                  </div>
                )}
              </div>
            ))}
            {pending ? <Spinner label="Thinking" /> : null}
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
                  {prompt.length > 52 ? `${prompt.slice(0, 50)}...` : prompt}
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
              Tool call transcript
            </div>
            {toolCalls.length === 0 ? (
              <div className="px-3 py-3 text-[12px] text-faint">
                No tool calls yet. When the agent is wired, every call it makes appears here with its
                arguments and its result, so the answer can be audited rather than trusted.
              </div>
            ) : (
              <ul>
                {toolCalls.map((call, index) => (
                  <ToolCallRow key={`${call.name}-${index}`} call={call} />
                ))}
              </ul>
            )}
          </div>

          <div className="card">
            <div className="border-b border-border px-3 py-2 text-[12px] font-semibold">
              Evidence
            </div>
            {evidence.length === 0 ? (
              <div className="px-3 py-3 text-[12px] text-faint">
                Rows the answer rests on land here, each with its source system, source URL and
                collection timestamp.
              </div>
            ) : (
              <ul>
                {evidence.map((row, index) => (
                  <EvidenceRow key={`${row.property_id}-${index}`} row={row} />
                ))}
              </ul>
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
              Until the runtime is attached, the same questions are answerable on the{" "}
              <Link href="/questions">Questions</Link> page, which runs those rules directly.
            </p>
          </div>
        </aside>
      </div>
    </div>
  );
}
