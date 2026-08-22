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
  Vercel  ---- static HTML/JS/CSS + duckdb-eh.wasm --/     (server routes: /api/agent, /api/agent/test)
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
| `/agent` | Chat shell with a tool call transcript panel and an evidence panel, posting to `/api/agent`, showing which model is answering and on whose credential | `/api/agent` |
| `/mcp` | How to connect a client over streamable HTTP or stdio, the environment map we deploy the MCP server with, and a live check that resolves the artifact and verifies its parquet header | parquet (HEAD + 4 byte range), catalog.json |

## Environment variables

Every variable the explorer pages read is `NEXT_PUBLIC_*` and therefore public. That is deliberate:
all of them are public content addressed URLs, and the browser talks to the gateway directly with
no server in between.

`/api/agent` is the exception, and the only place this application can hold a secret. It runs on
the server and holds one model provider API key, set on Vercel and never in this repository, so a
visitor who configures nothing still gets a real answer.

**The deployed default is OpenAI `gpt-4.1-mini` on `OPENAI_API_KEY`**, and `GET /api/agent` on the
live URL reports exactly that, without echoing the key. An earlier revision defaulted to OpenRouter
`:free` models on the argument that $0.00 per token means no budget a stranger can drain. That was
the better argument and the worse demo: the free pool returned 429 or timed out mid answer often
enough to make the runtime look broken, which is the one thing a hosted demo cannot afford. The
route is therefore metered rather than free, and the exposure is bounded by the three ceilings in
the environment table below plus the three-model allow-list `GET /api/agent` reports
(`gpt-5-mini`, `gpt-5`, `gpt-4.1-mini`), not by the model being priced at zero. That trade is
stated here rather than left for a reader to discover from a bill.

**There is no `/settings` page, and no key-entry UI of any kind.** An earlier revision had one and
it was removed once the deployment carried a working server default: a reviewer needs no credential,
so a page whose only job was collecting one was dead weight, and the model picker that was worth
keeping moved onto the Agent page as a dropdown. Bringing your own key still
works, but only at the API level, by sending `x-llm-api-key` / `x-llm-provider` / `x-llm-model` on
the request; a caller's credential still beats the server default. The curl examples in the Agent
section below are the supported way to do it. See the Agent section.

| Variable | Required | Falls back to |
|---|---|---|
| `NEXT_PUBLIC_QUERY_TABLE_URL` | yes | `/sample/query-table.parquet` |
| `NEXT_PUBLIC_RUN_HISTORY_URL` | yes | `/sample/run-history.json` |
| `NEXT_PUBLIC_COVERAGE_URL` | yes | `/sample/dataset-coverage.json` |
| `NEXT_PUBLIC_CATALOG_URL` | yes | `/sample/catalog.json` |
| `NEXT_PUBLIC_OPEN_DATA_INDEX_URL` | no | `/sample/open-data/index.json` |
| `NEXT_PUBLIC_ARTIFACTS_INDEX_URL` | no | the artifact cards on `/` and `/runs` say "not available" for the gateway URL and the IPNS name. Deliberately NOT one of the four that flip the runtime to SAMPLE, so leaving it unset does not brand a real deployment synthetic. Use the IPNS name (`duval-oracle-artifacts`) |
| `NEXT_PUBLIC_IPFS_GATEWAY` | no | `https://ipfs.filebase.io`. Read by `lib/openData.ts` and `lib/types.ts` to turn a bare CID from the open data index into a fetchable URL |
| `NEXT_PUBLIC_MCP_URL` | no | placeholder snippets on `/mcp` |
| `NEXT_PUBLIC_COUNTY_KEY` / `_COUNTY_NAME` / `_STATE_CODE` | no | `duval` / `Duval` / `FL` |

Only the first four decide SAMPLE mode. The rest degrade a panel and say so.

Two more variables belong to `scripts/serve-artifacts.mjs`, the local rehearsal server, and are
never read by the application: `PUBLISH_DIR` (default `../../data/artifacts/publish/duval`, the
directory it serves, also `--dir`) and `ARTIFACT_PORT` (default `8787`, also `--port`).

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

### Running locally against the real artifacts

`pnpm dev` on its own shows the 480 row synthetic sample and labels itself SAMPLE. To drive the
full county dataset before anything is published, serve the pipeline's publish directory and point
the app at it:

