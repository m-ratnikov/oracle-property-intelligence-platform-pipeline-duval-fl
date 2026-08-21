# Duval County property intelligence UI

The hosted explorer for the Duval County, Florida property intelligence dataset that the pipeline
publishes to Elephant IPFS.

The point of this application is what it does **not** contain. There is no database, no API server
and no query backend. The UI downloads nothing at build time and stores nothing at runtime. It reads
the published artifacts directly from an IPFS gateway and runs every query in the visitor's browser
with DuckDB-WASM. Vercel serves static files. When nobody has the page open, nothing is running and
nothing is being billed.

```
  IPFS gateway (public, content addressed)          Your browser
  ------------------------------------------        -------------------------------------------
  query-table.parquet     <---- HTTP range reads --- DuckDB-WASM  ->  view "properties"  ->  SQL
  run-history.json        <---- fetch -------------- run history, deltas, limitations, artifacts
  dataset-coverage.json   <---- fetch -------------- ingested against expected per source
  catalog.json            <---- fetch -------------- published counties, for MCP discovery
  open-data/index.json    <---- fetch -------------- per property consolidated records
                                                     ^
  Vercel  ---- static HTML/JS/CSS + duckdb-eh.wasm --/     (one dynamic route, /api/agent, stubbed)
```

## Pages

| Route | What it shows | Reads |
|---|---|---|
| `/` | County, last run time, totals by source, every published artifact with CID, IPNS name and gateway URL, and the zero standing cost statement | run-history.json, catalog.json, parquet (row count) |
| `/runs` | Every run in reverse order, per source rows / inserted / updated / unchanged / delta, documented source limitations, a cumulative rows per source chart, latest deltas highlighted | run-history.json |
| `/data` | Record counts per source, ingested against expected coverage, per column non null coverage computed live in DuckDB, provenance breakdowns, honest "not available" labels | dataset-coverage.json, parquet |
| `/query` | SQL workbench over the view `properties`, schema sidebar from `DESCRIBE`, preset buttons, result grid, CSV export, read only guard | parquet |
| `/questions` | The six assignment questions plus two combined presets. Each card carries the rule in plain English, a run button, the evidence columns highlighted, a provenance badge per row and an assumptions list | parquet |
| `/property/[id]` | One parcel: every published column grouped, sales, permits, an OpenStreetMap thumbnail, provenance, and a link to the per property IPFS JSON | parquet, open-data/index.json |
| `/agent` | Chat shell with a tool call transcript panel and an evidence panel, posting to `/api/agent` | `/api/agent` |
| `/mcp` | How to connect a client over streamable HTTP or stdio, the environment map we deploy the MCP server with, and a live check that resolves the artifact and verifies its parquet header | parquet (HEAD + 4 byte range), catalog.json |

## Environment variables

Every variable the explorer pages read is `NEXT_PUBLIC_*` and therefore public. That is deliberate:
all of them are public content addressed URLs, and the browser talks to the gateway directly with
no server in between. The only secret is the model key for the optional agent route
(`ANTHROPIC_API_KEY`, server side only, see the Agent section). See `.env.example` for the full
annotated list.

| Variable | Required | Falls back to |
|---|---|---|
| `NEXT_PUBLIC_QUERY_TABLE_URL` | yes | `/sample/query-table.parquet` |
| `NEXT_PUBLIC_RUN_HISTORY_URL` | yes | `/sample/run-history.json` |
| `NEXT_PUBLIC_COVERAGE_URL` | yes | `/sample/dataset-coverage.json` |
| `NEXT_PUBLIC_CATALOG_URL` | yes | `/sample/catalog.json` |
| `NEXT_PUBLIC_OPEN_DATA_INDEX_URL` | no | `/sample/open-data/index.json` |
| `NEXT_PUBLIC_MCP_URL` | no | placeholder snippets on `/mcp` |
| `NEXT_PUBLIC_COUNTY_KEY` / `_COUNTY_NAME` / `_STATE_CODE` | no | `duval` / `Duval` / `FL` |

`NEXT_PUBLIC_QUERY_TABLE_URL` accepts either an IPNS directory root
(`https://ipfs.filebase.io/ipns/k51.../`, in which case `query-table.parquet` is appended) or a
direct URL to the parquet object.

**Any unset variable puts the app into SAMPLE mode**: it reads the synthetic files in
`public/sample`, shows a persistent banner across the top and a `SAMPLE` badge on every affected
panel. Synthetic rows can never be mistaken for county records.

