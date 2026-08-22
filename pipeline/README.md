# Duval County (FL) Oracle pipeline

Continuous, incremental ingestion of Duval County public property data into a DuckDB analytical
store, with the Elephant-convention artifacts (query-table parquet, dataset coverage, run history,
entity tables, published-counties catalog) published to IPFS through Filebase and addressed by
stable IPNS names. Self-contained: no Neon, no Restate, no AWS. County key `duval`, FIPS `12031`,
`source_system = duval_appraiser`.

```
GitHub Actions (cron every 6 h + dispatch)      Filebase S3 -> IPFS pins + IPNS (/v1/names)
  pnpm run pipeline -- --tracks ...              oracle-query-table-duval       query-table.parquet
    download (ETag / Last-Modified / sha256)      oracle-dataset-coverage-duval  dataset-coverage.json
    stage -> hash -> MERGE (ins/upd/unchanged)    oracle-run-history-duval       run-history.json
    features -> parquet -> validation gate        oracle-published-counties      published-counties.json
    run_log + runs/<run_id>.json                  duval-oracle-artifacts         artifacts-index.json
  DuckDB file: DATA_DIR/duval.duckdb              (ten tables/*.parquet keep CIDs, no name)
```

## Run it

```bash
cd pipeline
pnpm install
cp .env.example .env          # optional; everything has defaults, Filebase keys empty = dry-run

pnpm run pipeline -- --tracks default --window 14d     # what the schedule runs: all 13 tracks; US-only ones self-skip outside the US
pnpm run pipeline -- --tracks local                    # the 8 tracks reachable from anywhere
pnpm run pipeline -- --tracks transit,water,places,businesses,links --window 14d
pnpm run pipeline -- --tracks permits --window 300     # bounded permit enumeration (US egress)
pnpm run features                                      # rebuild derived.properties_features + parquet + gate
pnpm run validate                                      # re-run the query-table gate
pnpm run publish:ipfs                                  # DRY RUN: lists objects, keys, local CIDs, IPNS labels
pnpm run publish:ipfs -- --publish                     # real upload + IPNS re-point (needs FILEBASE_* env)
pnpm run export:consolidation -- --since changed --shard-size 10000   # open-data per-property JSON + shards + index + manifest (incremental)
pnpm run export:consolidation -- --since all --limit 20000            # full rebuild / bounded pilot
pnpm run publish:open-data                             # DRY RUN: object counts + bytes for the oracle-open-data-duval publish
pnpm run publish:open-data -- --publish                # upload <cid>.json files (64-way, 429 backoff, checkpoint), shards, index; IPNS last; verify
pnpm run pipeline -- --tracks pa_detail --window 300   # PA detail pilot (US egress): seed order, cursor, lexicon transform
pnpm run status                                        # table counts + run history
pnpm run query -- "SELECT owner_region_class, count(*) FROM derived.properties_features GROUP BY 1"
pnpm typecheck                                         # tsc --noEmit
pnpm lint                                              # eslint . (pnpm lint:fix to autofix)
pnpm format:check                                      # prettier --check (pnpm format to rewrite)
pnpm test                                              # vitest: 33 files / 217 tests
```

Flags for `pipeline`: `--tracks a,b|all|default|local`, `--window <w>` (Sunbiz days like `14d`, permit
count like `300`; recorded on every run), `--trigger <name>`, `--force` (re-download even when
unchanged), `--no-features`.

### Open-data consolidation (Elephant `county-open-data-publish` convention)

`export:consolidation` renders one JSON per property from DuckDB (`properties/<property_id>.json`): `address`,
`property`, `structure` (+ PA buildings when fetched), `valuation`, `owners`, `sales[]`, `permits[]`, `businesses[]`
(linked Sunbiz), `features` (the six-question columns with their basis), `provenance` (parcel + geometry rows:
source_system, source_url, source_artifact, source_sha256, fetched_at, run_id) and `lexicon` (the vendored
Elephant transform output when the PA detail page was fetched). Run timestamps and as-of dependent ages are
deliberately left out so an unchanged property keeps its CID across runs. `consolidation_state` (property_id ->
content hash, cid, bytes, file path) makes the export incremental: `--since changed` re-renders only new/changed
records (`--since <run_id>` narrows to rows loaded by that run or later, `--since all` rebuilds). `shards/shard-NNNN.json`
(`{schemaVersion "1", shardIndex, fromParcel, toParcel, count, entries[{propertyId, parcelIdentifier, cid,
fileSizeBytes, address, zip, lat, lon}]}`), `index.json` (`{schemaVersion "1", county, exportedAt, completedAt,
generatedAt, runId, propertyCount, shardSize, totalBytes, shards[]}`) and the flat `manifest.json` are rebuilt from the
state every time; counts land in `run_log` / `run-history.json` (track `consolidation`). The query table then gets
`property_cid` from the state (validator reports filled == rows).

