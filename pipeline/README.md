# Duval County (FL) Oracle pipeline

Continuous, incremental ingestion of Duval County public property data into a DuckDB analytical
store, with the Elephant-convention artifacts (query-table parquet, dataset coverage, run history,
entity tables, published-counties catalog) published to IPFS through Filebase and addressed by
stable IPNS names. Self-contained: no Neon, no Restate, no AWS. County key `duval`, FIPS `12031`,
`source_system = duval_appraiser`.

```
GitHub Actions (cron every 6 h + dispatch)      Filebase S3 -> IPFS pins + IPNS (/v1/names)
  pnpm run pipeline -- --tracks ...              oracle-query-table-duval      query-table.parquet
    download (ETag / Last-Modified / sha256)      oracle-dataset-coverage-duval dataset-coverage.json
    stage -> hash -> MERGE (ins/upd/unchanged)    duval-oracle-artifacts        artifacts-index.json
    features -> parquet -> validation gate          (run-history.json, tables/*.parquet,
    run_log + runs/<run_id>.json                     published-counties.json listed inside)
  DuckDB file: DATA_DIR/duval.duckdb
```

## Run it

```bash
cd pipeline
pnpm install
cp .env.example .env          # optional; everything has defaults, Filebase keys empty = dry-run

pnpm run pipeline -- --tracks default --window 14d     # what the schedule runs: all 12 tracks; US-only ones self-skip outside the US
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
pnpm test                                              # vitest: 11 files / 38 tests
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

Measured locally: 20,000 records in 46 s (87.9 MB, ~4.4 KB each, pretty-printed like the reference export); the
full 404,023-property export is ~16 min and ~1.8 GB on disk (see the latest `runs/*.json` of track `consolidation`
for the exact figures).

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
| `PERMITS_WINDOW`, `PERMITS_YEAR`, `PERMITS_PREFIX`, `PERMITS_START_SEQ` | 300, current YY, B, 1 | JaxEPICS enumeration window and cursor start |
| `PA_DETAIL_WINDOW` | 300 | PA detail pages per run (also `--window 300`) |
| `COJ_MAX_PAGES`, `GEOMETRY_LIMIT`, `ALLOW_NEW_COLUMNS`, `LOG_LEVEL` | unset | Dev bounds / drift downgrade / log level |

No secrets are read anywhere except `publish/filebase.ts` and `tracks/businesses.ts`; nothing prints them.

## What a run does

1. `run_id` (ULID) + `run_log` row (`running`); any earlier `running` row left by a dead process is closed as `aborted`.
2. For US-only tracks, a probe GET decides egress: outside the US the track is recorded as `skipped: non-US egress (HTTP <status>)` (coverage keeps the reason); on a GitHub runner it runs.
3. Per track: HEAD the source; skip the download when the ETag (or Last-Modified + size when no ETag) matches the sidecar; otherwise stream to `<file>.part` with sha256, rename. Extract (CSV/GTFS) or read in place (`/vsizip/` for the shapefile and the NHD FileGDB). Sunbiz: SFTP listing, only files not yet journaled in `source_files` are fetched (fastGet, parallel reads).
4. Header check against the expected layout: missing columns fail the run; new columns fail unless `ALLOW_NEW_COLUMNS=1` (then recorded as a limitation).
5. Stage into `staging.<table>`, add `row_hash = md5(to_json(row))` + provenance, MERGE into the target: `inserted` / `updated` (hash differs) / `unchanged` (provenance kept) / `missing_in_source` (kept, counted; scoped by `authoritativeScope` where the staging table cannot speak for the whole target, which is the case for a table two tracks write (`sales_history`) and for a track that stages one bounded window per run (`pa_detail`); not meaningful at all for delta feeds such as Sunbiz daily files). Duplicate or NULL natural keys in staging abort the merge.
6. Nearest-neighbour features (transit stops, Starbucks) via a grid join + brute-force fallback; water distance via shoreline vertices on a grid join; `links` rebuilds owners + entity_links.
7. `derived.properties_features` (one row per parcel), `query-table.parquet`, the validation gate (rows == distinct folio in `parcels`, 0 null, 0 dup, canonical columns present, per-column coverage printed), entity parquet tables, `dataset-coverage.json`, `run-history.json` (all runs), `runs/<run_id>.json` (committed by CI).
8. `publish` (separate command, dry-run by default) computes CIDs locally with `ipfs-only-hash` (same defaults as the Elephant reference uploaders; CIDv1 rendering also shown), PUTs to Filebase, checks `x-amz-meta-cid`, upserts IPNS labels, writes `published-counties.json`, `artifacts-index.json`, `publish-manifest.json`.

### Provenance

Every entity table carries `row_hash, source_system, source_url, source_artifact, source_sha256, fetched_at, run_id`.
`source_artifact` is the path under `DATA_DIR/artifacts/` and `source_sha256` the hash of that exact file (Sunbiz rows point at their daily file, water rows at the AGO geojson or the NHD zip, Overture rows at the release), so any row can be traced to the bytes it came from. `run_log_sources` records per run and per source: artifact ETag / Last-Modified / bytes / sha256, download status, rows staged, inserted / updated / unchanged / missing, table total, delta vs the previous completed run, limitations, errors and notes (throughput, files processed, match counts).

## Tables (DuckDB, `DATA_DIR/duval.duckdb`, schema v2)

`parcels` (NAL roll, 1 row per PARCEL_ID, ~100 curated columns + centroid), `parcel_geometry` (PAR centroid lat/lon, area, bbox), `sales_history` (SDF + NAL SALE_*1/2, deduped), `transit_stops` (+ routes served, wheelchair) and `transit_routes`, `water_bodies` (COJ river polygons + NHD waterbody/area/flowline, WKB), `places` (Overture, `is_starbucks`), `businesses` + `business_events` (Sunbiz, Duval filter), `owners` (normalized name + mailing hash, parcel_count), `entity_links` (parcel->owner, business->parcel by situs address / owner name, coj_parcel/address_point/permit -> parcel), `coj_parcels`, `address_points`, `contractors`, `permits`, `pa_detail_buildings`, `pa_detail_sales` (US-egress tracks; filled from Actions), `consolidation_state`, `source_files` (Sunbiz journal), `track_state` (cursors: COJ `last_edit_date_iso`, permits `cursor_seq`, discovered API), `run_log`, `run_log_sources`, `derived.properties_features`, `derived.nn_transit`, `derived.nn_starbucks`, `derived.water_distance`, `derived.dor_use_codes`, `staging.*`.

Current local load (2026-08-21): parcels 404,023 (0 dup / 0 null), parcel_geometry 405,716 (403,813 parcels with coordinates), sales_history 64,532, transit_stops 2,501 (45 routes: 43 bus, 1 people mover, 1 ferry), water_bodies 757 (COJ St Johns 10 + Jax_River 1, NHD waterbody 223 / area 9 / named flowline 514), places 3,084 (81 Starbucks), businesses 1,024 from 14 daily files (+ 17,919 event lines), owners 324,052, entity_links 404,681 (655 business->parcel by situs address, 3 by owner name; 577 parcels linked to a Sunbiz business).

## Query table (`query-table.parquet`)

37 canonical columns from `elephant-query-db` first (`property_id ... hoa_flag`), then the Duval extras:
`dor_uc, pa_uc, eff_year_built, taxable_value, assessed_value_school, homestead_flag, building_count, residential_units,
legal_description, neighborhood_code, census_block, owner_mailing_address/city/state/zip, owner_region_class,
last_sale_source/qual_cd/or_book/or_page, sale_count, last_sale_date_any, tenure_basis, years_since_last_sale,
no_sale_10y_flag, sunbiz_business_count, roof_permit_count, last_roof_permit_year/date, last_permit_date,
roof_year_est, roof_age_basis, roof_age_years, water_view_flag, water_view_major_flag, water_dist_m, water_body_name,
water_body_type, water_basis, nearest_transit_stop_m/id/name, nearest_transit_route_types, nearest_transit_routes,
near_transit_800m, nearest_starbucks_m/id/name, near_starbucks_800m, fld_zone, zoning, coj_last_sale_date,
address_point_count, roof_structure, pa_actual_year_built, pa_building_count, coordinates_source, source_artifact,
source_sha256, source_fetched_at, source_run_id, features_run_id, features_as_of, source_url, fetched_at, run_id`
(the last three are the UI provenance contract). `property_cid` is filled from `consolidation_state` after
`export:consolidation`.

Rules (TS and SQL twins in `src/features/rules.ts` and `src/features/normalize.ts`, both tested):

- `owner_region_class`: LOCAL = mailing state FL and ZIP5 in the Duval set (32099, 32201-32258 except 32259, 32260, 32266, 32277; city-name fallback when no ZIP); REGIONAL = FL outside Duval, GA, SC, AL; NATIONAL = other US state/territory/military code; FOREIGN = non-US code; NULL = no mailing state.
- Tenure: `last_sale_date_any` = latest of the FDOR roll/SDF sale and the COJ parcel layer `SALESL*` date; `tenure_basis` FDOR_SALE | COJ_SALESL; `years_since_last_sale` = floor((as_of - date) / 365.25 d); `no_sale_10y_flag` true when that date <= as_of - 10 y, NULL when no sale is known.
- `roof_year_est` / `roof_age_basis`: `PERMIT` (latest re-roof permit year, `ROOF|RE-ROOF|REROOF|SHINGLE`) else `EFF_YR_BLT_PROXY` else `ACT_YR_BLT_PROXY`.
- Transit / Starbucks: great-circle distance from the parcel centroid to the nearest JTA stop / Starbucks place; `near_*_800m` = <= 800 m.
- Water: distance from the centroid to the nearest mapped shoreline vertex (COJ river polygons + NHD, simplified to ~10 m); `water_view_flag` = <= 150 m or parcel bbox within 30 m; `water_view_major_flag` restricts to the river / bay layers; `water_basis` names the feature and layer; distances beyond ~1 km are NULL (`water_basis` says so).
- `owner_occupied` = mailing line 1 + ZIP5 equal the situs line 1 + ZIP5; `has_sunbiz_tenant` = a Sunbiz business linked by situs address.
- Columns whose source is not loaded are NULL, never false / 0 (`has_permits`, `permit_count`, `fld_zone`, `zoning` until the US-only tracks run in Actions).
- `property_cid` = CID of the property's open-data JSON (`export:consolidation`); NULL until the first export.

## The six questions: availability today (local run, before the US-only tracks)

| Question | Parcels with the feature | Basis | Gap |
|---|---|---|---|
| Roof older than 15 years | 359,129 known; 296,902 with `roof_age_years > 15` | `EFF_YR_BLT_PROXY` | permits fill `PERMIT` basis from Actions |
| Water view | 403,813 known; 89,588 flagged (83,084 on river/bay layers) | shoreline-vertex proximity proxy | not a sightline; creeks and >= 1 ha ponds included, filter by `water_view_major_flag` for rivers |
| No ownership change in 10+ years | 51,022 tenure known, 0 flagged | FDOR 2026P carries only 2025-2026 sales | `coj_parcels` (SALESL*) in Actions fills `COJ_SALESL` basis for the rest |
| Regional owners | 403,201 classified; 34,649 REGIONAL (333,851 LOCAL, 34,697 NATIONAL, 4 FOREIGN) | NAL mailing address | FOREIGN under-detected (blank OWN_STATE) |
| Walking distance to transit | 403,813 known; 326,112 within 800 m of a JTA stop | GTFS stops, haversine | straight-line, not network distance |
| Walking distance to Starbucks | 403,813 known; 150,860 within 800 m | Overture places, haversine | name/brand match |

## Sources, where they run, limitations (recorded per run in `run_log_sources.limitations`)

| Track | Source | Runs | Limitations |
|---|---|---|---|
| appraisal | FDOR NAL 2026P Duval (29 MB zip, 165 columns) | anywhere | only the current roll is posted; no roof fields; sales limited to 2025-2026 |
| sales | FDOR SDF 2026P Duval (1.1 MB zip) | anywhere | year + month only |
| geometry | FDOR PAR shapefile 2026 Duval (192 MB zip, EPSG:2881) | anywhere | centroids, not rooftop points; 210 parcels without a shape |
| transit | JTA GTFS (5.6 MB, redirect to a dated media file, ETag) | anywhere | no GTFS-RT; straight-line distances |
| water | COJ stjohnsriver + Jax_River (AGO geojson) + USGS NHD HU4 0307 (97 MB FileGDB zip) | anywhere | proximity proxy; ponds < 1 ha and unnamed flowlines excluded; ~1 km search radius |
| places | Overture Maps places 2026-08-19.0 (DuckDB httpfs, anonymous S3) | anywhere | ~2.5 min remote scan per run; name-based brand match |
| businesses | Sunbiz SFTP daily corporate files (1,440-char records) + events | anywhere | no county filter (ZIP 322xx / JACKSONVILLE city); layout page was HTTP 522, offsets validated on live records; `get()` is ~6 KB/s on this server, `fastGet` ~250 KB/s |
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

## Cost model ($0 standing)

- Compute: GitHub Actions (free minutes; a warm all-tracks run is ~8 min, dominated by the Overture scan and the NN features; cold adds the 222 MB FDOR zips + 97 MB NHD once, then cached).
- Storage: the query-table/coverage/entity set is ~120 MB; the per-property open-data set is ~1.8 GB for 404K properties (Filebase free tier is 5 GB / 1,000 pins: the per-property files count as pins, so the full open-data publish needs a paid Filebase plan or a bucket with raised pin limits; the dry-run prints the exact object count and bytes before anything is uploaded); IPFS gateways serve reads; IPNS names are free.
- Database: a DuckDB file, restored from the Actions cache or rebuilt; published parquet is the portable copy (DuckDB / DuckDB-WASM read it straight from the gateway with range requests).
- Nothing runs when nobody runs it. No AWS, no Neon, no Restate.

## Engineering notes

TypeScript / Node 22 / ESM, `@duckdb/node-api` (+ spatial, httpfs), `@aws-sdk/client-s3` (Filebase), `ssh2-sftp-client` (Sunbiz), `ipfs-only-hash` + `multiformats`, zod, vitest, tsx. Structured JSON logs (`src/log.ts`). Deviations from the team Golden Path: no CDK / Glue / PySpark because the requirement is zero standing infrastructure (Actions + DuckDB + IPFS); no PagerDuty (a failed run fails the workflow and is visible in `run_log` / run history).