## Running locally

```bash
pnpm install
pnpm sample     # regenerate public/sample (only needed if you change the generator)
pnpm dev        # http://localhost:3000
```

`pnpm dev` and `pnpm build` both chain `scripts/copy-duckdb.mjs` first, which copies the DuckDB-WASM
runtime out of `node_modules` into `public/duckdb`. That directory is generated and gitignored. The
copy is chained explicitly with `&&` rather than being a `prebuild` hook, because pnpm's
`enable-pre-post-scripts` default has moved between majors and a build host that skips the hook would
ship a page with no query engine.

To run against real published artifacts, put the URLs in `.env.local` and restart.

## Sample data

`pnpm sample` writes `public/sample` from a fixed seed, so it is reproducible:

- `query-table.parquet`, 480 parcels, 51 columns (the 37 canonical Elephant query table columns plus
  14 pipeline extras), written through DuckDB with real column types and ZSTD compression
- `run-history.json`, four runs across nine sources with deltas and documented limitations
- `dataset-coverage.json`, ingested against expected per source
- `catalog.json`, a published counties catalog entry
- `open-data/`, an index, two shards and 40 per property consolidated records

Every file carries a `note` field saying it is synthetic, and the shapes match the published
contract exactly, so switching to real URLs changes nothing but the data.

## Tests

```bash
pnpm lint       # tsc --noEmit
pnpm test       # vitest: unit + DuckDB integration
pnpm test:e2e   # playwright: browser smoke against a production build
```

`tests/presets.test.ts` is the load bearing one. It takes the exact SQL strings the UI ships and runs
them through a real DuckDB against the sample parquet, asserting that each of the eight presets
returns rows, that the results actually satisfy the rule (no roof newer than 15 years in the roof
list, nothing beyond 800 m in the walking distance lists, only `REGIONAL` in the regional owner
list), that every result carries provenance columns, and that the query table holds one row per
folio with no duplicate or null folios.

`tests/e2e/smoke.spec.ts` drives a real browser against `next start`. It proves DuckDB-WASM boots and
the parquet loads, that all eight presets return rows with a provenance column, that the workbench
rejects a write statement, that the run history renders with deltas and limitations, that the data
page computes column coverage in the browser, and that the MCP page resolves the artifact and reads a
valid `PAR1` parquet header. Point it at a deployment with
`PLAYWRIGHT_BASE_URL=https://... pnpm test:e2e`.

## Deploying to Vercel

1. **Import the repository** and set **Root Directory** to `ui`. Vercel detects Next.js; leave the
   build and install commands on their defaults (`pnpm install`, `pnpm build`). The build script
   copies the DuckDB runtime into `public/duckdb` itself.
2. **Add the environment variables** from the table above under Settings, Environment Variables, for
   Production and Preview.
3. **Deploy.** `NEXT_PUBLIC_*` values are inlined at build time, so any change to them needs a
   redeploy, not just a restart.
4. **Verify** by opening `/mcp`. The live resolution check either confirms the artifact resolves and
   serves byte ranges, or tells you exactly which header the gateway is withholding.

Cost model: eight routes, seven of them prerendered static. The only serverless functions are
`/api/agent` (called only from the agent page) and `/property/[id]`, which renders an empty client
shell. Link prefetching is disabled on property links so a result grid does not fire an invocation
per visible row. Static assets, including the 33 MB wasm module, are served from the CDN and cached
immutably.

## Constraints hit, and the decisions made

**COOP/COEP were not needed, and that was deliberate.** DuckDB-WASM ships three bundles. The `coi`
bundle is multi threaded and requires cross origin isolation, which means sending
`Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp`. Turning
that on would break every cross origin resource that does not send CORP headers: the IPFS gateway
reads, and the OpenStreetMap tiles on the property page. We ship the single threaded `eh` bundle
instead, which needs no special headers at all. Query latency on a 480 row sample is around 30 ms and
range reads keep it flat as the artifact grows.

**The wasm is self hosted, not pulled from a CDN.** `scripts/copy-duckdb.mjs` copies
`duckdb-eh.wasm` and its worker into `public/duckdb` on every `predev` and `prebuild`. The app does
not depend on jsDelivr being up, and the version is pinned by the lockfile. `lib/duckdb.ts` still
falls back to `getJsDelivrBundles()` if the local bundle fails to instantiate. The `mvp` bundle is
deliberately not shipped: it is another 38 MB of static assets for browsers that predate wasm
exception handling.

