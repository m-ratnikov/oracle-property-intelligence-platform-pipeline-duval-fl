"use client";

/**
 * Where a visitor's model credential lives: this browser, and nowhere else.
 *
 * localStorage was chosen over the alternatives on purpose:
 *
 *  - Not a cookie. A cookie rides along on every request to this origin,
 *    including page navigations and static asset fetches, and would end up in
 *    access logs and CDN caches. A value read by explicit JavaScript and put
 *    on one header goes exactly where it is sent and nowhere else.
 *  - Not a server side store. There is no account here, so a server side store
 *    means holding strangers' credentials with no way to let them audit or
 *    revoke that. The whole app runs with no database; adding one to hold API
 *    keys would be the worst possible reason to add the first one.
 *  - Not sessionStorage. A reviewer who configures a key, closes the tab and
 *    comes back should not have to configure it twice.
 *
 * The tradeoff is stated to the visitor in the UI, in plain words: the key sits
 * in this browser's storage, any script running on this origin can read it, and
 * it is sent to this app's server with every question. Anyone uncomfortable
 * with that should mint a scoped, revocable key, which is why the settings page
 * links straight to each provider's key page.
 */

import { useCallback, useEffect, useState } from "react";
import { findModel, defaultModelFor, type AgentProvider } from "./providers";
import { KEY_HEADER, PROVIDER_HEADER, MODEL_HEADER } from "./credentials";

const STORAGE_KEY = "duval-oracle.agent.llm";
/** Fired on this tab when settings change, since `storage` only fires on others. */
const CHANGE_EVENT = "duval-oracle:agent-settings";

export interface StoredSettings {
  provider: AgentProvider;
  modelId: string;
  apiKey: string;
  /** ISO timestamp, shown so a visitor can see how old the stored key is. */
  savedAt: string;
}

function isBrowser(): boolean {
  return typeof window !== "undefined" && typeof window.localStorage !== "undefined";
}

/**
 * Read and validate. A stored provider or model that this build no longer
 * supports is discarded rather than sent, so an old value in a returning
 * visitor's browser cannot produce a confusing 400 on their first question.
 */
export function readSettings(): StoredSettings | null {
  if (!isBrowser()) return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredSettings>;
    if (typeof parsed.apiKey !== "string" || !parsed.apiKey.trim()) return null;
    if (typeof parsed.provider !== "string") return null;
    const modelId = typeof parsed.modelId === "string" ? parsed.modelId : defaultModelFor(parsed.provider);
    if (!findModel(parsed.provider, modelId)) return null;
    return {
      provider: parsed.provider,
      modelId,
      apiKey: parsed.apiKey.trim(),
      savedAt: typeof parsed.savedAt === "string" ? parsed.savedAt : new Date().toISOString(),
    };
  } catch {
    // A corrupt or unreadable entry (private mode, quota, hand edited) is
    // treated as "not configured" rather than as an error to show.
    return null;
  }
}

export function writeSettings(settings: Omit<StoredSettings, "savedAt">): StoredSettings | null {
  if (!isBrowser()) return null;
  const stored: StoredSettings = { ...settings, apiKey: settings.apiKey.trim(), savedAt: new Date().toISOString() };
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
    window.dispatchEvent(new Event(CHANGE_EVENT));
    return stored;
  } catch {
    return null;
  }
}

export function clearSettings(): void {
  if (!isBrowser()) return;
  try {
    window.localStorage.removeItem(STORAGE_KEY);
    window.dispatchEvent(new Event(CHANGE_EVENT));
  } catch {
    // Nothing useful to do; the caller re-reads and sees whatever survived.
  }
}

/**
 * The headers that carry the credential to /api/agent.
 *
 * Returns an empty object when nothing is stored, which is what makes the
 * unconfigured path fall through to the server's own configuration (or to the
 * honest 501 when there is none).
 */
export function credentialHeaders(settings: StoredSettings | null): Record<string, string> {
  if (!settings) return {};
  return {
    [KEY_HEADER]: settings.apiKey,
    [PROVIDER_HEADER]: settings.provider,
    [MODEL_HEADER]: settings.modelId,
  };
}

/**
 * Subscribe to the stored settings.
 *
 * Reads on mount rather than during render: the server render has no
 * localStorage, so treating "nothing stored" as the first client state keeps
 * the markup identical on both sides and avoids a hydration mismatch.
 */
export function useAgentSettings(): {
  settings: StoredSettings | null;
  /** False until the first client side read has happened. */
  loaded: boolean;
  refresh: () => void;
} {
  const [settings, setSettings] = useState<StoredSettings | null>(null);
  const [loaded, setLoaded] = useState(false);

  const refresh = useCallback(() => {
    setSettings(readSettings());
    setLoaded(true);
  }, []);

  useEffect(() => {
    refresh();
    const onChange = () => refresh();
    // `storage` covers other tabs, the custom event covers this one.
    window.addEventListener("storage", onChange);
    window.addEventListener(CHANGE_EVENT, onChange);
    return () => {
      window.removeEventListener("storage", onChange);
      window.removeEventListener(CHANGE_EVENT, onChange);
    };
  }, [refresh]);

  return { settings, loaded, refresh };
}

/** Never render a key. This is what the UI shows in its place. */
export function maskKey(key: string): string {
  const length = key.trim().length;
  if (length === 0) return "";
  return `${"•".repeat(Math.min(24, Math.max(8, length)))} (${length} characters)`;
}
