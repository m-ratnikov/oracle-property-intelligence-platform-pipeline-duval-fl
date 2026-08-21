/**
 * The remote source path, sealed.
 *
 * The published artifact is fetched over HTTP, so the sandbox has to permit exactly one URL (or the
 * temp file it was cached into) and nothing else. The local file path is covered by
 * tests/sql-guard.test.ts; this covers the branch a deployed invocation actually takes, because
 * "it is locked down locally" would be the wrong thing to have proved.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createReadStream, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { openPropertyDb, SAMPLE_PARQUET_PATH, type PropertyDb } from "@/lib/agent/db";
import { VIEW_NAME } from "@/lib/sql";

let server: Server;
let db: PropertyDb;
let port = 0;

beforeAll(async () => {
  const size = statSync(SAMPLE_PARQUET_PATH).size;
  server = createServer((request, response) => {
    const range = request.headers.range;
    const headers: Record<string, string | number> = {
      "content-type": "application/octet-stream",
      "accept-ranges": "bytes",
    };
    const match = range ? /bytes=(\d*)-(\d*)/.exec(range) : null;
    if (match) {
      const start = match[1] === "" ? size - Number(match[2]) : Number(match[1]);
      const end = match[2] === "" || match[1] === "" ? size - 1 : Number(match[2]);
      response.writeHead(206, {
        ...headers,
        "content-range": `bytes ${start}-${end}/${size}`,
        "content-length": end - start + 1,
      });
      createReadStream(SAMPLE_PARQUET_PATH, { start, end }).pipe(response);
      return;
    }
    response.writeHead(200, { ...headers, "content-length": size });
    createReadStream(SAMPLE_PARQUET_PATH).pipe(response);
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  port = typeof address === "object" && address !== null ? address.port : 0;
  db = await openPropertyDb(`http://127.0.0.1:${port}/query-table.parquet`, false);
}, 60_000);

afterAll(async () => {
  await db?.close();
  await new Promise<void>((done) => server?.close(() => done()));
});

describe("a database opened over a remote artifact", () => {
  it("reads the artifact it was opened over", async () => {
    const result = await db.query(`SELECT count(*) AS n FROM ${VIEW_NAME}`);
    expect(Number(result.rows[0].n)).toBeGreaterThan(0);
  });

  it("refuses a different URL on the same host", async () => {
    // Same origin, one query string apart. If the allowance were host wide rather than path exact,
    // this would succeed and an attacker chosen path on any reachable host would follow.
    await expect(
      db.query(`SELECT * FROM read_parquet('http://127.0.0.1:${port}/query-table.parquet?x=1')`),
    ).rejects.toThrow(/disabled by configuration|Permission Error/i);
  });

  it("refuses an attacker chosen host", async () => {
    await expect(
      db.query(`SELECT * FROM read_csv_auto('https://attacker.example/x.csv')`),
    ).rejects.toThrow(/disabled by configuration|Permission Error/i);
  });

  it("refuses local file reads", async () => {
    await expect(db.query(`SELECT * FROM read_text('/proc/self/environ')`)).rejects.toThrow(
      /disabled by configuration|Permission Error/i,
    );
  });

  it("cannot be unlocked from inside a query", async () => {
    await expect(db.query(`SET enable_external_access = true`)).rejects.toThrow(
      /locked|Cannot change configuration/i,
    );
  });
});
