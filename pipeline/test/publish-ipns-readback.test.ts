import { describe, expect, it } from "vitest";
import { upsertIpnsName, type FilebaseIpnsName } from "../src/publish/filebase.js";

/**
 * The Filebase Names API accepts the write before the list endpoint serves it. Reading back once
 * therefore reports "IPNS readback CID mismatch" for names that are in fact correct a moment later:
 * three of five names on one publish were recorded as failures that way, and the workflow still
 * went green because nothing looked at the result. These tests pin the two halves of the fix -
 * the readback is retried, and a name that really does not move still fails.
 */

interface StubResponse {
  ok: boolean;
  status: number;
  statusText: string;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
}

function jsonResponse(body: unknown, status = 200): StubResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

function name(label: string, cid: string): FilebaseIpnsName {
  return {
    enabled: true,
    label,
    network_key: `k51-${label}`,
    cid,
    sequence: 1,
    published_at: "2026-08-21T00:00:00Z",
    created_at: "2026-08-21T00:00:00Z",
    updated_at: "2026-08-21T00:00:00Z",
  };
}

/**
 * A Names API whose list endpoint keeps serving the OLD cid for `staleReads` calls after the write.
 * `listCalls` counts every read so a test can prove the retry actually happened.
 */
function eventuallyConsistentApi(opts: { label: string; oldCid: string; staleReads: number }) {
  let stored = opts.oldCid;
  let written: string | null = null;
  let readsSinceWrite = 0;
  const state = { listCalls: 0, putCalls: 0 };
  const fetchImpl = async (url: string, init?: { method?: string; body?: string }): Promise<StubResponse> => {
    const method = init?.method ?? "GET";
    if (method === "GET") {
      state.listCalls += 1;
      if (written !== null) {
        readsSinceWrite += 1;
        if (readsSinceWrite > opts.staleReads) stored = written;
      }
      return jsonResponse([name(opts.label, stored)]);
    }
    if (method === "PUT") {
      state.putCalls += 1;
      written = (JSON.parse(init?.body ?? "{}") as { cid: string }).cid;
      readsSinceWrite = 0;
      return jsonResponse({});
    }
    return jsonResponse({});
  };
  return { fetchImpl, state };
}

const NO_SLEEP = { sleep: async (): Promise<void> => undefined };

describe("IPNS readback", () => {
  it("keeps polling until the name reports the CID we just wrote", async () => {
    const { fetchImpl, state } = eventuallyConsistentApi({ label: "oracle-query-table-duval", oldCid: "QmOLD", staleReads: 3 });

    const result = await upsertIpnsName(fetchImpl as never, "token", "oracle-query-table-duval", "QmNEW", {
      attempts: 6,
      ...NO_SLEEP,
    });

    expect(result.networkKey).toBe("k51-oracle-query-table-duval");
    expect(result.created).toBe(false);
    // one read to find the existing record, then four to get past three stale answers
    expect(result.readbackAttempts).toBe(4);
    expect(state.putCalls).toBe(1);
  });

  it("returns on the first read when the API is immediately consistent", async () => {
    const { fetchImpl } = eventuallyConsistentApi({ label: "oracle-run-history-duval", oldCid: "QmOLD", staleReads: 0 });
    const result = await upsertIpnsName(fetchImpl as never, "token", "oracle-run-history-duval", "QmNEW", { attempts: 6, ...NO_SLEEP });
    expect(result.readbackAttempts).toBe(1);
  });

  it("still fails, naming the budget, when the name genuinely never moves", async () => {
    const { fetchImpl, state } = eventuallyConsistentApi({ label: "oracle-dataset-coverage-duval", oldCid: "QmOLD", staleReads: 999 });

    await expect(
      upsertIpnsName(fetchImpl as never, "token", "oracle-dataset-coverage-duval", "QmNEW", { attempts: 4, ...NO_SLEEP }),
    ).rejects.toThrow(/readback CID mismatch.*after 4 readback attempts/s);
    // 1 lookup + 4 readbacks
    expect(state.listCalls).toBe(5);
  });

  it("rides out a transient failure of the list endpoint", async () => {
    const label = "oracle-published-counties";
    let listCalls = 0;
    const fetchImpl = async (_url: string, init?: { method?: string }): Promise<StubResponse> => {
      const method = init?.method ?? "GET";
      if (method !== "GET") return jsonResponse({});
      listCalls += 1;
      // first call: the name exists on QmOLD. second: gateway 503. third: consistent.
      if (listCalls === 1) return jsonResponse([name(label, "QmOLD")]);
      if (listCalls === 2) return jsonResponse({ error: "unavailable" }, 503);
      return jsonResponse([name(label, "QmNEW")]);
    };

    const result = await upsertIpnsName(fetchImpl as never, "token", label, "QmNEW", { attempts: 5, ...NO_SLEEP });
    expect(result.readbackAttempts).toBe(2);
  });

  it("backs off between attempts instead of hammering the API", async () => {
    const delays: number[] = [];
    const { fetchImpl } = eventuallyConsistentApi({ label: "duval-oracle-artifacts", oldCid: "QmOLD", staleReads: 3 });
    await upsertIpnsName(fetchImpl as never, "token", "duval-oracle-artifacts", "QmNEW", {
      attempts: 6,
      initialDelayMs: 100,
      maxDelayMs: 300,
      sleep: async (ms: number) => {
        delays.push(ms);
      },
    });
    expect(delays).toEqual([100, 200, 300]);
  });
});