**Worker URLs must be absolute.** The wasm module is fetched from inside the DuckDB worker, and a
worker has no document base URL, so passing `/duckdb/duckdb-eh.wasm` fails with
`Failed to construct 'Request': Failed to parse URL`. Every URL handed to the worker, including the
parquet registered for range reads, goes through `absolute()` in `lib/duckdb.ts`.

**`serverExternalPackages: ["@duckdb/duckdb-wasm"]`** keeps the Next server compiler from tracing the
wasm assets into the serverless output. The package is browser only and `lib/duckdb.ts` is
`"use client"`.

**Three load paths, in order.** Cached copy (OPFS, with an in memory fallback), then HTTP range reads
through `registerFileURL`, then a whole object download registered as a buffer. The status line on
every querying page says which one is in use, because "the browser is the query engine" is the claim
the submission rests on and it should be visible, not asserted. If a gateway refuses ranged cross
origin requests the app still works, it just downloads once and caches.

**The workbench is read only twice over.** DuckDB-WASM runs an in memory database in the visitor's
own tab, so it physically cannot write to the published artifact. On top of that `guardSql` rejects
anything that is not a single `SELECT`, `WITH`, `DESCRIBE`, `SUMMARIZE`, `SHOW`, `PRAGMA` or
`EXPLAIN`, strips comments first so they cannot hide a second statement, and wraps every result set
in an enforced `LIMIT`.

**Missing columns disable a question rather than silently returning nothing.** Each preset declares
the columns it needs. If the published parquet lacks one, the card says which column is missing and
the run button stays disabled. The same honesty rule runs through the whole UI: a null renders as
`not available`, a column that is published but entirely empty is named on the Data page, and a
coverage percentage is only shown when the source publishes an expected total.

## Engineering guideline deviations

Applied: TypeScript everywhere and `strict` on, no secrets anywhere (there is nothing to keep
secret), tests at both the unit and browser level, structured honesty about data gaps.

Deviated, by requirement of the assignment:

- **No AWS and no CDK.** The assignment requires a public URL with no ongoing infrastructure cost.
  Vercel's free tier plus static hosting meets that; a CDK stack would not.
- **No structured logging or metrics backend.** There is no server to emit them from. The equivalent
  observability lives in the UI itself: the engine status line, the live MCP resolution check and the
  per column coverage panel all report real state rather than assumed state.
- **`/api/agent` returns 501 until a model key is configured.** Without `ANTHROPIC_API_KEY` the
  route answers `501 {"status":"not_implemented","message":"agent not configured: set
  ANTHROPIC_API_KEY"}` and the chat UI renders that as an explicit "agent not configured" state.
  Returning a plausible sounding answer with no tool call behind it would be worse than returning
  nothing on a submission judged on evidence. See the Agent section below.
