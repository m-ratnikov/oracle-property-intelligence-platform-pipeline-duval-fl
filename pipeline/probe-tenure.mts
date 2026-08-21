import { DuckDBInstance } from "@duckdb/node-api";

const parquet = process.argv[2].split("\\").join("/");
const inst = await DuckDBInstance.create(":memory:");
const conn = await inst.connect();
await conn.run(`CREATE OR REPLACE VIEW properties AS SELECT * FROM read_parquet('${parquet}')`);

const cols = await (await conn.run(`SELECT column_name, column_type FROM (DESCRIBE SELECT * FROM properties) WHERE lower(column_name) LIKE '%sale%' OR lower(column_name) LIKE '%tenure%'`)).getRowObjectsJS();
console.log("tenure-ish columns:", JSON.stringify(cols));

const q = `SELECT
  count(*) AS rows,
  count(last_sale_date) AS last_sale_date_nn,
  count(years_since_last_sale) AS ysls_nn,
  count(last_sale_date_any) AS last_sale_date_any_nn,
  count(no_sale_10y_flag) AS no_sale_flag_nn,
  count(tenure_basis) AS tenure_basis_nn,
  max(years_since_last_sale) AS ysls_max
FROM properties`;
console.log(JSON.stringify((await (await conn.run(q)).getRowObjectsJS())[0], (_k, v) => (typeof v === "bigint" ? String(v) : v), 2));

const basis = await (await conn.run(`SELECT tenure_basis, count(*) AS c FROM properties GROUP BY 1 ORDER BY 2 DESC`)).getRowObjectsJS();
console.log("tenure_basis:", JSON.stringify(basis, (_k, v) => (typeof v === "bigint" ? String(v) : v)));