```bash
node scripts/serve-artifacts.mjs            # serves ../../data/artifacts/publish/duval on :8787
cp .env.example .env.local                  # then replace the gateway URLs with http://localhost:8787/...
pnpm build && pnpm start                    # NEXT_PUBLIC_* are baked at build time, so rebuild after edits
node scripts/local-smoke.mjs                # drives the six questions and prints what the page shows
```

`serve-artifacts.mjs` answers HTTP `Range` (including the `bytes=-N` suffix form a parquet footer
read uses) and exposes the range headers cross origin. Both matter: DuckDB-WASM fetches row groups
by range, and a static server that ignores `Range` returns the whole 50 MB body and then reads the
wrong bytes.

This is a rehearsal, not the deliverable. A reviewer cannot open localhost, and the assignment
scores a runtime it cannot reach as zero, so the hosted URLs still have to exist.

## Sample data

`pnpm sample` writes `public/sample` from a fixed seed, so it is reproducible:

- `query-table.parquet`, 480 parcels, 133 columns: the same schema as the published artifact (37
  canonical Elephant query table columns plus 96 Duval extras), written through DuckDB with real
  column types and ZSTD compression
- `run-history.json`, four runs across 13 sources with deltas and documented limitations
- `dataset-coverage.json`, ingested against expected for all 13 sources
- `catalog.json`, a published counties catalog entry
- `open-data/`, an index, two shards and 40 per property consolidated records

Every file carries a `note` field saying it is synthetic, and the shapes match the published
contract exactly, so switching to real URLs changes nothing but the data.

## Tests

```bash
pnpm lint       # tsc --noEmit. NOT a linter: see the deviation note below
pnpm test       # vitest: unit + DuckDB integration
pnpm test:e2e   # playwright: browser smoke against a production build
```

The other scripts in `package.json`: `pnpm assets` (copy the DuckDB-WASM runtime into
`public/duckdb`, chained by `dev` and `build`), `pnpm sample` (regenerate `public/sample`),
`pnpm dev`, `pnpm build`, `pnpm start`, `pnpm test:watch`.

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

Cost model: eight pages, seven of them prerendered static. The serverless functions are
`/api/agent` and `/api/agent/test` (reached only from the agent page or by curl) and
`/property/[id]`, which renders an empty client shell. Link prefetching is disabled on property links so a result grid does not fire an invocation
per visible row. Static assets, including the 34 MB wasm module, are served from the CDN and cached
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
deliberately not shipped: it is another 39 MB of static assets for browsers that predate wasm
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

Applied: TypeScript everywhere and `strict` on, tests at both the unit and browser level,
structured honesty about data gaps, and no secret in the repository. The application does now have
a place a secret can live (the model key for `/api/agent`); the handling rules for it are in the
Agent section and enforced by `tests/agent-secrets.test.ts`.

Deviated, by requirement of the assignment:

- **No AWS and no CDK.** The assignment requires a public URL with no ongoing infrastructure cost.
  Vercel's free tier plus static hosting meets that; a CDK stack would not.
- **No ESLint in `ui/`.** The `pnpm lint` script here runs `tsc --noEmit`, which is a type check
  and not a lint: no rule about unused variables, floating promises, `no-console` or `eqeqeq` runs
  over this package. `pipeline/` does have a flat ESLint config wired to its own `pnpm lint`, so
  linting is applied unevenly across the repository. This is stated rather than hidden because
  `apply-engineering-guidelines` asks for a linter and only half the repository has one. (In
  `pipeline/eslint.config.js` one rule, `no-useless-assignment`, is switched off deliberately, with
  the reason written on the rule; that is a considered exception, unlike this one.)
- **No structured logging or metrics backend.** There is no server to emit them from. The equivalent
  observability lives in the UI itself: the engine status line, the live MCP resolution check and the
  per column coverage panel all report real state rather than assumed state.