- **Anthropic API instead of Bedrock for the agent.** The kit standard is the Vercel AI SDK
  `ToolLoopAgent` on Amazon Bedrock with prompt caching. This deployment has no AWS account, so the
  default provider is `@ai-sdk/anthropic` with Anthropic prompt caching on the system prompt; the
  Bedrock path (with the kit's cache point middleware) is kept behind `AGENT_PROVIDER=bedrock`.
  Asana ingress, DynamoDB chat state, AgentCore memory and LangSmith are not applicable to a single
  page chat on Vercel; the equivalent is the in page transcript plus one JSON log line per tool call
  and per turn on the server.

## Agent

`/agent` is a chat over the same dataset. Each turn is one Vercel AI SDK `ToolLoopAgent` run
(`lib/agent/run.ts`) with five explicitly registered, read only tools (`lib/agent/tools.ts`), each
with a zod input schema:

| Tool | What it does |
|---|---|
| `get_schema` | `DESCRIBE properties` plus a one line meaning per column and the eight question rules in plain English |
| `preset_question` | Runs one of the eight presets from `lib/sql.ts` by name (`roof_over_15`, `water_view`, `no_sale_10y`, `regional_owner`, `near_transit`, `near_starbucks`, `roof15_and_no_sale10y`, `transit_and_regional`), returns rows with evidence and provenance columns, the rule, the total match count and the preset's caveats |
| `run_sql` | One `SELECT`/`WITH` over `properties`, guarded by the same `guardSql` the workbench uses, capped at 200 rows, with `total_matched` when the cap cut rows off |
| `get_property` | Full row for one folio plus the per property open data JSON from IPFS when published |
| `get_run_history` | The run history JSON: runs, timestamps, per source counts and deltas, limitations, published CIDs / IPNS |

Data access is server side: `@duckdb/node-api` opens one in memory instance per warm process
(cached on `globalThis`) with a view `properties` over `QUERY_TABLE_URL` (httpfs range reads when
it is a gateway URL; the local sample parquet when unset). The route runs on the Node runtime
(`runtime = "nodejs"`, `maxDuration = 60`), `@duckdb/node-api` is in `serverExternalPackages` so the
native binding is traced rather than bundled, and `public/sample/**` is traced into the function so
the sample fallback works on Vercel too.

The response is the `AgentResponse` contract in `lib/agent/types.ts` (re-exported from the route
for the original consumers): `answer`/`message` (markdown), `tool_calls`/`toolCalls` (name, input,
output_summary, elapsed_ms, row_count, total_matched, error), `evidence` (property_id, address,
the matched columns, source_system, source_url, fetched_at), `assumptions` (preset caveats plus
notes derived from the returned rows: proxy roof basis counts, NULL nearest_* counts, missing
sales, sample data), `data_freshness` (latest run_id and finished_at), `model`, `usage` (tokens,
cache read/write, steps). Transcript, evidence and assumptions come from the tool trace, not from
the model's prose, so they are faithful even when the answer is not.

The system prompt (`lib/agent/prompt.ts`) requires evidence with provenance for every cited row,
the rule and thresholds stated, a total match count, an explicit "Assumptions and missing data"
section, no invented rows, `preset_question` for the six standard questions and `run_sql` for
combinations, and a stated heuristic score for "strong candidates for further review".

### Environment

| Variable | Required | Notes |
|---|---|---|
| `ANTHROPIC_API_KEY` | yes, for the agent | Server only. Without it the route returns 501 and the page shows "agent not configured". |
| `AGENT_MODEL` | no | Default `claude-sonnet-4-5` (Anthropic) or `us.anthropic.claude-sonnet-4-5-20250929-v1:0` (Bedrock). |
| `AGENT_PROVIDER` | no | `anthropic` (default) or `bedrock`. Bedrock needs `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`/`AWS_REGION` or `AWS_BEARER_TOKEN_BEDROCK`. |
| `QUERY_TABLE_URL` | no | Server side parquet URL (IPNS root or direct object). Falls back to `NEXT_PUBLIC_QUERY_TABLE_URL`, then to `public/sample/query-table.parquet`. |
| `RUN_HISTORY_URL`, `OPEN_DATA_INDEX_URL` | no | Server side overrides; fall back to the `NEXT_PUBLIC_*` values, then to the sample files. |
| `AGENT_LOG` | no | `off` silences the JSON log lines. |

### Running it

```bash
cd ui
pnpm install
ANTHROPIC_API_KEY=sk-ant-... pnpm dev        # then open http://localhost:3000/agent
# or against the published data:
ANTHROPIC_API_KEY=sk-ant-... QUERY_TABLE_URL=https://ipfs.filebase.io/ipns/k51.../ pnpm dev

# from the command line
curl -s http://localhost:3000/api/agent          # 200 {"configured":true,...} or 501
curl -s -X POST http://localhost:3000/api/agent \
  -H 'content-type: application/json' \
  -d '{"messages":[{"role":"user","content":"Which properties have roofs older than 15 years and have not exchanged ownership in more than 10 years?"}]}'
```

On Vercel set the same variables in Project Settings (they are server side; no redeploy is needed
to change the key, one is needed for `NEXT_PUBLIC_*`). The `@duckdb/node-api` binding adds roughly
40 MB to the `/api/agent` function, well inside the 250 MB uncompressed limit, and nothing else on
the site depends on it.

### Tests

`tests/agent-tools.test.ts` runs every tool against the sample parquet through a real DuckDB:
`get_schema` lists every expected column with a meaning, `run_sql` rejects mutations, multi
statements and extension loads and enforces the row cap while reporting the total, every preset
returns evidence backed rows, `get_property` returns a full row and resolves the sample open data
JSON, and `get_run_history` records freshness. `tests/agent-loop.test.ts` runs the real
`ToolLoopAgent` with a `MockLanguageModelV3` from `ai/test` that answers with a tool call and then
text, asserting the tool actually executed, the JSON contract holds (transcript, evidence with
provenance, assumptions, freshness, usage, cache marker on the system prompt), that a rejected
mutation does not break the loop, and that the step cap stops a runaway loop. No test calls a real
model.