`publish:open-data` (dry-run by default) uploads each property under its CID name (`open-data/duval/<cid>.json`,
concurrency 64, 429/5xx backoff), then shards, manifest and index, re-points IPNS `oracle-open-data-duval` at the
index.json CID LAST, reads it back through the gateway (`x-ipfs-roots` + propertyCount) and keeps a per-bucket
checkpoint keyed by CID so reruns skip content already pinned. MCP: `ORACLE_OPEN_DATA_IPNS_MAP={"duval":"<k51>"}`
(printed by both publish commands once the name exists).

Measured on the latest consolidation run, `01M0KBA53DPMHRGXV66NQ0GRY5`: the full 404,023-property export
rendered in 196 s into 41 shards totalling 1,969,492,488 bytes on disk (about 4.9 KB per property,
pretty-printed like the reference export). Incremental `--since changed` passes that re-render only what
moved finish in 16 to 21 s. Every consolidation run record in `runs/*.json` carries its own
`shards` / `totalBytes` / `ms`, so these are readable per run rather than taken from here.

### PA detail pilot (W4, US egress)

`tracks/pa_detail.ts` walks `DATA_DIR/seed/Duval.csv` in seed order from a persistent cursor (`track_state`
seed_cursor), `--window`/`PA_DETAIL_WINDOW` parcels per run (default 300), concurrency 2, 400 ms delay, browser UA,
saves the raw page to `DATA_DIR/artifacts/pa_detail/html/<re>.html` (skip existing), parses with cheerio
(`pa_detail_parse.ts`: per-building Actual Year Built, Building Type, Roof Struct, Roofing Cover, Exterior Wall,
gross/heated/effective area; Sales History book/page + clerk link, date, price, deed instrument, qualified,
vacant/improved; owner + mailing lines), merges into `pa_detail_buildings` / `pa_detail_sales`, folds PA sales into
`sales_history` (`sale_source PA_DETAIL`, `source_system duval_pa_detail`) so tenure uses them, and runs the vendored
Elephant transform (`vendor/duval-transform`, see NOTICE) per page: the four mapping scripts write `owners/*.json`,
`data_extractor.js` writes `data/*.json` (property, address, sales_history_N, deed_N, file_N, structure_1, utility_1,
layout_N, person_N, relationships); outputs land in `DATA_DIR/artifacts/pa_detail/lexicon/<re>/` and ride into the
consolidation record as `lexicon`. Features: `roof_covering_material`, `exterior_wall_material`, `total_area`,
`roof_structure`, `pa_actual_year_built`, `pa_building_count` fill from PA when present. Throughput, misses, errors and
the cursor are recorded in `run_log_sources` (the "slow source" evidence). The seed zip is copied from the local
workspace; in Actions it is downloaded from Google Drive (`drive.usercontent.google.com/download?id=...`).

### Environment

| Variable | Default | Purpose |
|---|---|---|
| `DATA_DIR` | `../data` (relative to the repo root, i.e. outside the checkout) | DuckDB file, `artifacts/<track>/` downloads (+ `.meta.json` sidecars), `artifacts/publish/duval/` outputs |
| `FILEBASE_ACCESS_KEY`, `FILEBASE_SECRET_KEY` | empty | Filebase S3 keys; also form the Names API token `base64(key:secret)` |
| `FILEBASE_BUCKET_DUVAL` | empty | The bucket that holds every Duval object |
| `FILEBASE_S3_ENDPOINT` | `https://s3.filebase.com` | S3 endpoint (the reference Elephant uploaders assert this host) |
| `FILEBASE_GATEWAY` | `https://ipfs.filebase.io` | Gateway used in published URLs |
| `SOURCE_URL_NAL`, `SOURCE_URL_SDF`, `SOURCE_URL_PAR`, `SOURCE_URL_GTFS`, `SOURCE_URL_OVERTURE` | current FDOR 2026P / JTA / Overture 2026-08-19.0 | Override when a source rolls the year / release |
| `SUNBIZ_HOST`, `SUNBIZ_USER`, `SUNBIZ_PASSWORD` | the public Sunbiz credentials (published by the FL Division of Corporations) | SFTP access |
| `SUNBIZ_WINDOW_DAYS`, `SUNBIZ_MAX_FILES_PER_RUN` | 14, 30 | Daily files considered / fetched per run |
| `SUNBIZ_BASE_SNAPSHOT` | unset (which means: off locally, on when `CI=true`) | `1`/`true`/`yes`/`on` loads the 1.8 GB Sunbiz quarterly base snapshot. This is the variable that turns `businesses` from a few thousand delta rows into the full 438,526-row Duval set, so a local run that leaves it unset will not reproduce the published business counts |
| `SUNBIZ_BASE_MAX_ENTRIES` | 10 | Members of `cordata.zip` loaded per run. The archive has exactly 10, so the default loads it in one run; lower it to spread the load |
| `SUNBIZ_KEEP_QUARTERLY_ZIP` | unset | `1` keeps the downloaded 1.8 GB quarterly zip instead of deleting it after extraction |
| `PERMITS_WINDOW`, `PERMITS_YEAR`, `PERMITS_PREFIX`, `PERMITS_START_SEQ` | 300, current YY, B, 1 | JaxEPICS enumeration window and cursor start |
| `PERMITS_KNOWN` | `B-25-279425.000` | The one real permit number the JaxEPICS discovery step fetches to find the Angular bundle and probe the API. Change it if that permit is ever withdrawn |
| `PA_DETAIL_WINDOW` | 300 | PA detail pages per run (also `--window 300`) |
| `ALLOW_NEW_COLUMNS` | unset | `1` downgrades an unexpected new column in a source header from a run failure to a recorded limitation |
| `LOG_LEVEL` | `info` | Minimum level for the structured JSON logs (`src/log.ts`) |
| `COJ_MAX_PAGES`, `GEOMETRY_LIMIT` | unset | Dev bounds on the COJ paged pulls and the PAR shapefile read |

