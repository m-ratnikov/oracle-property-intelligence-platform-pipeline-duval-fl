import { describe, expect, it } from "vitest";
import { putObject } from "../src/publish/filebase.js";

/**
 * Regression for Actions run 32475509467: 17,640 of 77,000 open-data uploads failed with
 * "Duplicate middleware name 'captureFilebaseCid'". putObject attached its response-capturing
 * middleware to the shared S3 client, so with 64 uploads in flight one call added a name another
 * had not yet removed. Each failure then burned six backoff retries, which is why the average PUT
 * took about seven seconds and 404k objects projected to twelve hours.
 *
 * The middleware now goes on the command. A command is created per call, so its stack cannot be
 * contended; the client's stack is never touched at all. Both of those are asserted below - the
 * second one is what actually prevents the bug, so it is tested directly rather than inferred.
 */

/**
 * A client whose middleware stack enforces the same uniqueness rule the AWS SDK does. If putObject
 * ever goes back to registering on the client, `add` sees the name twice and throws exactly as the
 * SDK did in production.
 */
function clientWithStrictStack() {
  const names = new Set<string>();
  const addCalls: string[] = [];
  const sent: string[] = [];
  return {
    names,
    addCalls,
    sent,
    client: {
      middlewareStack: {
        add: (_mw: unknown, opts: { name: string }) => {
          addCalls.push(opts.name);
          if (names.has(opts.name)) throw new Error(`Duplicate middleware name '${opts.name}'`);
          names.add(opts.name);
        },
        remove: (name: string) => names.delete(name),
      },
      send: async (command: { middlewareStack: { identify: () => string[] }; input?: { Key?: string } }) => {
        // every command must carry its own copy of the capture middleware
        const ids = command.middlewareStack.identify();
        expect(ids.some((entry) => entry.startsWith("captureFilebaseCid"))).toBe(true);
        // hold the call open across an await: the window the original bug needed
        await new Promise((resolve) => setTimeout(resolve, 5));
        sent.push(command.input?.Key ?? "<no key>");
        return {};
      },
    },
  };
}

describe("putObject under concurrency", () => {
  it("runs 64 uploads on one client without a duplicate middleware name", async () => {
    const { client, sent, addCalls } = clientWithStrictStack();

    const results = await Promise.allSettled(
      Array.from({ length: 64 }, (_, i) =>
        putObject(client as never, {
          bucket: "b",
          key: `open-data/duval/properties/obj-${i}.json`,
          body: Buffer.from(`{"i":${i}}`),
          contentType: "application/json",
        }),
      ),
    );

    expect(results.filter((r) => r.status === "rejected").map((r) => String((r as PromiseRejectedResult).reason))).toEqual([]);
    expect(sent).toHaveLength(64);
    // the real fix: shared client state is never mutated, so there is nothing to contend over
    expect(addCalls).toEqual([]);
  });

  it("needs no middleware stack on the client at all", async () => {
    const bare = {
      send: async (command: { input?: { Key?: string } }) => {
        expect(command.input?.Key).toBe("k");
        return {};
      },
    };
    await expect(
      putObject(bare as never, { bucket: "b", key: "k", body: Buffer.from("x"), contentType: "application/json" }),
    ).resolves.toBeUndefined();
  });
});
