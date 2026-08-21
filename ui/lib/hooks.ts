"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ensureLoaded, getServerState, getState, runQuery, subscribe } from "./duckdb";
import type { EngineState, QueryResult } from "./duckdb";
import { queryTableParquetUrl } from "./config";

/** Live view of the DuckDB engine: boot, download, ready or error. */
export function useEngine(): EngineState {
  return useSyncExternalStore(subscribe, getState, getServerState);
}

/** Kick the engine off once the page is interactive. */
export function useEngineBoot(): EngineState {
  const engine = useEngine();
  useEffect(() => {
    void ensureLoaded(queryTableParquetUrl()).catch(() => {
      // The error is already reflected in the engine state.
    });
  }, []);
  return engine;
}

export interface AsyncState<T> {
  data: T | null;
  /**
   * The JSON exactly as published, before the shared parser narrowed it. The coverage snapshot
   * carries per source flags (`constrained`, `implemented`, `limitations`) that the shared parse
   * does not model, and the Data page has to read them to tell a blocked source from a complete
   * one. Reading them from here costs no second request.
   */
  raw: unknown;
  error: string | null;
  loading: boolean;
  /** A previous payload is on screen and a fresh one is in flight. */
  revalidating: boolean;
}

/**
 * Last good payload per artifact URL, for the lifetime of the tab.
 *
 * Every page fetches its artifacts from an IPFS gateway on mount, and an IPNS name that is not yet
 * warm in the gateway can take many seconds to resolve. Without this, walking Overview -> Runs ->
 * Overview pays that latency three times and shows empty stat tiles each time, which is what a
 * reviewer sees during a demo. The cache is only a head start: a revalidating request always goes
 * out, and the newer payload replaces what is on screen when it lands, so the page stays as live
 * as the artifact it is reading.
 */
const PAYLOAD_CACHE = new Map<string, unknown>();

/** Fetch and parse a published JSON artifact on the client. */
export function useJson<T>(url: string | null, parse: (input: unknown) => T): AsyncState<T> {
  const parseRef = useRef(parse);
  parseRef.current = parse;

  const [state, setState] = useState<AsyncState<T>>(() => {
    const cached = url === null ? undefined : PAYLOAD_CACHE.get(url);
    if (cached === undefined) {
      return { data: null, raw: null, error: null, loading: url !== null, revalidating: false };
    }
    return { data: parse(cached), raw: cached, error: null, loading: false, revalidating: true };
  });

  useEffect(() => {
    if (!url) {
      setState({ data: null, raw: null, error: null, loading: false, revalidating: false });
      return;
    }
    let cancelled = false;
    const cached = PAYLOAD_CACHE.get(url);
    setState(
      cached === undefined
        ? { data: null, raw: null, error: null, loading: true, revalidating: false }
        : {
            data: parseRef.current(cached),
            raw: cached,
            error: null,
            loading: false,
            revalidating: true,
          },
    );

    /*
     * `cache: "default"`, not "no-store".
     *
     * The gateway answers these artifacts with `cache-control: public, max-age=300`, which is the
     * same 300 s window it caches an IPNS resolution for; the pipeline publishes on a six hour
     * cadence, so honouring that header costs no freshness a "no-store" request would have gained.
     * What "no-store" did cost was real: it bypassed the document's own <link rel="preload">, so
     * the head start the page asked for was thrown away and the request was made twice.
     */
    fetch(url, { cache: "default" })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`${response.status} ${response.statusText} for ${url}`);
        }
        return response.json();
      })
      .then((json: unknown) => {
        PAYLOAD_CACHE.set(url, json);
        if (cancelled) return;
        setState({
          data: parseRef.current(json),
          raw: json,
          error: null,
          loading: false,
          revalidating: false,
        });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        const message = error instanceof Error ? error.message : String(error);
        // A failed revalidation must not blank out a payload that is already on screen and
        // correct. It is reported as an error only when there is nothing to fall back to.
        setState((current) =>
          current.data === null
            ? { data: null, raw: null, error: message, loading: false, revalidating: false }
            : { ...current, error: message, loading: false, revalidating: false },
        );
      });

    return () => {
      cancelled = true;
    };
  }, [url]);

  return state;
}

/**
 * True once `active` has been true for `afterMs` without resolving.
 *
 * A wait that is going to be short should say nothing beyond its skeleton; a wait that is going
 * long has to explain itself, because a stat tile that is merely blank reads as broken.
 */
export function useSlowLoad(active: boolean, afterMs = 2500): boolean {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    if (!active) {
      setSlow(false);
      return;
    }
    const timer = setTimeout(() => setSlow(true), afterMs);
    return () => clearTimeout(timer);
  }, [active, afterMs]);
  return slow;
}

export interface SqlState {
  result: QueryResult | null;
  error: string | null;
  running: boolean;
  run: (sql: string) => Promise<void>;
  reset: () => void;
}

/** Run SQL against the published query table on demand. */
export function useSql(): SqlState {
  const [result, setResult] = useState<QueryResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const token = useRef(0);

  const run = useCallback(async (sql: string) => {
    const current = ++token.current;
    setRunning(true);
    setError(null);
    try {
      const next = await runQuery(queryTableParquetUrl(), sql);
      if (token.current !== current) return;
      setResult(next);
    } catch (caught: unknown) {
      if (token.current !== current) return;
      setResult(null);
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      if (token.current === current) setRunning(false);
    }
  }, []);

  const reset = useCallback(() => {
    token.current += 1;
    setResult(null);
    setError(null);
    setRunning(false);
  }, []);

  return { result, error, running, run, reset };
}

/** Copy to clipboard with a short lived confirmation. */
export function useCopy(): { copied: boolean; copy: (text: string) => void } {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  const copy = useCallback((text: string) => {
    const done = () => {
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1600);
    };
    if (navigator.clipboard?.writeText) {
      void navigator.clipboard.writeText(text).then(done).catch(() => setCopied(false));
      return;
    }
    // Fallback for insecure origins.
    const area = document.createElement("textarea");
    area.value = text;
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    try {
      document.execCommand("copy");
      done();
    } finally {
      document.body.removeChild(area);
    }
  }, []);

  return { copied, copy };
}
