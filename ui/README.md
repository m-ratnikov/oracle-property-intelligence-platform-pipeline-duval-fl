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
| `/agent` | Chat shell with a tool call transcript panel and an evidence panel, posting to `/api/agent`, showing which model is answering and on whose credential | `/api/agent` |
| `/settings` | Pick a model provider and model from the registry, paste your own API key, test it against a real provider call, and clear it. The key is stored in your browser only | `/api/agent`, `/api/agent/test` |
| `/mcp` | How to connect a client over streamable HTTP or stdio, the environment map we deploy the MCP server with, and a live check that resolves the artifact and verifies its parquet header | parquet (HEAD + 4 byte range), catalog.json |

## Environment variables

Every variable the explorer pages read is `NEXT_PUBLIC_*` and therefore public. That is deliberate:
all of them are public content addressed URLs, and the browser talks to the gateway directly with
no server in between.

`/api/agent` is the exception, and the only place this application can hold a secret. It runs on
the server and holds one model provider API key: `OPENROUTER_API_KEY`, set on Vercel and never in
this repository. It points at OpenRouter `:free` models, which cost $0.00 per token, so a visitor
who configures nothing gets a real answer and there is no budget for a stranger to drain. That is
the only reason a server side key is defensible on a public, unauthenticated route. Visitors can
still bring their own key on `/settings`, and theirs always wins. See the Agent section.

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
by range, and a static server that ignores `Range` returns the whole 47 MB body and then reads the
wrong bytes.

This is a rehearsal, not the deliverable. A reviewer cannot open localhost, and the assignment
scores a runtime it cannot reach as zero, so the hosted URLs still have to exist.

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

Applied: TypeScript everywhere and `strict` on, tests at both the unit and browser level,
structured honesty about data gaps, and no secret in the repository. The application does now have
a place a secret can live (the model key for `/api/agent`); the handling rules for it are in the
Agent section and enforced by `tests/agent-secrets.test.ts`.

Deviated, by requirement of the assignment:

- **No AWS and no CDK.** The assignment requires a public URL with no ongoing infrastructure cost.
  Vercel's free tier plus static hosting meets that; a CDK stack would not.
- **No structured logging or metrics backend.** There is no server to emit them from. The equivalent
  observability lives in the UI itself: the engine status line, the live MCP resolution check and the
  per column coverage panel all report real state rather than assumed state.
- **`/api/agent` returns 501 when no model is configured at all.** With no key on the request and
  none in the server environment, the route answers `501 {"status":"not_implemented","message":
  "agent not configured: choose a model and add your own API key on the settings page"}` and the
  chat UI renders that as an explicit state with a link to `/settings`. Returning a plausible
  sounding answer with no tool call behind it would be worse than returning nothing on a submission
  judged on evidence. The deployed instance does have a key, so a reviewer will not see this state;
  it is what happens to anyone who clones the repo without configuring anything.