`CI` and the `GITHUB_*` variables are read but never set by hand: GitHub Actions supplies them, and
they only decide whether the quarterly snapshot runs and what CI provenance lands in the run record.

`.env` and `.env.local` are both loaded from `pipeline/`, in that order, and neither overrides a
variable already present in the environment.

No secrets are read anywhere except `publish/filebase.ts` and `tracks/businesses.ts`; nothing prints them.

## What a run does

1. `run_id` (ULID) + `run_log` row (`running`); any earlier `running` row left by a dead process is closed as `aborted`.
2. For US-only tracks, a probe GET decides egress: outside the US the track is recorded as `skipped: non-US egress (HTTP <status>)` (coverage keeps the reason); on a GitHub runner it runs.
3. Per track: HEAD the source; skip the download when the ETag (or Last-Modified + size when no ETag) matches the sidecar; otherwise stream to `<file>.part` with sha256, rename. Extract (CSV/GTFS) or read in place (`/vsizip/` for the shapefile and the NHD FileGDB). Sunbiz: SFTP listing, only files not yet journaled in `source_files` are fetched (fastGet, parallel reads).
4. Header check against the expected layout: missing columns fail the run; new columns fail unless `ALLOW_NEW_COLUMNS=1` (then recorded as a limitation).
5. Stage into `staging.<table>`, add `row_hash = md5(to_json(row))` + provenance, MERGE into the target: `inserted` / `updated` (hash differs) / `unchanged` (provenance kept) / `missing_in_source` (kept, counted; scoped by `authoritativeScope` where the staging table cannot speak for the whole target, which is the case for a table two tracks write (`sales_history`) and for a track that stages one bounded window per run (`pa_detail`); not meaningful at all for delta feeds such as Sunbiz daily files). Duplicate or NULL natural keys in staging abort the merge.
6. Nearest-neighbour features (transit stops, Starbucks) via a grid join + brute-force fallback; water distance via shoreline vertices on a grid join; `links` rebuilds owners + entity_links.
7. `derived.properties_features` (one row per parcel), `query-table.parquet`, the validation gate (rows == distinct folio in `parcels`, 0 null, 0 dup, canonical columns present, per-column coverage printed), entity parquet tables, `dataset-coverage.json`, `run-history.json` (all runs), `runs/<run_id>.json` (committed by CI).
7b. `export:consolidation` runs after the ingestion run and rewrites the query table, so it applies the SAME gate, and it builds into `query-table.staging.parquet` and promotes only on a pass. A failed gate leaves the last artifact that passed exactly where it was and exits non-zero, which stops the job before the publish step.
8. `publish` (separate command, dry-run by default) computes CIDs locally with `ipfs-only-hash` (same defaults as the Elephant reference uploaders; CIDv1 rendering also shown), PUTs to Filebase, checks `x-amz-meta-cid`, upserts IPNS labels, writes `published-counties.json`, `artifacts-index.json`, `publish-manifest.json`.

### Provenance

Every entity table carries `row_hash, source_system, source_url, source_artifact, source_sha256, fetched_at, run_id`.
`source_artifact` is the path under `DATA_DIR/artifacts/` and `source_sha256` the hash of that exact file (Sunbiz rows point at their daily file, water rows at the AGO geojson or the NHD zip, Overture rows at the release), so any row can be traced to the bytes it came from. `run_log_sources` records per run and per source: artifact ETag / Last-Modified / bytes / sha256, download status, rows staged, inserted / updated / unchanged / missing, table total, delta vs the previous completed run, limitations, errors and notes (throughput, files processed, match counts).
`run_log_sources.rehydrated` says whether the row was written by a track running against this database or loaded from a committed `runs/*.json` by `rehydrateRunLog`. The committed records come from both GitHub Actions cache lineages, whose databases hold different amounts of data, so a rehydrated row is history for display, provenance and coverage but never a measurement of this database's tables: the delta vs the previous completed run compares only against runs this database recorded, and reports unknown when it has none.

## Tables (DuckDB, `DATA_DIR/duval.duckdb`, schema v2)

