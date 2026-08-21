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

pnpm run pipeline -- --tracks appraisal,sales,geometry   # one full run (~1 min warm, ~12 min cold: 222 MB of source zips)
pnpm run pipeline -- --tracks all --window 30d          # unimplemented tracks are recorded as skipped
pnpm run features                                       # rebuild derived.properties_features + parquet + gate
pnpm run validate                                       # re-run the query-table gate
pnpm run publish:ipfs                                   # DRY RUN: lists objects, keys, local CIDs, IPNS labels
pnpm run publish:ipfs -- --publish                      # real upload + IPNS re-point (needs FILEBASE_* env)
pnpm run status                                         # table counts + run history
pnpm run query -- "SELECT owner_region_class, count(*) FROM derived.properties_features GROUP BY 1"
pnpm test                                               # vitest (merge deltas, rules, validator, coverage, download, CID)
```

Flags for `pipeline`: `--tracks a,b|all|default` (default = appraisal,sales,geometry), `--window <w>`
(recorded; used by windowed tracks), `--trigger <name>` (recorded; CI passes the event name),
`--force` (re-download even when unchanged), `--no-features` (skip the feature/parquet stage).

### Environment

| Variable | Default | Purpose |
|---|---|---|
| `DATA_DIR` | `../data` (relative to the repo root, i.e. outside the checkout) | DuckDB file, `artifacts/<track>/` downloads (+ `.meta.json` sidecars), `artifacts/publish/duval/` outputs |
| `FILEBASE_ACCESS_KEY`, `FILEBASE_SECRET_KEY` | empty | Filebase S3 keys; also form the Names API token `base64(key:secret)` |
| `FILEBASE_BUCKET_DUVAL` | empty | The bucket that holds every Duval object |
| `FILEBASE_S3_ENDPOINT` | `https://s3.filebase.com` | S3 endpoint (the reference Elephant uploaders assert this host) |
| `FILEBASE_GATEWAY` | `https://ipfs.filebase.io` | Gateway used in published URLs |
| `SOURCE_URL_NAL`, `SOURCE_URL_SDF`, `SOURCE_URL_PAR` | FDOR 2026P Duval files | Override when FDOR rolls the year |
| `GEOMETRY_LIMIT` | unset | Dev only: load the first N shapes |
| `ALLOW_NEW_COLUMNS` | unset | Downgrade "new source column" drift from fatal to a recorded limitation |
| `LOG_LEVEL` | `info` | JSON-lines log level |

No secrets are read anywhere except `publish/filebase.ts`; nothing prints them.

## What a run does

1. `run_id` (ULID) + `run_log` row (`running`); any earlier `running` row left by a dead process is closed as `aborted`.
2. Per track: HEAD the source; skip the download when the ETag (or Last-Modified + size when no ETag) matches the sidecar; otherwise stream to `<file>.part` with sha256, rename. Extract (CSV) or read in place (`/vsizip/` for the shapefile).
3. Header check against the expected layout: missing columns fail the run; new columns fail unless `ALLOW_NEW_COLUMNS=1` (then recorded as a limitation).
4. Stage into `staging.<table>`, add `row_hash = md5(to_json(row))` + provenance, MERGE into the target: `inserted` / `updated` (hash differs) / `unchanged` (provenance kept) / `missing_in_source` (kept, counted). Duplicate or NULL natural keys in staging abort the merge.
5. `derived.properties_features` (one row per parcel), `query-table.parquet`, the validation gate (rows == distinct folio in `parcels`, 0 null, 0 dup, canonical columns present, per-column coverage printed), entity parquet tables, `dataset-coverage.json`, `run-history.json` (all runs), `runs/<run_id>.json` (committed by CI).
6. `publish` (separate command, dry-run by default) computes CIDs locally with `ipfs-only-hash` (same defaults as the Elephant reference uploaders; CIDv1 rendering also shown), PUTs to Filebase, checks `x-amz-meta-cid`, upserts IPNS labels, writes `published-counties.json`, `artifacts-index.json`, `publish-manifest.json`.

### Provenance

Every entity table carries `row_hash, source_system, source_url, source_artifact, source_sha256, fetched_at, run_id`.
`source_artifact` is the path under `DATA_DIR/artifacts/` and `source_sha256` the hash of that exact file, so any row can be traced to the bytes it came from. `run_log_sources` records per run and per source: artifact ETag / Last-Modified / bytes / sha256, download status, rows staged, inserted / updated / unchanged / missing, table total, delta vs the previous completed run, limitations and errors.

## Tables (DuckDB, `DATA_DIR/duval.duckdb`)

`parcels` (NAL roll, 1 row per PARCEL_ID, ~100 curated columns + centroid), `parcel_geometry` (PAR centroid lat/lon, area, bbox), `sales_history` (SDF + NAL SALE_*1/2, deduped by parcel+year+month+book/page/clerk+price), `permits`, `contractors`, `businesses`, `places`, `transit_stops`, `water_bodies`, `address_points`, `entity_links` (schema ready; tracks not yet wired are recorded as skipped), `run_log`, `run_log_sources`, `derived.properties_features`, `derived.parcel_distances`, `derived.dor_use_codes`, `staging.*`.

Current load (2026-08-21, FDOR 2026 Preliminary): parcels 404,023 (0 dup / 0 null), parcel_geometry 405,716 shapes, 403,813 parcels with coordinates (99.95 %), sales_history 64,532.

## Query table