- **`/api/agent` returns 501 when no model is configured at all.** With no key on the request and
  none in the server environment, the route answers `501 {"status":"not_implemented", ...}` and the
  chat UI renders that as an explicit state. Returning a plausible
  sounding answer with no tool call behind it would be worse than returning nothing on a submission
  judged on evidence. The deployed instance does have a key, so a reviewer will not see this state;
  it is what happens to anyone who clones the repo without configuring anything. Known rough edge:
  a few operator-facing strings under `lib/agent/` and `app/api/agent/` still tell the caller to
  paste a key "on the settings page". They are stale text on a page that was removed, not a code
  path: the header route works exactly as documented here.
- **A metered server default, plus bring your own key.** The standard pattern is the Vercel AI SDK
  `ToolLoopAgent` on Amazon Bedrock with prompt caching. This deployment has no AWS account. It runs
  on OpenAI `gpt-4.1-mini` instead. The zero-cost option (OpenRouter `:free`) was the default first
  and was measured failing under free-pool contention, so reliability won over price; the cost is
  contained by the rate limiter and a three-model allow-list rather than by the token price. Any of
  nine registered providers can be selected per request with a caller's own key, and the Bedrock
  path (with a cache point middleware) is one of them.
  The usual managed-chat furniture (a ticketing-system ingress, a chat-state table, a hosted
  conversation memory, a hosted trace backend) is not applicable to a single page chat on Vercel;
  the equivalent here is the in page transcript plus one JSON log line per tool call and per turn on
  the server.

## Agent

`/agent` is a chat over the same dataset. Each turn is one Vercel AI SDK `ToolLoopAgent` run
(`lib/agent/run.ts`) with six explicitly registered, read only tools (`lib/agent/tools.ts`), each
with a zod input schema:

| Tool | What it does |
|---|---|
| `get_schema` | `DESCRIBE properties` plus a one line meaning per column and the eight question rules in plain English |
| `preset_question` | Runs one of the eight presets from `lib/sql.ts` by name (`roof_over_15`, `water_view`, `no_sale_10y`, `regional_owner`, `near_transit`, `near_starbucks`, `roof15_and_no_sale10y`, `transit_and_regional`), returns rows with evidence and provenance columns, the rule, the total match count and the preset's caveats |
| `run_sql` | One `SELECT`/`WITH` over `properties`, guarded by the same `guardSql` the workbench uses, capped at 200 rows, with `total_matched` when the cap cut rows off |
| `get_property` | Full row for one folio plus the per property open data JSON from IPFS when published |
| `count_criteria` | Takes 2 to 6 labelled boolean conditions over `properties` and returns `all_criteria` (parcels meeting every one, the number to report as the total), `any_criteria`, per criterion counts, a 4-of-4 / 3-of-4 breakdown, the SQL behind each number, and the top ranked rows. This exists because a scored or OR query has no single "total matched", and reporting its row count as one is off by orders of magnitude |
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

### Which model answers

The agent is provider agnostic. `lib/agent/providers.ts` is the single registry the server reads,
so the supported set, the free-tier claims and the credential validation can never disagree with
each other:

The nine registered providers, their model lists and their free-tier verdicts are below. This table
is transcribed from what `GET https://duval-oracle-ui.vercel.app/api/agent` returns, so it can be
checked against the running deployment rather than against this file.