`parcels` (NAL roll, 1 row per PARCEL_ID, ~100 curated columns + centroid), `parcel_geometry` (PAR centroid lat/lon, area, bbox), `sales_history` (SDF + NAL SALE_*1/2, deduped), `transit_stops` (+ routes served, wheelchair) and `transit_routes`, `water_bodies` (COJ river polygons + NHD waterbody/area/flowline, WKB), `places` (Overture, `is_starbucks`), `businesses` + `business_events` (Sunbiz, Duval filter), `owners` (normalized name + mailing hash, parcel_count), `entity_links` (parcel->owner, business->parcel by situs address / owner name, coj_parcel/address_point/permit -> parcel), `coj_parcels`, `address_points`, `contractors`, `permits`, `pa_detail_buildings`, `pa_detail_sales` (US-egress tracks; filled from Actions), `consolidation_state`, `source_files` (Sunbiz journal), `track_state` (cursors: COJ `last_edit_date_iso`, permits `cursor_seq`, discovered API), `run_log`, `run_log_sources`, `derived.properties_features`, `derived.nn_transit`, `derived.nn_starbucks`, `derived.water_distance`, `derived.dor_use_codes`, `staging.*`.

Table totals after the latest completed run, `01M0K8WH2MSEKV36HXKDF9A910` (2026-08-21T23:43Z on a US
runner, so the US-egress tracks ran). These are the `totals` block of `runs/01M0K8WH2MSEKV36HXKDF9A910.json`,
and they are what the published artifacts were built from:

| Table | Rows | Notes |
|---|---|---|
| `parcels` | 404,023 | 0 duplicate / 0 null folios |
| `parcel_geometry` | 405,716 | 403,813 parcels get coordinates; 210 NAL parcels have no shape |
| `sales_history` | 71,802 | 64,532 staged by the SDF track, 7,270 folded in by `pa_detail` |
| `transit_stops` | 2,501 | 45 routes: 43 bus, 1 people mover, 1 ferry |
| `water_bodies` | 757 | COJ St Johns 10 + Jax_River 1, NHD waterbody 223 / area 9 / named flowline 514 |
| `places` | 3,084 | 81 Starbucks |
| `businesses` | 438,526 | Sunbiz quarterly base (10 `cordata*.txt` members, 12,808,196 records parsed, 437,502 kept for Duval) plus the daily-delta journal |
| `business_events` | 17,919 | event lines |
| `coj_parcels` | 407,985 | 407,986 features fetched over 204 pages; 403,714 matched to NAL |
| `address_points` | 671,814 | 336 pages; 367,966 matched to NAL |
| `contractors` | 4,050 | Duval, all trades; 516 roofing |
| `permits` | 0 | constrained source, see below |
| `pa_detail_buildings` | 1,109 | seed cursor 1,466 of 398,324 parcels; 32.6 pages/min, 0 errors this window |
| `owners` | 323,925 | |
| `entity_links` | 1,444,531 | 240,928 business->parcel by situs address, 27,900 by owner name; 116,696 parcels linked to a Sunbiz business |
| `derived.properties_features` | 404,023 | 133 columns |

## Query table (`query-table.parquet`)

133 columns: the 37 canonical `elephant-query-db` columns first (`property_id ... hoa_flag`), then 96
Duval extras. The published artifact
(`bafybeidmxru6kibvnvuuyytiaylu2ufuelc7nowi626ww6kfrg2ocud7uu`) measures 404,023 rows x 133 columns,
50,090,904 bytes. The extras are:
`dor_uc, pa_uc, eff_year_built, taxable_value, assessed_value_school, homestead_flag, building_count, residential_units,
legal_description, neighborhood_code, census_block, owner_mailing_address/city/state/zip, owner_region_class,
last_sale_source/qual_cd/or_book/or_page, sale_count, last_sale_date_any, tenure_basis, years_since_last_sale,
no_sale_10y_flag, sunbiz_business_count, roof_permit_count, last_roof_permit_year/date, last_permit_date,
roof_year_est, roof_age_basis, roof_age_years, water_view_flag, water_view_major_flag, water_dist_m, water_body_name,
water_body_type, water_basis, nearest_transit_stop_m/id/name, nearest_transit_route_types, nearest_transit_routes,
near_transit_800m, nearest_starbucks_m/id/name, near_starbucks_800m, fld_zone, zoning, coj_last_sale_date,
address_point_count, roof_structure, pa_actual_year_built, pa_building_count, coordinates_source, source_artifact,
source_sha256, source_fetched_at, source_run_id, features_run_id, features_as_of, has_additional_owners,
tenure_source, tenure_quality, tenure_date_check, has_sale_on_record, source_systems, source_url, fetched_at, run_id`

