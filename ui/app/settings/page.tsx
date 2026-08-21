"use client";

/**
 * Model settings.
 *
 * A route rather than a drawer on /agent, for three reasons. It is linkable,
 * so the 501 body, the nav and the agent page can all point a visitor at one
 * URL. It is discoverable without knowing that a drawer exists. And /agent
 * already spends its right hand column on the tool transcript and the evidence
 * table, which are the two panels that make an answer auditable; a drawer would
 * cover exactly the thing the page is for.
 */

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { PageHeader, Callout, Section } from "@/components/ui";
import { PROVIDERS, findProvider, type AgentProvider } from "@/lib/agent/providers";
import { KEY_HEADER, MODEL_HEADER, PROVIDER_HEADER } from "@/lib/agent/credentials";
import {
  clearSettings,
  maskKey,
  readSettings,
  useAgentSettings,
  writeSettings,
} from "@/lib/agent/settings-client";
import { formatTimestamp, relativeTime } from "@/lib/format";

interface ServerConfig {
  configured: boolean;
  active: { provider: string; model: string; source: "user" | "server" } | null;
  server_default: { provider: string; model: string; env_key: string } | null;
}

interface TestOutcome {
  ok: boolean;
  toolCalling: boolean;
  elapsedMs: number;
  message: string;
  kind?: string;
}