| Provider | Free tier, read from the provider's own page on 2026-08-21 | Models here |
|---|---|---|
| **OpenAI (the server default)** | No. Billed per token against prepaid credit, which is exactly why it is the default: the free providers below were measured returning 429 or timing out mid demo ([pricing](https://platform.openai.com/docs/pricing)). Model ids were read from this account's own `/v1/models`, not assumed | `gpt-5-mini`, `gpt-5`, `gpt-4.1-mini` (the deployed default) |
| OpenRouter | Yes, and the only genuinely $0.00 per token open weight option. `:free` variants cost nothing, capped at 50 requests/day, or 1,000/day once $10 of credits has ever been bought ([limits](https://openrouter.ai/docs/api-reference/limits)). Free models route only to providers that may train on the prompt, so prompt training must be enabled in account settings | `nvidia/nemotron-3-super-120b-a12b:free`, `nvidia/nemotron-3.5-lightning:free`, `openai/gpt-oss-20b:free`, `nvidia/nemotron-3-ultra-550b-a55b:free`, `z-ai/glm-5.2:free`, `google/gemma-4-31b-it:free` |
| Google AI Studio | Yes, and no card. New accounts start on the free tier and Gemini Flash tokens are listed as free of charge ([pricing](https://ai.google.dev/gemini-api/docs/pricing), [billing](https://ai.google.dev/gemini-api/docs/billing)) | `gemini-3.5-flash`, `gemini-3.6-flash`, `gemini-3.7-flash`, `gemini-2.5-pro` |
| Groq | Yes on paper, no in practice. 30 req/min, 1,000 req/day, 8,000 tokens/min ([rate limits](https://console.groq.com/docs/rate-limits)), and one mid conversation request here is about 8,300 tokens, so the free tier cannot finish most answers. Fine on a paid tier | `openai/gpt-oss-120b`, `openai/gpt-oss-20b`, `qwen/qwen3.6-27b` |
| Cerebras | $5 of one time signup credit, not a recurring allowance ([pricing](https://www.cerebras.ai/pricing)) | `gpt-oss-120b`, `gemma-4-31b` |
| Hugging Face | $0.10 of routed inference credit a month, no card, refreshing ([pricing](https://huggingface.co/docs/inference-providers/pricing)). Nothing on the router is priced at zero, so the credit is the whole free tier: about 60 questions on gpt-oss-120b | `openai/gpt-oss-120b`, `deepseek-ai/DeepSeek-V4-Flash`, `Qwen/Qwen3-235B-A22B-Instruct-2507`, `Qwen/Qwen3-4B-Instruct-2507` |
| Vercel AI Gateway | $5 monthly credit per team, but only on a subset of the catalog ([pricing](https://vercel.com/docs/ai-gateway/pricing)). That subset holds exactly one tool calling chat model | `poolside/laguna-s-2.1-free` (free), `anthropic/claude-opus-5`, `google/gemini-3.7-flash` |
| Anthropic | No | `claude-opus-5` (the quality option), `claude-sonnet-5`, `claude-haiku-4-5-20251001` |
| Amazon Bedrock | No | `anthropic.claude-opus-5`, `anthropic.claude-sonnet-5` |

Those numbers move monthly. Each claim carries the source URL and the date it was read, in the
registry itself, so a stale one is visible rather than implied. `tests/agent-providers.test.ts`
fails if any free-tier claim loses its source URL or its read date.

**What one answer actually costs.** `tests/agent-prompt-budget.test.ts` runs a real multi step
answer against a real DuckDB with the model mocked and measures the tokens in each request rather
than estimating them. It asserts three things, and they are the durable claims: every step is
strictly larger than the one before it (the system prompt and all tool schemas are resent each
step and the tool results accumulate on top), the largest single request exceeds Groq's free tier
ceiling of 8,000 tokens per minute, and it stays below 15,000. The middle assertion is the evidence
behind the Groq row in the registry: its free tier cannot finish most questions here. The ceiling
was raised from 12,000 to 15,000 when the sample parquet widened from 88 columns to the 131 the
pipeline actually publishes, which is the schema growing, not the agent. The test fails if the
prompt grows enough to invalidate any of it, which is the point of writing the budget down as an
assertion instead of as a sentence.

OpenRouter and Hugging Face are reached through `@ai-sdk/openai-compatible` against
`https://router.huggingface.co/v1`, not through the official `@ai-sdk/huggingface` package. That
package is responses-API only, while the tool support this agent depends on is what the router
publishes per model at `https://router.huggingface.co/v1/models` as `supports_tools`, which
describes chat completions, and every Hugging Face tool calling example posts there. The four model
ids above were taken from that endpoint, filtered to `status: live` and `supports_tools: true`, with
their published per token prices. Switching to the official provider is one line once its per
provider tool coverage on this router is documented.

Resolution order per request: the caller's own credential first, then the server environment, then
501. A visitor who brings a key always gets their model, never the deployment's.

**Measured on the deployed URL, 2026-08-21.** With nothing configured, the roof-and-tenure question
answered in 82 s on `nvidia/nemotron-3-super-120b-a12b:free`, which was the server default at the
time: one `preset_question` call, 25 evidence rows, real FDOR provenance, `is_sample: false`. The
same question sent with `x-llm-model: openai/gpt-oss-20b:free` answered as that model instead, which
is the override working, and that smaller model called the tool and then produced no text, which is
the honest-failure path working. That failure mode, repeated across the free pool, is what moved
the default to OpenAI. The preset's own total against the artifact published at 2026-08-21T23:46Z is
130,045 parcels (`roof_age_years >= 15 AND no_sale_10y_flag`); it moves as the pipeline republishes,
which is exactly why the answer reports it from the query rather than from this page.

**Free pool contention is real.** Of six OpenRouter free models probed within one minute, four
answered and two returned "temporarily rate-limited upstream" from the shared pool, and which two
rotates. Every `:free` request is therefore sent with two alternates in OpenRouter's `models` array
(capped at three entries) so it reroutes by itself, and `AgentResponse.model` reports the model that
actually served the answer rather than the one that was asked for.

**The key handling rules**, enforced by `tests/agent-secrets.test.ts`:

- A caller's key is never stored by this application: not in a cookie, not in a server side store,
  not in a database. There is no database in this application at all, and with the settings page
  gone there is no `localStorage` copy either.
- It travels per request in the `x-llm-api-key` header over HTTPS, is used to build one provider
  client for that request, and is discarded.
- It is never logged. Every message on the request path goes through `lib/agent/redact.ts` first,
  which strips both the literal key and anything shaped like a vendor key, because several providers
  quote the offending credential in the body of a 401. The key itself is logged only as a non
  reversible fingerprint. A static test reads every logger call under `lib/agent` and `app/api` and
  fails if a credential is passed to one.
- It is never returned in any response, including `GET /api/agent`, which reports whether a key is
  set and the NAME of the environment variable that supplies it, never a value.
- A bad key produces a typed `AgentCredentialError` and a `401` with a readable message, not a `500`
  and not a stack trace.
- `/api/agent` is rate limited per client address whoever supplies the key, because the cost being
  protected is compute on a 300 second function as well as tokens. The limiter is in process and
  therefore per instance; `lib/agent/ratelimit.ts` states that limitation rather than implying
  protection it does not deliver.

`POST /api/agent/test` makes one real, short provider call to validate a credential before a caller
spends a 90 second question finding out it is wrong. It reports authentication and tool-calling as
two separate results, because a model that authenticates but will not call tools is useless to a
six tool agent. With the settings page gone this route is reached by curl, not by the UI.

### Environment

| Variable | Required | Notes |
|---|---|---|
| provider key | no | One of `OPENROUTER_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY` (alias `GOOGLE_API_KEY`), `GROQ_API_KEY`, `CEREBRAS_API_KEY`, `HF_TOKEN` (alias `HUGGINGFACE_API_KEY`), `AI_GATEWAY_API_KEY`, `ANTHROPIC_API_KEY`, `AWS_BEARER_TOKEN_BEDROCK` (or `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY` + `AWS_REGION` for SigV4). `lib/agent/providers.ts` is the source of truth for this list. `OPENAI_API_KEY` is registered too and is what this deployment actually sets; `lib/agent/providers.ts` is the source of truth for the whole list. |
| `AGENT_PROVIDER` | no | One of the registry ids. When unset, the first provider with a key present wins. Naming a provider with no key reports "not configured" rather than falling through to another provider's key. |
| `AGENT_MODEL` | no | Must be a model the registry lists for that provider. An id belonging to another provider is ignored and the provider's default free model is used. |
| `AGENT_MODEL_CHOICES` | no | Comma separated model ids. Narrows what a caller may select to a subset of what the configured provider lists. Unset means the whole registry entry is selectable. |
| `QUERY_TABLE_URL` | no | Server side parquet URL (IPNS root or direct object). Falls back to `NEXT_PUBLIC_QUERY_TABLE_URL`, then to `public/sample/query-table.parquet`. |
| `RUN_HISTORY_URL`, `OPEN_DATA_INDEX_URL` | no | Server side overrides; fall back to the `NEXT_PUBLIC_*` values, then to the sample files. |
| `AGENT_RATE_LIMIT`, `AGENT_RATE_WINDOW_MS` | no | Ceiling 1, per address. Default 15 questions per 10 minutes. |
| `AGENT_TEST_RATE_LIMIT`, `AGENT_TEST_RATE_WINDOW_MS` | no | Default 10 credential tests per minute per address. |
| `AGENT_GLOBAL_LIMIT`, `AGENT_GLOBAL_WINDOW_MS` | no | Ceiling 2, one budget shared by every caller who does not bring a key, so the cost stops scaling with the number of addresses an attacker can rent. Default 200 per 24 h, clamped to 100 when the server credential is billed and `AGENT_SPEND_CEILING_USD` is unset. |
| `AGENT_ASSUMED_INSTANCES` | no | Warm instances the global ceiling is divided across, default 4. A working assumption about the platform, not a guarantee it makes. |
| `AGENT_MAX_STEPS`, `AGENT_MAX_TRANSCRIPT_CHARS` | no | Ceiling 3, per request: 8 tool loop steps (hard max 12) and 24,000 characters of history. An env value may only tighten these; one above the code maximum is ignored. |
| `AGENT_SPEND_CEILING_USD` | no | The hard cap set on the key **at the provider**, recorded here. Nothing in this codebase can set or verify it, so `GET /api/agent` reports it as a declaration. Leaving it unset while the server credential is billed is what clamps the global ceiling to 100 a day. |
| `AGENT_LOG` | no | `off` silences the JSON log lines. |
| `PLAYWRIGHT_BASE_URL`, `PLAYWRIGHT_PORT` | no | Test harness only. `PLAYWRIGHT_BASE_URL` points the smoke suite at an already running server, a deployed URL included, in which case Playwright starts nothing itself. |

`.env.example` is the single inventory of every variable this repository reads, and
`tests/env-documented.test.ts` fails the build if a variable is read in `app/`, `lib/` or
`scripts/` without appearing there. That test exists because `.env.example` is the only place a
secret's existence is recorded (the values live on Vercel), so an undocumented variable is one that
gets set by whoever remembers it and reviewed by nobody.

### Running it

```bash
cd ui
pnpm install
pnpm dev                 # http://localhost:3000/agent (answers from public/sample with no key)

# or with a server side default, which no deployed instance of this app uses:
GOOGLE_GENERATIVE_AI_API_KEY=AIza... pnpm dev
GOOGLE_GENERATIVE_AI_API_KEY=AIza... QUERY_TABLE_URL=https://ipfs.filebase.io/ipns/k51.../ pnpm dev

# what would answer, and everything supported. Never a key.
curl -s http://localhost:3000/api/agent

# what would answer for a caller carrying their own credential
curl -s http://localhost:3000/api/agent \
  -H 'x-llm-provider: google' -H 'x-llm-model: gemini-3.7-flash' -H "x-llm-api-key: $GOOGLE_KEY"

# does this key work, and will this model call tools
curl -s -X POST http://localhost:3000/api/agent/test \
  -H 'x-llm-provider: google' -H 'x-llm-model: gemini-3.7-flash' -H "x-llm-api-key: $GOOGLE_KEY"

# ask a question with your own key
curl -s -X POST http://localhost:3000/api/agent \
  -H 'content-type: application/json' \
  -H 'x-llm-provider: google' -H 'x-llm-model: gemini-3.7-flash' -H "x-llm-api-key: $GOOGLE_KEY" \
  -d '{"messages":[{"role":"user","content":"Which properties have roofs older than 15 years and have not exchanged ownership in more than 10 years?"}]}'

# with no key anywhere: 501, and it says where to go
curl -s -X POST http://localhost:3000/api/agent \
  -H 'content-type: application/json' -d '{"messages":[{"role":"user","content":"hello"}]}'
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
mutation does not break the loop, and that the step cap stops a runaway loop.

`tests/agent-providers.test.ts` covers the registry and the credential path: ids and model ids are
unique, every free tier claim carries a source URL and a read date, no model is marked free under a
provider with no free tier, a client can be built for every registry provider (so a registry entry
can never lack a client branch), the header parser rejects an unknown provider, an unlisted model,
a key shaped wrong and provider headers arriving without a key, and a visitor's credential beats a
configured server default.

`tests/agent-secrets.test.ts` is the one that matters most, because the app is public. It proves a
provider error quoting the key comes back redacted as a typed 401 rather than a 500, that a genuine
outage is not misread as a bad key, that running the failure path with the console captured writes
no key material anywhere, that `GET /api/agent` never echoes a credential, and, statically, that no
logger call under `lib/agent` or `app/api` is handed a credential.

No test calls a real model or a real provider.