`tenure_quality` and `tenure_date_check` are the tenure judgement, published rather than computed in
the browser so an MCP client inherits it instead of reading raw sentinel dates. `tenure_quality` is
`PLAUSIBLE` on 388,448 parcels, `INSTITUTIONAL_OR_CIVIC` on 11,935, `NO_SALE_ON_RECORD` on 2,187 and
`IMPLAUSIBLE_DATE` on 1,453, where the recorded sale predates 1901 and is filler in the City
recorded-sales file rather than a transfer. Both cuts are fixed in the data rather than measured
against the as-of date, because a duration threshold moves as the artifact ages. `tenure_date_check`
carries no threshold at all: it compares each row's own sale date against its own `built_year` and
reads `CONTRADICTED` where the sale is earlier, which is what separates a 1901 date on a house built
in 1952 from a real long hold.
(the last three of those are the UI provenance contract), plus the twelve per-family provenance pairs
`appraisal_source/_fetched_at, sales_*, geometry_*, structure_*, permit_*, business_*, contractor_*,
transit_*, places_*, water_*, parcel_layer_*, address_*` (24 columns). `property_cid` is filled from
`consolidation_state` after `export:consolidation`.

Family coverage on the published artifact, measured as the share of the 404,023 rows whose
`<family>_source` is non-null: appraisal 100%, business 100%, geometry / transit / places / water
99.95% (403,813), parcel_layer 99.92% (403,714), address 59.72% (241,270), sales 12.94% (52,281),
structure 0.23% (930), permit 0%, contractor 0%.

Rules (TS and SQL twins in `src/features/rules.ts` and `src/features/normalize.ts`, both tested):

- `owner_region_class`: LOCAL = mailing state FL and ZIP5 in the Duval set (32099, 32201-32258 except 32259, 32260, 32266, 32277; city-name fallback when no ZIP); REGIONAL = FL outside Duval, GA, SC, AL; NATIONAL = other US state/territory/military code; FOREIGN = non-US code; NULL = no mailing state.
- Tenure: `last_sale_date_any` = latest of the FDOR roll/SDF sale and the COJ parcel layer `SALESL*` date; `tenure_basis` FDOR_SALE | COJ_SALESL | NO_SALE_ON_RECORD; `years_since_last_sale` = floor((as_of - date) / 365.25 d); `no_sale_10y_flag` true when that date <= as_of - 10 y, NULL when no sale is known. Measured on the published artifact: COJ_SALESL 398,908, FDOR_SALE 2,924, NO_SALE_ON_RECORD 2,191. The FDOR side is not decorative: it wins on 2,924 parcels where the roll or a PA detail page records a later transfer than the COJ layer does.
- `roof_year_est` / `roof_age_basis`: `PERMIT` (latest re-roof permit year, `ROOF|RE-ROOF|REROOF|SHINGLE`) else `EFF_YR_BLT_PROXY` else `ACT_YR_BLT_PROXY`. Only one of the three occurs on the published artifact: 359,129 rows are `EFF_YR_BLT_PROXY` and the other 44,894 have no basis at all (NULL, with `roof_year_est` and `roof_age_years` NULL beside it). `PERMIT` needs a harvested permit and none exists. `ACT_YR_BLT_PROXY` is reachable in the rule but unreachable in this roll: `EFF_YR_BLT > 0` and `ACT_YR_BLT > 0` hold on exactly the same 359,129 rows (0 rows have an actual year without an effective year), and the other 44,894 rows carry neither, so the third branch has never fired.
- Transit / Starbucks: great-circle distance from the parcel centroid to the nearest JTA stop / Starbucks place; `near_*_800m` = <= 800 m.
- Water: distance from the centroid to the nearest mapped shoreline vertex (COJ river polygons + NHD, simplified to ~10 m); `water_view_flag` = <= 150 m or parcel bbox within 30 m; `water_view_major_flag` restricts to the river / bay layers; `water_basis` names the feature and layer; distances beyond ~1 km are NULL (`water_basis` says so).
- `owner_occupied` = mailing line 1 + ZIP5 equal the situs line 1 + ZIP5; `has_sunbiz_tenant` = a Sunbiz business linked by situs address.
- Columns whose source is not loaded are NULL, never false / 0 (`has_permits`, `permit_count`, `fld_zone`, `zoning` until the US-only tracks run in Actions).
- `property_cid` = CID of the property's open-data JSON (`export:consolidation`); NULL until the first export.

## MCP configuration: the publish output is the only source of truth

Every publish writes `publish/duval/mcp-env.txt` (and the same values under `mcpEnv` /
`mcpBindings` in `publish-manifest.json`, copied to `runs/latest-publish-manifest.json` and
`runs/latest-mcp-env.txt`). Paste that file into the MCP deployment. Nothing else should be
hand-assembled, because the same values are what the published `published-counties.json` catalog
advertises, and the publish refuses to finish if the two disagree.

**The query table is addressed by CID, not by its IPNS name.** This is not a preference:

