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
  error: string | null;
  loading: boolean;
}

/** Fetch and parse a published JSON artifact on the client. */
export function useJson<T>(url: string | null, parse: (input: unknown) => T): AsyncState<T> {
  const [state, setState] = useState<AsyncState<T>>({
    data: null,
    error: null,
    loading: url !== null,
  });
  const parseRef = useRef(parse);
  parseRef.current = parse;

  useEffect(() => {
    if (!url) {
      setState({ data: null, error: null, loading: false });
      return;
    }
    let cancelled = false;
    setState({ data: null, error: null, loading: true });

    fetch(url, { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`${response.status} ${response.statusText} for ${url}`);
        }
        return response.json();
      })
      .then((json: unknown) => {
        if (cancelled) return;
        setState({ data: parseRef.current(json), error: null, loading: false });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        const message = error instanceof Error ? error.message : String(error);
        setState({ data: null, error: message, loading: false });
      });

    return () => {
      cancelled = true;
    };
  }, [url]);

  return state;
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