`DATA_DIR/artifacts/publish/duval/query-table.parquet`: the 37 canonical columns from
`elephant-query-db` (`property_id ... hoa_flag`, in that order) followed by Duval extras:
`dor_uc, pa_uc, eff_year_built, taxable_value, assessed_value_school, homestead_flag, building_count,
residential_units, legal_description, neighborhood_code, census_block, owner_mailing_*, owner_region_class,
last_sale_source/qual_cd/or_book/or_page, sale_count, years_since_last_sale, last_roof_permit_year/date,
roof_year_est, roof_age_basis, roof_age_years, water_view_flag, water_dist_m, water_basis,
nearest_transit_stop_m/id/name, nearest_starbucks_m/id/name, coordinates_source, source_artifact,
source_sha256, source_fetched_at, source_run_id, features_run_id, features_as_of`.

Rules (TS and SQL twins in `src/features/rules.ts`, both tested):

- `owner_region_class`: LOCAL = mailing state FL and ZIP5 in the Duval set (32099, 32201-32258 except 32259, 32260, 32266, 32277; city-name fallback when no ZIP); REGIONAL = FL outside Duval, GA, SC, AL; NATIONAL = other US state/territory/military code; FOREIGN = non-US code; NULL = no mailing state.
- `years_since_last_sale` = floor((as_of - last sale date) / 365.25 d), last sale = latest `sales_history` row.
- `roof_year_est` / `roof_age_basis`: `PERMIT` (latest re-roof permit year, once permits load) else `EFF_YR_BLT_PROXY` else `ACT_YR_BLT_PROXY`.
- `owner_occupied` = mailing line 1 + ZIP5 equal the situs line 1 + ZIP5.
- `assessed_value` = `AV_NSD` (county assessed), `market_value` = `JV`, `land_value` = `LND_VAL`, `lot_size_acre` = `LND_SQFOOT / 43560`.
- Columns whose source is not loaded are NULL, never false / 0 (`has_permits`, `permit_count`, `has_sunbiz_tenant`, `nearest_*`, `water_*`).
- `property_cid` is NULL until the per-property consolidation publish exists (separate story).

## Proxy vs evidence (what the six demo questions rest on today)

| Question | Today | Basis | Honest gap |
|---|---|---|---|
| Roof older than 15 years | `roof_age_years > 15`, basis `EFF_YR_BLT_PROXY` | NAL effective/actual year built | No re-roof permits yet (JaxEPICS track); effective year is a proxy, labelled as such |
| Water view | NULL | none loaded | Water track (COJ river polygons + NHD) not wired; will be a proximity proxy (<= 150 m), labelled |
| No ownership change in 10+ years | `years_since_last_sale` known for 51,022 parcels (12.6 %) | SDF 2026P + NAL SALE_*1/2 | FDOR 2026P carries only 2025-2026 sales; parcels with no recent sale are "no sale on record in the roll", not "10+ years"; needs the COJ parcels layer (SALESL* date, US egress) or PA monthly sales |
| Regional owners | `owner_region_class` for 99.8 % | NAL mailing address | Foreign owners are under-detected (NAL often leaves OWN_STATE blank for them) |
| Walking distance to transit | NULL | none loaded | JTA GTFS track not wired |
| Walking distance to Starbucks | NULL | none loaded | Overture places track not wired |

## Sources and limitations (recorded per run in `run_log_sources.limitations`)

| Track | Source | Status | Limitations |
|---|---|---|---|
| appraisal | FDOR NAL 2026P Duval (29 MB zip, 165 columns) | loaded | only the current roll is posted; no roof fields; sales limited to the roll's two most recent |
| sales | FDOR SDF 2026P Duval (1.1 MB zip) | loaded | year + month only; monthly PA sales files rotate GUID URLs and are US-egress only |
| geometry | FDOR PAR shapefile 2026 Duval (192 MB zip, EPSG:2881) | loaded | centroids, not rooftop points; 210 parcels without a shape |
| permits | JaxEPICS `Permit/View/{no}` | not wired | no open dataset; login for search; US egress; enumerate numbers at concurrency 2 |
| contractors | DBPR CILB extracts | not wired | Cloudflare JS challenge (headless browser); BBB excluded (terms forbid aggregation) |
| businesses | Sunbiz SFTP daily files | not wired | no county filter; 1,440-char fixed records; trust host key |
| places | Overture Maps places | not wired | name-based brand match |
| transit | JTA GTFS | not wired | irregular releases; no GTFS-RT |
| water | COJ river polygons + NHD | not wired | proximity proxy, not a sightline |
| addresses | COJ address points | not wired | US egress only |

Geo-blocking: every `*.coj.net` / `jacksonville.gov` host refuses non-US and cloud IPs; FDOR and the
Overture/JTA/ArcGIS hosted services do not. The workflow prints its egress country each run.

## Cost model ($0 standing)

- Compute: GitHub Actions (free minutes; a warm run is ~1 min, a cold run ~12 min dominated by the 192 MB shapefile, which the cache keeps between runs).
- Storage: Filebase free tier (5 GB / 1,000 pins) holds the ~100 MB artifact set with room for history; IPFS gateways serve reads; IPNS names are free.
- Database: a DuckDB file, rebuilt or restored from cache; published parquet is the portable copy (DuckDB / DuckDB-WASM read it straight from the gateway with range requests).
- Nothing runs when nobody runs it. No AWS, no Neon, no Restate.

## Engineering notes

TypeScript / Node 22 / ESM, `@duckdb/node-api`, `@aws-sdk/client-s3` (Filebase), `ipfs-only-hash` + `multiformats`, zod, vitest, tsx. Structured JSON logs (`src/log.ts`). Deviations from the team Golden Path: no CDK / Glue / PySpark because the requirement is zero standing infrastructure (Actions + DuckDB + IPFS); no PagerDuty (a failed run fails the workflow and is visible in `run_log` / run history).