`@elephant-xyz/mcp` resolves a county's parquet from `PROPERTY_QUERY_TABLE_MAP` and hands the URL
straight to DuckDB, `CREATE VIEW properties AS SELECT * FROM read_parquet('<url>')`, then caches
that connection for the life of the warm instance keyed on the URL. DuckDB's `httpfs` remembers the
ETag it saw when the view was created and revalidates it on every later range read. An
`/ipns/k51.../` URL therefore works exactly until the next publish re-points the name, at which
point the gateway answers with a different ETag and every data tool on that warm instance fails
with `ETag on reading file ".../ipns/k51..." was initially "QmV25TMv..." and now it returned
"QmT5tK6ry..."`. Publishing every six hours guarantees that several times a day. The server is
deployed unmodified and exposes no way to disable the check, and the catalog is not consulted for
the parquet location, so an immutable `/ipfs/<cidv1>` URL is the only configuration that survives a
publish. Changing the URL also changes DuckDB's cache key, so the redeploy picks up the new
artifact cleanly instead of poisoning a cached view.

`DATASET_COVERAGE_MAP` is read with a plain `fetch` behind a five minute TTL, so a name would work
there. It is pinned to the same publish anyway, so the coverage numbers a client reads always
describe the exact parquet that client is querying rather than racing ahead of it.

Everything else stays on a stable IPNS name and is set once: `PUBLISHED_COUNTY_CATALOG_URL` and
`ORACLE_OPEN_DATA_IPNS_MAP` are both fetched as JSON behind short TTLs and never touch DuckDB.

| Setting | Addressing | Re-apply after every publish |
|---|---|---|
| `PROPERTY_QUERY_TABLE_MAP` | `/ipfs/<cidv1>` | yes |
| `DATASET_COVERAGE_MAP` | `/ipfs/<cidv1>` | yes |
| `PROPERTY_QUERY_TABLE_DEFAULT_COUNTY`, `ORACLE_OPEN_DATA_DEFAULT_COUNTY` | literal `duval` | no |
| `ORACLE_OPEN_DATA_IPNS_MAP` | `/ipns/k51...` | no |
| `PUBLISHED_COUNTY_CATALOG_URL` | `/ipns/k51...` | no |

The IPNS names are still minted and still recorded in `publish-manifest.json` and
`artifacts-index.json`: the UI follows `oracle-run-history-duval` across runs (a CID there once
froze the runs page at eight runs), and the catalog name is what lets an operator set
`PUBLISHED_COUNTY_CATALOG_URL` once and never touch it again.

The two per-publish lines are printed by `publish-artifacts.yml` in its job summary, so the current
values are one click away in the Actions tab without downloading anything.

## The six questions: availability on the published artifact

Every figure below was measured with DuckDB against the published query table
(`bafybeidex5m2tzcbicfzjn4phgiudr2lpt7lgqf23ajz3gythipqdqhlri`, 404,023 rows), not against a local
working set. Re-run any of them yourself: see "Verify these numbers" below.

| Question | Parcels with the feature | Basis | Gap |
|---|---|---|---|
| Roof older than 15 years | 359,129 known; 298,314 with `roof_age_years >= 15` (296,902 strictly `> 15`) | `EFF_YR_BLT_PROXY` on all 359,129 | no `PERMIT` basis exists, because no permit was ever harvested |
| Water view | 403,813 known; 89,588 flagged, of which 83,084 sit on a river/bay layer (`water_view_major_flag`) | shoreline-vertex proximity proxy | not a sightline; creeks and >= 1 ha ponds included, filter by `water_view_major_flag` for rivers |
| No ownership change in 10+ years | 401,832 with a dated transfer on record; 153,242 flagged | `COJ_SALESL` on 398,908, `FDOR_SALE` on 2,924 | 2,191 parcels have no transfer in any source; they are `NO_SALE_ON_RECORD` and must not be read as long holds |
| Regional owners | 403,201 classified; 34,649 REGIONAL (333,851 LOCAL, 34,697 NATIONAL, 4 FOREIGN, 822 unclassified) | NAL mailing address | FOREIGN under-detected (blank OWN_STATE) |
| Walking distance to transit | 403,813 known; 326,112 within 800 m of a JTA stop | GTFS stops, haversine | straight-line, not network distance |
| Walking distance to Starbucks | 403,813 known; 150,860 within 800 m | Overture places, haversine | name/brand match |

Combined: 130,045 parcels satisfy `roof_age_years >= 15 AND no_sale_10y_flag`.

### Verify these numbers

Every figure in this file that describes the published data can be reproduced from the artifact
itself, with no checkout and no credential. Any DuckDB (CLI, `@duckdb/node-api`, DuckDB-WASM in the
`/query` page) will do:

```sql
INSTALL httpfs; LOAD httpfs;
CREATE VIEW properties AS SELECT * FROM read_parquet(
  'https://ipfs.filebase.io/ipfs/bafybeidex5m2tzcbicfzjn4phgiudr2lpt7lgqf23ajz3gythipqdqhlri');

SELECT count(*) FROM properties;                                        -- 404,023
SELECT count(*) FROM (DESCRIBE SELECT * FROM properties);               -- 131
SELECT roof_age_basis, count(*) FROM properties GROUP BY 1;             -- EFF_YR_BLT_PROXY 359,129; NULL 44,894
SELECT tenure_basis, count(*) FROM properties GROUP BY 1;               -- COJ_SALESL 398,908; FDOR_SALE 2,924; NO_SALE_ON_RECORD 2,191
SELECT count(*) FROM properties WHERE last_sale_date IS NULL;           -- 351,742
SELECT round(100.0 * count(*) FILTER (WHERE sales_source IS NOT NULL)
             / count(*), 2) FROM properties;                            -- 12.94
```

