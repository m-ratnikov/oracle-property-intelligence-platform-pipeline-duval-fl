import { readFileSync } from "node:fs";
import { DuckDBInstance } from "@duckdb/node-api";

const presets = JSON.parse(readFileSync(process.argv[2], "utf8")) as { id: string; label: string; combined: boolean; sql: string }[];
const parquet = process.argv[3].split("\\").join("/");
const inst = await DuckDBInstance.create(":memory:");
const conn = await inst.connect();
await conn.run(`CREATE OR REPLACE VIEW properties AS SELECT * FROM read_parquet('${parquet}')`);

const total = (await (await conn.run("SELECT count(*) c FROM properties")).getRowObjectsJS())[0].c;
console.log(`published parquet rows: ${total}`);

for (const p of presets) {
  const body = p.sql.replace(/\s+LIMIT\s+\d+\s*$/i, "");
  const t0 = Date.now();
  try {
    const cnt = (await (await conn.run(`SELECT count(*) AS c FROM (${body})`)).getRowObjectsJS())[0].c;
    const sample = await (await conn.run(`${body} LIMIT 2`)).getRowObjectsJS();
    const first = (sample[0] ?? {}) as Record<string, unknown>;
    const cols = Object.keys(first);
    const nonNull = cols.filter((k) => first[k] !== null && first[k] !== undefined).length;
    console.log(
      `${p.combined ? "[combo]" : "[six]  "} ${p.id.padEnd(20)} ${String(cnt).padStart(9)} rows  ${String(Date.now() - t0).padStart(5)}ms  non-null ${nonNull}/${cols.length}  parcel=${String(first.parcel_identifier ?? "?")}`,
    );
  } catch (e) {
    console.log(`${p.id.padEnd(20)} FAILED: ${e instanceof Error ? e.message : String(e)}`);
  }
}