export default function SettingsPage() {
  const { settings, loaded, refresh } = useAgentSettings();

  const [provider, setProvider] = useState<AgentProvider>("google");
  const [modelId, setModelId] = useState<string>("gemini-3.7-flash");
  const [apiKey, setApiKey] = useState("");
  const [reveal, setReveal] = useState(false);
  const [testing, setTesting] = useState(false);
  const [outcome, setOutcome] = useState<TestOutcome | null>(null);
  const [saved, setSaved] = useState(false);
  const [server, setServer] = useState<ServerConfig | null>(null);

  const definition = useMemo(() => findProvider(provider) ?? PROVIDERS[0], [provider]);

  // Adopt whatever is already stored, once, after the first client read.
  useEffect(() => {
    if (!loaded || !settings) return;
    setProvider(settings.provider);
    setModelId(settings.modelId);
  }, [loaded, settings]);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/agent", { method: "GET" })
      .then((response) => response.json())
      .then((payload: ServerConfig) => {
        if (!cancelled) setServer(payload);
      })
      .catch(() => {
        if (!cancelled) setServer(null);
      });
    return () => {
      cancelled = true;
    };
  }, [saved]);

  const onProviderChange = useCallback((next: AgentProvider) => {
    setProvider(next);
    const chosen = findProvider(next);
    // Snap to the provider's first free model so switching never silently
    // parks a visitor on a billed one.
    const preferred = chosen?.models.find((model) => model.free) ?? chosen?.models[0];
    if (preferred) setModelId(preferred.id);
    setOutcome(null);
  }, []);

  /**
   * Test against a real call. The key on the form is used if one was typed,
   * otherwise the stored key is reused, so "test what I already saved" works
   * without making the visitor paste it again.
   */
  const runTest = useCallback(async () => {
    const key = apiKey.trim() || readSettings()?.apiKey || "";
    if (!key) {
      setOutcome({ ok: false, toolCalling: false, elapsedMs: 0, message: "Paste a key first." });
      return;
    }
    setTesting(true);
    setOutcome(null);
    try {
      const response = await fetch("/api/agent/test", {
        method: "POST",
        headers: {
          [KEY_HEADER]: key,
          [PROVIDER_HEADER]: provider,
          [MODEL_HEADER]: modelId,
        },
      });
      const payload = (await response.json()) as {
        ok: boolean;
        tool_calling: boolean;
        elapsed_ms: number;
        error?: string;
        error_kind?: string;
        hint?: string;
      };
      setOutcome({
        ok: payload.ok,
        toolCalling: Boolean(payload.tool_calling),
        elapsedMs: payload.elapsed_ms ?? 0,
        kind: payload.error_kind,
        message: payload.ok
          ? payload.tool_calling
            ? `${provider}:${modelId} answered and called the probe tool.`
            : `${provider}:${modelId} answered, but did not call the probe tool. ${payload.hint ?? ""}`
          : `${payload.error ?? "The provider rejected the call."} ${payload.hint ?? ""}`.trim(),
      });
    } catch (error: unknown) {
      setOutcome({
        ok: false,
        toolCalling: false,
        elapsedMs: 0,
        message: `Could not reach the test endpoint: ${error instanceof Error ? error.message : String(error)}`,
      });
    } finally {
      setTesting(false);
    }
  }, [apiKey, modelId, provider]);

  const onSave = useCallback(() => {
    const key = apiKey.trim() || readSettings()?.apiKey || "";
    if (!key) return;
    writeSettings({ provider, modelId, apiKey: key });
    setApiKey("");
    setReveal(false);
    setSaved(true);
    refresh();
    window.setTimeout(() => setSaved(false), 4000);
  }, [apiKey, modelId, provider, refresh]);

  const onClear = useCallback(() => {
    clearSettings();
    setApiKey("");
    setOutcome(null);
    setSaved(false);
    refresh();
  }, [refresh]);

  const storedProvider = settings ? findProvider(settings.provider) : null;

  return (
    <div>
      <PageHeader
        title="Model settings"
        lead="Point the property agent at a model you control. The agent, its five tools and the evidence it returns are identical whichever provider answers; only the model changes."
      />

      <Callout tone="warn" title="Where your key goes, in plain words">
        <ul className="list-disc pl-4">
          <li>
            The key is saved in <span className="mono">localStorage</span> in this browser. It is not sent
            anywhere when you save it, and this site keeps no copy of it on any server or in any database.
          </li>
          <li>
            It is attached to each question you ask, in the{" "}
            <span className="mono">{KEY_HEADER}</span> header over HTTPS, so it does reach this app&apos;s
            server. It is used to build one provider client for that one request and is then discarded. It is
            never written to a log and never returned in a response.
          </li>
          <li>
            Anything running in this browser on this origin can read <span className="mono">localStorage</span>,
            and anyone using this device can. Use a key you are willing to revoke, and clear it below when you
            are done.
          </li>
        </ul>
      </Callout>

      <div className="mt-5 grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div className="space-y-4">
          <Section title="1. Provider" description="Free tier claims below were read from each provider's own page on the date shown. They move; re-check before relying on one.">
            <div className="grid gap-2 sm:grid-cols-2">
              {PROVIDERS.map((entry) => {
                const active = entry.id === provider;
                return (
                  <button
                    key={entry.id}
                    type="button"
                    onClick={() => onProviderChange(entry.id)}
                    className={`card card-pad text-left ${active ? "!border-accent" : ""}`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[13px] font-semibold">{entry.label}</span>
                      <span className={`badge ${entry.freeTier.available ? "badge-good" : "badge-neutral"}`}>
                        {entry.freeTier.available ? "free tier" : "paid only"}
                      </span>
                    </div>
                    <div className="mt-1 text-[12px] text-muted">{entry.freeTier.summary}</div>
                    <div className="mt-1 text-[11px] text-faint">
                      read {entry.freeTier.readOn} from{" "}
                      <a href={entry.freeTier.source} target="_blank" rel="noreferrer" className="mono">
                        source
                      </a>
                    </div>
                  </button>
                );
              })}
            </div>
          </Section>

          <Section title="2. Model" description={`Models this build supports for ${definition.label}.`}>
            <div className="space-y-2">
              {definition.models.map((model) => {
                const active = model.id === modelId;
                return (
                  <button
                    key={model.id}
                    type="button"
                    onClick={() => {
                      setModelId(model.id);
                      setOutcome(null);
                    }}
                    className={`card card-pad block w-full text-left ${active ? "!border-accent" : ""}`}
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-[13px] font-semibold">{model.label}</span>
                      <span className="mono text-[11px] text-faint">{model.id}</span>
                      <span className={`badge ${model.free ? "badge-good" : "badge-warn"}`}>
                        {model.free ? "free" : "billed"}
                      </span>
                    </div>
                    <div className="mt-1 text-[12px] text-muted">{model.notes}</div>
                  </button>
                );
              })}
            </div>
          </Section>

          <Section
            title="3. Key"
            description={definition.keyHint}
          >
            <div className="card card-pad space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                <input
                  className="field mono flex-1"
                  type={reveal ? "text" : "password"}
                  autoComplete="off"
                  spellCheck={false}
                  placeholder={settings ? "leave blank to keep the stored key" : "paste your API key"}
                  value={apiKey}
                  onChange={(event) => {
                    setApiKey(event.target.value);
                    setOutcome(null);
                  }}
                />
                <button type="button" className="btn btn-sm" onClick={() => setReveal((current) => !current)}>
                  {reveal ? "hide" : "show"}
                </button>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <button type="button" className="btn" onClick={() => void runTest()} disabled={testing}>
                  {testing ? "testing against the provider" : "test credentials"}
                </button>
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={onSave}
                  disabled={!apiKey.trim() && !settings}
                >
                  save to this browser
                </button>
                <button type="button" className="btn btn-sm" onClick={onClear} disabled={!settings}>
                  clear stored key
                </button>
                <a className="btn btn-sm" href={definition.keyUrl} target="_blank" rel="noreferrer">
                  get a {definition.label} key
                </a>
              </div>

              {outcome ? (
                <div
                  className={`rounded border px-3 py-2 text-[12px] ${
                    outcome.ok && outcome.toolCalling
                      ? "border-good/40 bg-good-soft text-good"
                      : outcome.ok
                        ? "border-warn/40 bg-warn-soft text-warn"
                        : "border-bad/40 bg-bad-soft text-bad"
                  }`}
                >
                  <div className="font-semibold uppercase tracking-wide text-[11px]">
                    {outcome.ok && outcome.toolCalling
                      ? "credentials work"
                      : outcome.ok
                        ? "credentials work, tool calling did not"
                        : `credentials rejected${outcome.kind ? ` (${outcome.kind})` : ""}`}
                  </div>
                  <div className="mt-1">{outcome.message}</div>
                  {outcome.elapsedMs ? (
                    <div className="mono mt-1 text-[11px] opacity-80">{outcome.elapsedMs} ms round trip</div>
                  ) : null}
                </div>
              ) : null}

              {saved ? (
                <div className="rounded border border-good/40 bg-good-soft px-3 py-2 text-[12px] text-good">
                  Saved in this browser. <Link href="/agent">Ask the agent something</Link> and the answer will
                  name this model.
                </div>
              ) : null}
            </div>
          </Section>
        </div>

        <aside className="space-y-4">
          <div className="card">
            <div className="border-b border-border px-3 py-2 text-[12px] font-semibold">What is answering now</div>
            <div className="space-y-2 px-3 py-3 text-[12px]">
              {!loaded ? (
                <div className="text-faint">reading this browser</div>
              ) : settings ? (
                <>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="badge badge-accent">your key</span>
                    <span className="mono">
                      {settings.provider}:{settings.modelId}
                    </span>
                  </div>
                  <div className="text-muted">{storedProvider?.label ?? settings.provider}</div>
                  <div className="mono text-faint">{maskKey(settings.apiKey)}</div>
                  <div className="text-faint">
                    saved {formatTimestamp(settings.savedAt)} ({relativeTime(settings.savedAt)})
                  </div>
                </>
              ) : server?.configured && server.server_default ? (
                <>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="badge badge-neutral">server default</span>
                    <span className="mono">
                      {server.server_default.provider}:{server.server_default.model}
                    </span>
                  </div>
                  <div className="text-muted">
                    Configured on the server through <span className="mono">{server.server_default.env_key}</span>.
                    The value is never sent to this page.
                  </div>
                </>
              ) : (
                <>
                  <span className="badge badge-warn">nothing configured</span>
                  <div className="text-muted">
                    This deployment ships with no server side key. A public, unauthenticated endpoint attached to
                    someone&apos;s API budget is a bill waiting to happen, so the agent answers only with a key you
                    bring. Until you add one, <span className="mono">/api/agent</span> returns 501 and says so
                    rather than inventing an answer.
                  </div>
                  <div className="text-muted">
                    Every question the agent handles is also answerable without any model on the{" "}
                    <Link href="/questions">Questions</Link> page, which runs the same SQL rules in your browser.
                  </div>
                </>
              )}
            </div>
          </div>

          <div className="card card-pad text-[12px]">
            <div className="font-semibold">How the request is shaped</div>
            <p className="mt-2 text-muted">
              Each question carries three headers. Nothing else about your credential leaves this browser.
            </p>
            <pre className="mt-2 block" style={{ fontSize: 11 }}>
              {`POST /api/agent
${PROVIDER_HEADER}: ${provider}
${MODEL_HEADER}: ${modelId}
${KEY_HEADER}: <your key>`}
            </pre>
            <p className="mt-2 text-muted">
              <span className="mono">GET /api/agent</span> reports which provider and model would answer and
              lists everything supported. It reports whether a key is set, never the key.
            </p>
          </div>
        </aside>
      </div>
    </div>
  );
}