## Sources, where they run, limitations (recorded per run in `run_log_sources.limitations`)

| Track | Source | Runs | Limitations |
|---|---|---|---|
| appraisal | FDOR NAL 2026P Duval (29 MB zip, 165 columns) | anywhere | only the current roll is posted; no roof fields; sales limited to 2025-2026 |
| sales | FDOR SDF 2026P Duval (1.1 MB zip) | anywhere | year + month only |
| geometry | FDOR PAR shapefile 2026 Duval (192 MB zip, EPSG:2881) | anywhere | centroids, not rooftop points; 210 parcels without a shape |
| transit | JTA GTFS (5.6 MB, redirect to a dated media file, ETag) | anywhere | no GTFS-RT; straight-line distances |
| water | COJ stjohnsriver + Jax_River (AGO geojson) + USGS NHD HU4 0307 (97 MB FileGDB zip) | anywhere | proximity proxy; ponds < 1 ha and unnamed flowlines excluded; ~1 km search radius |
| places | Overture Maps places 2026-08-19.0 (DuckDB httpfs, anonymous S3) | anywhere | ~2.5 min remote scan per run; name-based brand match |
| businesses | Sunbiz SFTP: quarterly base `cordata.zip` (1,819,049,954 bytes, 10 members, 12,808,196 records) + daily corporate files (1,440-char records) + events | anywhere | no county filter (ZIP 322xx / JACKSONVILLE city, which kept 437,502 of 12.8 M base records); layout page was HTTP 522, offsets validated on live records; `get()` is ~6 KB/s on this server, `fastGet` ~250 KB/s; the base snapshot is off locally unless `SUNBIZ_BASE_SNAPSHOT` is set |
| links | derived reconciliation | anywhere | exact normalized address match |
| coj_parcels | COJ CityBiz/Parcels MapServer 0 (407,986 rows, 2000/page) | US egress (Actions) | locally `skipped: non-US egress (HTTP 0, fetch failed)` |
| coj_addresses | COJ ERAT layer 41 address points (671,814; EDIT_DATE incremental) | US egress (Actions) | first run full pull; then `EDIT_DATE >= last` (falls back to full when the filter is rejected) |
| contractors | DBPR CILB certified (~750 MB) + registered CSV | US egress (Actions) | locally HTTP 403; Duval county code inferred from JACKSONVILLE rows; BBB excluded (terms) |
| permits | JaxEPICS permit pages / JSON API discovered from the Angular bundle | US egress (Actions) | enumeration only, concurrency 2, 500 ms delay, `--window` permits per run, throughput recorded as a limitation; API shape saved to `runs/latest-jaxepics-api.json` |
| pa_detail | paopropertysearch.coj.net Detail.aspx (seed order) + vendored Elephant lexicon transform | US egress (Actions); parser + transform proven on the fixture locally | slow source: 300 pages/run at concurrency 2 / 400 ms; the full seed takes many runs; cursor + throughput journaled |

Geo-blocking: every `*.coj.net` / `jacksonville.gov` host and the DBPR extracts refuse non-US IPs; FDOR, JTA,
NHD (S3), Overture (S3), the COJ AGO hosted layers and Sunbiz SFTP do not. The workflow prints its egress
country each run; the run record stores it too.

## Workflows

- `.github/workflows/pipeline.yml`: cron every 6 h + dispatch; runs ALL tracks with `SUNBIZ_WINDOW_DAYS=14`, `PERMITS_WINDOW=300`, `PA_DETAIL_WINDOW=300`; then `export:consolidation --since changed`; caches the source zips, seed, PA pages, open-data export and the DuckDB file between runs; uploads `publish/duval/*` (minus the per-property files) and the discovered JaxEPICS API as workflow artifacts; commits `runs/*.json` back; publishes open data + query table when `FILEBASE_*` secrets exist.
- `.github/workflows/pipeline-window.yml`: dispatch-only bounded run (tracks + window + force + optional publish) for ad-hoc permit / Sunbiz / COJ pulls.
- `.github/workflows/probe-sources.yml`: reachability probe (unchanged).
- `.github/workflows/publish-artifacts.yml`: dispatch-only re-publish of the 15 runtime artifacts from the cached working set, without re-ingesting; prints `mcp-env.txt` into the job summary.
- `.github/workflows/ci.yml`: push / PR tests for the whole repository. Three jobs: `pipeline` (tsc + vitest), `ui` (tsc + vitest) and `ui-e2e` (Playwright smoke, `continue-on-error` until the suite has been green for a few consecutive runs). Before this existed, only `pipeline/` was tested, inside the 40-minute ingestion workflow.

### What is committed back, and why