- **A zero cost server default, plus bring your own key.** The kit standard is the Vercel AI SDK
  `ToolLoopAgent` on Amazon Bedrock with prompt caching. This deployment has no AWS account. It
  runs on OpenRouter `:free` open weight models instead, which cost $0.00 per token, because
  `/api/agent` is public and unauthenticated and a paid key there would be a budget any visitor
  could drain. Any of eight providers can be selected per request with a visitor's own key, and the
  Bedrock path (with the kit's cache point middleware) is one of them.
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

### Which model answers

The agent is provider agnostic. `lib/agent/providers.ts` is a registry, read by both the server and
the settings UI so the two can never disagree about what is supported:

| Provider | Free tier, read from the provider's own page on 2026-08-21 | Models here |
|---|---|---|
| OpenRouter | Yes, and the only genuinely $0.00 per token open weight option. `:free` variants cost nothing, capped at 50 requests/day, or 1,000/day once $10 of credits has ever been bought ([limits](https://openrouter.ai/docs/api-reference/limits)). Free models route only to providers that may train on the prompt, so prompt training must be enabled in account settings | `z-ai/glm-5.2:free`, `nvidia/nemotron-3-super-120b-a12b:free`, `openai/gpt-oss-20b:free`, `google/gemma-4-31b-it:free` |
| Google AI Studio | Yes, and no card. New accounts start on the free tier and Gemini Flash tokens are listed as free of charge ([pricing](https://ai.google.dev/gemini-api/docs/pricing), [billing](https://ai.google.dev/gemini-api/docs/billing)) | `gemini-3.7-flash`, `gemini-3.5-flash`, `gemini-2.5-flash`, `gemini-2.5-pro` |
| Groq | Yes on paper, no in practice. 30 req/min, 1,000 req/day, 8,000 tokens/min ([rate limits](https://console.groq.com/docs/rate-limits)), and one mid conversation request here is about 8,300 tokens, so the free tier cannot finish most answers. Fine on a paid tier | `openai/gpt-oss-120b`, `openai/gpt-oss-20b`, `qwen/qwen3.6-27b` |
| Cerebras | $5 of one time signup credit, not a recurring allowance ([pricing](https://www.cerebras.ai/pricing)) | `gpt-oss-120b`, `gemma-4-31b` |
| Hugging Face | $0.10 of routed inference credit a month, no card, refreshing ([pricing](https://huggingface.co/docs/inference-providers/pricing)). Nothing on the router is priced at zero, so the credit is the whole free tier: about 60 questions on gpt-oss-120b | `openai/gpt-oss-120b`, `deepseek-ai/DeepSeek-V4-Flash`, `Qwen/Qwen3-235B-A22B-Instruct-2507`, `Qwen/Qwen3-4B-Instruct-2507` |
| Vercel AI Gateway | $5 monthly credit per team, but only on a subset of the catalog ([pricing](https://vercel.com/docs/ai-gateway/pricing)). That subset holds exactly one tool calling chat model | `poolside/laguna-s-2.1-free` (free), `anthropic/claude-opus-5`, `google/gemini-3.7-flash` |
| Anthropic | No | `claude-opus-5` (the quality option), `claude-sonnet-5`, `claude-haiku-4-5-20251001` |
| Amazon Bedrock | No | `anthropic.claude-opus-5`, `anthropic.claude-sonnet-5` |

Those numbers move monthly. Each claim carries the source URL and the date it was read, in the
registry and on the settings page, so a stale one is visible rather than implied.

**What one answer actually costs.** `tests/agent-prompt-budget.test.ts` runs a real three step answer
against a real DuckDB with the model mocked and measures each request: about 1,900 tokens on step
one, 5,000 on step two, 8,300 on step three, roughly 15,200 cumulative. The system prompt and all
five tool schemas are resent every step and the tool results accumulate on top, which is why the
per minute ceilings matter more than the per day ones. That measurement is what disqualified the
Groq free tier, and the test fails if the prompt grows enough to invalidate the other claims.

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
answered in 82 s on `nvidia/nemotron-3-super-120b-a12b:free`: one `preset_question` call, 25
evidence rows out of 130,043 matched parcels, real FDOR provenance, `is_sample: false`. The same
question sent with `x-llm-model: openai/gpt-oss-20b:free` answered as that model instead, which is
the override working, and that smaller model called the tool and then produced no text, which is
the honest-failure path working and the reason it is not the default.

**Free pool contention is real.** Of six OpenRouter free models probed within one minute, four
answered and two returned "temporarily rate-limited upstream" from the shared pool, and which two
rotates. Every `:free` request is therefore sent with two alternates in OpenRouter's `models` array
(capped at three entries) so it reroutes by itself, and `AgentResponse.model` reports the model that
actually served the answer rather than the one that was asked for.

**The key handling rules**, enforced by `tests/agent-secrets.test.ts`:

- The key lives in the visitor's browser (`localStorage`), never in a cookie, never in a server side
  store, never in a database. There is no database in this application at all.
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

`POST /api/agent/test` makes one real, short provider call to validate a credential before a visitor
spends a 90 second question finding out it is wrong. It also reports whether the model actually
emitted a tool call, because a model that authenticates but will not call tools is useless to a five
tool agent, and the settings page shows those two results separately.

### Environment

| Variable | Required | Notes |
|---|---|---|
| provider key | no | One of `OPENROUTER_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY`, `GROQ_API_KEY`, `CEREBRAS_API_KEY`, `HF_TOKEN`, `AI_GATEWAY_API_KEY`, `ANTHROPIC_API_KEY`, `AWS_BEARER_TOKEN_BEDROCK`. **This deployment sets `OPENROUTER_API_KEY`** and nothing else, pointed at $0.00 per token models. |
| `AGENT_PROVIDER` | no | One of the registry ids. When unset, the first provider with a key present wins. Naming a provider with no key reports "not configured" rather than falling through to another provider's key. |
| `AGENT_MODEL` | no | Must be a model the registry lists for that provider. An id belonging to another provider is ignored and the provider's default free model is used. |
| `QUERY_TABLE_URL` | no | Server side parquet URL (IPNS root or direct object). Falls back to `NEXT_PUBLIC_QUERY_TABLE_URL`, then to `public/sample/query-table.parquet`. |
| `RUN_HISTORY_URL`, `OPEN_DATA_INDEX_URL` | no | Server side overrides; fall back to the `NEXT_PUBLIC_*` values, then to the sample files. |
| `AGENT_RATE_LIMIT`, `AGENT_RATE_WINDOW_MS` | no | Default 15 questions per 10 minutes per address. |
| `AGENT_TEST_RATE_LIMIT`, `AGENT_TEST_RATE_WINDOW_MS` | no | Default 10 credential tests per minute per address. |
| `AGENT_LOG` | no | `off` silences the JSON log lines. |

### Running it

```bash
cd ui
pnpm install
pnpm dev                 # open http://localhost:3000/settings, paste a key, then /agent

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