`runs/` is the only durable record this pipeline has: the DuckDB working set lives in a
branch-scoped Actions cache that GitHub evicts after seven days without a hit, so `run_log` cannot
be trusted to remember anything. Alongside `runs/<run_id>.json` the pipeline commits:

- `runs/ci-runs.json` - two independently merged layers. `workflow_runs` is a projection of the
  GitHub Actions API, rebuilt on every run, and `runs` holds this pipeline's own records. The
  `by_event` tally is derived from the API layer, and `by_event_source` states which layer it came
  from, so nobody reads the tally without knowing what produced it. `ci_history` carries the exact
  endpoint and fetch time, so a reader can re-issue the request and diff the answer.
  `jq .by_event runs/ci-runs.json` answers "is the cron actually running".

  It is derived rather than appended because appending could not survive our own branch handling: a
  scheduled run committed its record, and a later force-push of the feature branch over `main`
  destroyed it, leaving a tally that read zero scheduled runs while the cron had in fact fired. A
  deleted file is now repaired by the next run; a failed fetch keeps every existing row and records
  `outcome: "api_unreachable"` rather than looking authoritative.

  The consolidation pass keeps `trigger: "consolidation"` because that is the run KIND the UI groups
  on, so the CI event is recorded here instead and a scheduled consolidation is as provable as a
  scheduled ingestion run.
- `runs/table-highwater.json` - the largest each table has ever been on this lineage, the current
  value, and an event log of every time a total went backwards. A run whose totals are below the
  marks fails before it publishes; `--allow-regression --regression-note "<why>"` re-bases the
  marks and records who did it and why.
- `runs/track-state.json` - every accumulating track's cursor after the run, so a rewind is visible
  in the diff of the commit that caused it.
- `runs/latest-publish-manifest.json`, `runs/latest-mcp-env.txt`, `runs/latest-dataset-coverage.json`,
  `runs/latest-jaxepics-api.json`.

The commit-back rebases and retries five times before failing the step. A single attempt is not
enough: the record of the scheduled run 32513420281 was pushed to `main` as commit `48d8806` and
then lost when the branch moved underneath it, which is why no committed run carried
`trigger: "schedule"` for a while. `runs/*.json` is also uploaded as a workflow artifact on every
run, so the record survives even when the commit cannot land.

A failed **scheduled** run opens (or comments on) a `pipeline-failure` GitHub issue and writes the
detail into the job summary. Dispatched runs do not alert, because a human is already watching them.

## Cost model ($0 standing)

- Compute: GitHub Actions (free minutes; the latest all-tracks run (01M0K8WH2MSEKV36HXKDF9A910) took 42 min wall clock, dominated by the water distance pass at 6.7 min and the pa_detail window at 8.2 min; cold adds the 222 MB FDOR zips + 97 MB NHD once, then cached).
- Storage: the runtime set the publish uploads is 15 objects and 239.7 MB (query table 50.0 MB, ten entity tables 189.0 MB, coverage / run history / catalogs the rest); the per-property open-data set is 1.97 GB for 404,023 properties across 41 shards (Filebase free tier is 5 GB / 1,000 pins: the per-property files count as pins, so the full open-data publish needs a paid Filebase plan or a bucket with raised pin limits; the dry-run prints the exact object count and bytes before anything is uploaded); IPFS gateways serve reads; IPNS names are free.
- Database: a DuckDB file, restored from the Actions cache or rebuilt; published parquet is the portable copy (DuckDB / DuckDB-WASM read it straight from the gateway with range requests).
- Nothing runs when nobody runs it. No AWS, no Neon, no Restate.

## Engineering notes

TypeScript / Node 22 / ESM, `@duckdb/node-api` (+ spatial, httpfs), `@aws-sdk/client-s3` (Filebase), `ssh2-sftp-client` (Sunbiz), `ipfs-only-hash` + `multiformats`, zod, vitest, tsx. Structured JSON logs (`src/log.ts`).

Deviations from the team Golden Path, stated rather than hidden:

- **No CDK / Glue / PySpark**, because the requirement is zero standing infrastructure. Actions + DuckDB + IPFS instead.
- **No PagerDuty**, because there is no standing infrastructure to pay for one. A failed scheduled run opens a `pipeline-failure` GitHub issue (and posts to `ALERT_WEBHOOK_URL` when that secret is set), which is the same alerting contract at zero cost.
- **Linting is not uniform across the repository.** `pipeline/` has a flat ESLint config (`eslint.config.js`: `js.configs.recommended`, `typescript-eslint` recommended, `eslint-config-prettier`) wired to `pnpm lint`. `ui/` has no ESLint at all; its `pnpm lint` script runs `tsc --noEmit`, which is a type check and not a lint. That is a real gap, not a naming quirk, and it is written down here rather than left for a reviewer to find.
- **`no-useless-assignment` is switched off in `pipeline/eslint.config.js`, deliberately.** `let x: T | null = null` ahead of a try/catch that assigns it is the clearest way to write a fallible step in this codebase, and the rule objects to the initialiser rather than to a defect. The reason is in a comment on the rule itself, so the next person does not have to guess.
