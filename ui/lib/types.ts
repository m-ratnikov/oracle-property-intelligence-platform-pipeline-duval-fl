/**
 * Shapes of the published JSON artifacts, plus lenient parsers.
 *
 * The pipeline and the UI ship separately, so every parser here is deliberately
 * forgiving: unknown fields are kept in `extra`, missing fields become null, and
 * a shape we do not recognise degrades to an empty collection rather than
 * throwing. The UI renders what exists and says "not available" for the rest.
 */

import { durationMs, parseTimestamp } from "./format";

export interface RunSource {
  source: string;
  status: string | null;
  rows_fetched: number | null;
  inserted: number | null;
  updated: number | null;
  unchanged: number | null;
  /**
   * How the target table's own total moved against the previous recorded run of this
   * track. Not the same quantity as inserted + updated: a table written by more than one
   * track (sales_history, written by both `sales` and `pa_detail`) moves without this
   * track inserting anything.
   *
   * Null means UNKNOWN, never zero: the run record had no previous run of this track to compare
   * against. Nothing downstream may turn that into a number.
   */
  delta_vs_previous: number | null;
  /**
   * The table this track merges into, as the run record names it (`sales` -> `sales_history`).
   * Used to guard the join to the coverage snapshot's per table writer list; see lib/writers.ts.
   */
  target_table: string | null;
  /** Rows in the target table after this run's merge, which is the real table total. */
  table_total_after: number | null;
  artifact_sha256: string | null;
  source_url: string | null;
  limitations: string[];
}

export interface RunArtifact {
  name: string;
  /**
   * The published object name, exactly as the publish step names it: `query-table.parquet`,
   * `dataset-coverage.json`, `tables/parcels.parquet`. A run record carries it as `path`.
   *
   * This is the only field a run record and the published artifacts index have in common, so it
   * is the join key between the two. `name` above cannot be: for the object form it is the key
   * the run record filed the artifact under (`queryTable`, `tables.parcels`), which appears
   * nowhere in the index. Null when the run recorded an artifact with no path, which is how the
   * consolidation pass records its open data index; such an artifact simply has no join key and
   * is never reported as unpublished on that basis.
   */
  path: string | null;
  cid: string | null;
  ipns_label: string | null;
  ipns_name: string | null;
  gateway_url: string | null;
  /** Rows and bytes where the publisher recorded them, for the artifact card's subtitle. */
  rows: number | null;
  bytes: number | null;
}

/**
 * A consolidation pass is maintenance, not ingestion: it re-hashes the property records the
 * ingestion runs already loaded and republishes the changed ones to IPFS. It publishes real
 * evidence and belongs in the timeline, but it is not a data source and must never stand in
 * for the latest ingestion run.
 */
export type RunKind = "ingestion" | "consolidation";

export const CONSOLIDATION_TRACK = "consolidation";

export interface PipelineRun {
  run_id: string;
  started_at: string | null;
  finished_at: string | null;
  trigger: string | null;
  status: string | null;
  git_sha: string | null;
  tracks: string[];
  kind: RunKind;
  sources: RunSource[];
  artifacts: RunArtifact[];
  /** Anything the pipeline added that this UI does not model yet. */
  extra: Record<string, unknown>;
}

export interface RunHistory {
  county: string | null;
  generatedAt: string | null;
  runs: PipelineRun[];
}

export interface CoverageDataset {
  county: string | null;
  source: string;
  /**
   * The pipeline track that owns this dataset. Not always the same string as `source`: the
   * snapshot publishes `{ source: "hydrography", track: "water" }`, and a run record names its
   * sources by TRACK. Joining the two artifacts on `source` alone silently misses four of the
   * thirteen datasets.
   */
  track: string | null;
  /** The target table this dataset lands in. The published snapshot names it `table`. */
  table: string | null;
  ingested_count: number | null;
  expected_count: number | null;
  first_loaded_at: string | null;
  last_loaded_at: string | null;
  cid: string | null;
  ipns_label: string | null;
  /**
   * Present only for a dataset whose target table is written by more than one pipeline track. The
   * count above is scoped to the rows this source owns; these say how many rows the table holds in
   * total and which other sources contributed the rest. Older published snapshots omit them.
   */
  table_rows_total: number | null;
  rows_from_other_tracks: number | null;
  additional_rows_by_source: Record<string, number> | null;
  extra: Record<string, unknown>;
}

export interface CoverageSnapshot {
  county: string | null;
  exportedAt: string | null;
  datasets: CoverageDataset[];
}

export interface CatalogCounty {
  countyKey: string;
  countyName: string | null;
  stateCode: string | null;
  countyFips: string | null;
  status: string | null;
  queryTableUrl: string | null;
  datasetCoverageUrl: string | null;
  permitQueryTableUrl: string | null;
  placesTableUrl: string | null;
  updatedAt: string | null;
  extra: Record<string, unknown>;
}

export interface PublishedCatalog {
  schemaVersion: string | null;
  generatedAt: string | null;
  counties: CatalogCounty[];
}

export interface OpenDataShard {
  shard: string;
  url?: string;
  count?: number;
}

export interface OpenDataIndex {
  county: string | null;
  generatedAt: string | null;
  totalProperties: number | null;
  shards: OpenDataShard[];
  /** Some publishers inline a small id to cid map instead of sharding. */
  properties: Record<string, string>;
}

/* ---------------------------------------------------------------- helpers */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function str(value: unknown): string | null {
  if (typeof value === "string") return value.length > 0 ? value : null;
  if (typeof value === "number" || typeof value === "bigint")
    return String(value);
  return null;
}

export function num(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** A `{ name: count }` object as published, dropping any entry whose value is not a number. */
function numMap(value: unknown): Record<string, number> | null {
  if (!isRecord(value)) return null;
  const out: Record<string, number> = {};
  for (const [key, item] of Object.entries(value)) {
    const parsed = num(item);
    if (parsed !== null) out[key] = parsed;
  }
  return out;
}

function strList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map((item) => str(item))
      .filter((item): item is string => item !== null);
  }
  const single = str(value);
  return single ? [single] : [];
}

function rest(
  value: Record<string, unknown>,
  known: Set<string>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (!known.has(key)) out[key] = item;
  }
  return out;
}

const KNOWN_RUN_KEYS = new Set([
  "run_id",
  "started_at",
  "finished_at",
  "trigger",
  "status",
  "git_sha",
  "tracks",
  "sources",
  "artifacts",
]);

/**
 * The pipeline publishes `artifacts` as an object keyed by kind, not as a list:
 * `{ queryTable: {...}, tables: { parcels: {...}, ... }, coverage: {...}, egressCountry: "US" }`,
 * and the consolidation pass publishes `{ openData: { indexCid, manifestCid, ... }, queryTable }`.
 * Reading only the array form meant `artifacts` came back empty for every run, so the overview
 * page told a reader "the latest run published no artifact list" while the run record in front of
 * it carried a query-table CID, a CID per entity table and a coverage CID.
 *
 * Flattened one level, because `tables` is a map of artifacts rather than an artifact.
 */
function artifactFrom(name: string, value: unknown): RunArtifact | null {
  if (!isRecord(value)) return null;
  const cid = str(value.cid) ?? str(value.cidV1) ?? str(value.indexCid);
  const gateway = str(value.gateway_url) ?? str(value.gatewayUrl);
  const ipnsName = str(value.ipns_name) ?? str(value.ipnsName);
  if (cid === null && gateway === null && ipnsName === null) return null;
  return {
    name,
    path: str(value.path),
    cid,
    ipns_label: str(value.ipns_label) ?? str(value.ipnsLabel),
    ipns_name: ipnsName,
    gateway_url: gateway,
    rows: num(value.rows) ?? num(value.propertyCount),
    bytes: num(value.bytes) ?? num(value.totalBytes),
  };
}

function parseArtifacts(input: unknown): RunArtifact[] {
  if (Array.isArray(input)) {
    // In the array form the entry is already named by its published object name, so that name
    // doubles as the join key when the publisher did not also record an explicit path.
    return input.filter(isRecord).map((artifact) => ({
      name: str(artifact.name) ?? "artifact",
      path: str(artifact.path) ?? str(artifact.name),
      cid: str(artifact.cid),
      ipns_label: str(artifact.ipns_label),
      ipns_name: str(artifact.ipns_name),
      gateway_url: str(artifact.gateway_url),
      rows: num(artifact.rows),
      bytes: num(artifact.bytes),
    }));
  }
  if (!isRecord(input)) return [];
  const out: RunArtifact[] = [];
  for (const [key, value] of Object.entries(input)) {
    const direct = artifactFrom(key, value);
    if (direct !== null) {
      out.push(direct);
      continue;
    }
    // `tables` is a map of table name -> artifact. Nothing else nests.
    if (isRecord(value)) {
      for (const [nested, item] of Object.entries(value)) {
        const child = artifactFrom(`${key}.${nested}`, item);
        if (child !== null) out.push(child);
      }
    }
  }
  return out;
}

/**
 * The consolidation pass records a single source named `consolidation` and a trigger of the
 * same name. Either is enough; both are checked so a run published by an older or newer
 * pipeline still classifies.
 */
function runKind(
  trigger: string | null,
  tracks: string[],
  sources: RunSource[],
): RunKind {
  if (trigger === CONSOLIDATION_TRACK) return "consolidation";
  if (
    tracks.length > 0 &&
    tracks.every((track) => track === CONSOLIDATION_TRACK)
  ) {
    return "consolidation";
  }
  if (
    tracks.length === 0 &&
    sources.length > 0 &&
    sources.every((s) => s.source === CONSOLIDATION_TRACK)
  ) {
    return "consolidation";
  }
  return "ingestion";
}

/** Sum two optional counts, keeping null when neither side reported anything. */
function addOrNull(a: number | null, b: number | null): number | null {
  if (a === null && b === null) return null;
  return (a ?? 0) + (b ?? 0);
}

export function parseRunHistory(input: unknown): RunHistory {
  if (!isRecord(input)) return { county: null, generatedAt: null, runs: [] };
  const runsRaw = Array.isArray(input.runs) ? input.runs : [];
  const runs: PipelineRun[] = runsRaw.filter(isRecord).map((run) => {
    // The pipeline names these `track` and `rows_staged`; earlier field names are still accepted so
    // an older run-history.json keeps rendering. Reading only the old names made every row on the
    // runs page say "unknown" with 0 fetched, on the page whose whole job is to evidence ingestion.
    const sources: RunSource[] = (Array.isArray(run.sources) ? run.sources : [])
      .filter(isRecord)
      .map((source) => ({
        source:
          str(source.track) ??
          str(source.source) ??
          str(source.source_system) ??
          "unknown",
        status: str(source.status),
        rows_fetched: num(source.rows_staged) ?? num(source.rows_fetched),
        inserted: num(source.inserted),
        updated: num(source.updated),
        unchanged: num(source.unchanged),
        // The pipeline publishes this as `delta_vs_prev_total`. Reading only the name this UI
        // invented meant the column always fell through to inserted + updated, so a header that
        // said "delta vs previous" showed the same number as the two columns beside it.
        // Presence, not nullishness. A published null is a claim - "this run did not measure a
        // delta" - and `??` cannot tell it apart from the key being absent, so the fallback used to
        // overwrite an explicit unknown with inserted + updated, which reads as 0 and asserts the
        // table did not move. Only a record that never carried either field gets the derived value.
        delta_vs_previous:
          "delta_vs_prev_total" in source || "delta_vs_previous" in source
            ? (num(source.delta_vs_prev_total) ?? num(source.delta_vs_previous))
            : addOrNull(num(source.inserted), num(source.updated)),
        target_table: str(source.target_table),
        table_total_after: num(source.table_total_after),
        artifact_sha256:
          str(source.source_sha256) ?? str(source.artifact_sha256),
        source_url: str(source.source_url),
        limitations: strList(source.limitations),
      }));
    const tracks = strList(run.tracks);
    const trigger = str(run.trigger);
    return {
      run_id: str(run.run_id) ?? "unknown",
      started_at: str(run.started_at),
      finished_at: str(run.finished_at),
      trigger,
      status: str(run.status),
      git_sha: str(run.git_sha),
      tracks,
      kind: runKind(trigger, tracks, sources),
      sources,
      artifacts: parseArtifacts(run.artifacts),
      extra: rest(run, KNOWN_RUN_KEYS),
    };
  });
  return {
    county: str(input.county),
    generatedAt: str(input.generatedAt) ?? str(input.generated_at),
    runs,
  };
}

const KNOWN_DATASET_KEYS = new Set([
  "county",
  "source",
  "track",
  "table",
  "ingested_count",
  "expected_count",
  "first_loaded_at",
  "last_loaded_at",
  "cid",
  "ipns_label",
  "table_rows_total",
  "rows_from_other_tracks",
  "additional_rows_by_source",
]);

export function parseCoverage(input: unknown): CoverageSnapshot {
  if (!isRecord(input)) return { county: null, exportedAt: null, datasets: [] };
  const datasets = (Array.isArray(input.datasets) ? input.datasets : [])
    .filter(isRecord)
    .map((dataset) => ({
      county: str(dataset.county),
      source: str(dataset.source) ?? "unknown",
      track: str(dataset.track),
      table: str(dataset.table) ?? str(dataset.target_table),
      ingested_count: num(dataset.ingested_count),
      expected_count: num(dataset.expected_count),
      first_loaded_at: str(dataset.first_loaded_at),
      last_loaded_at: str(dataset.last_loaded_at),
      cid: str(dataset.cid),
      ipns_label: str(dataset.ipns_label),
      table_rows_total: num(dataset.table_rows_total),
      rows_from_other_tracks: num(dataset.rows_from_other_tracks),
      additional_rows_by_source: numMap(dataset.additional_rows_by_source),
      extra: rest(dataset, KNOWN_DATASET_KEYS),
    }));
  return {
    county: str(input.county),
    exportedAt: str(input.exportedAt) ?? str(input.exported_at),
    datasets,
  };
}

const KNOWN_COUNTY_KEYS = new Set([
  "countyKey",
  "countyName",
  "stateCode",
  "countyFips",
  "status",
  "queryTableUrl",
  "datasetCoverageUrl",
  "permitQueryTableUrl",
  "placesTableUrl",
  "updatedAt",
]);

export function parseCatalog(input: unknown): PublishedCatalog {
  if (!isRecord(input))
    return { schemaVersion: null, generatedAt: null, counties: [] };
  const counties = (Array.isArray(input.counties) ? input.counties : [])
    .filter(isRecord)
    .map((county) => ({
      countyKey: str(county.countyKey) ?? "unknown",
      countyName: str(county.countyName),
      stateCode: str(county.stateCode),
      countyFips: str(county.countyFips),
      status: str(county.status),
      queryTableUrl: str(county.queryTableUrl),
      datasetCoverageUrl: str(county.datasetCoverageUrl),
      permitQueryTableUrl: str(county.permitQueryTableUrl),
      placesTableUrl: str(county.placesTableUrl),
      updatedAt: str(county.updatedAt),
      extra: rest(county, KNOWN_COUNTY_KEYS),
    }));
  return {
    schemaVersion: str(input.schemaVersion),
    generatedAt: str(input.generatedAt),
    counties,
  };
}

/**
 * A content-addressed object on the public gateway.
 *
 * Kept here rather than imported from lib/openData so this module stays free of
 * a client-only dependency; the two agree on the shape, which is the one the
 * pipeline publishes: no extension, because `/ipfs/<cid>.json` is a different
 * path and answers 400.
 */
function ipfsObjectUrl(cid: string): string {
  const gateway = (
    process.env.NEXT_PUBLIC_IPFS_GATEWAY ?? "https://ipfs.filebase.io"
  ).replace(/\/+$/, "");
  return `${gateway}/ipfs/${cid}`;
}

export function parseOpenDataIndex(input: unknown): OpenDataIndex {
  if (!isRecord(input)) {
    return {
      county: null,
      generatedAt: null,
      totalProperties: null,
      shards: [],
      properties: {},
    };
  }
  const shards = (Array.isArray(input.shards) ? input.shards : [])
    .map((shard): OpenDataShard | null => {
      if (typeof shard === "string") return { shard };
      if (isRecord(shard)) {
        // The published index identifies a shard by CID rather than by
        // filename, because the objects are content-addressed and there is no
        // directory to name a file inside. A bucket-style publish names files.
        // Accept both: the CID becomes a gateway URL, the name a path.
        const cid = str(shard.shardCid) ?? str(shard.cid);
        const name = str(shard.shard) ?? str(shard.name) ?? str(shard.file);
        if (!name && !cid) return null;
        return {
          shard: name ?? `${cid}`,
          url: str(shard.url) ?? (cid ? ipfsObjectUrl(cid) : undefined),
          count: num(shard.count) ?? undefined,
        };
      }
      return null;
    })
    .filter((shard): shard is OpenDataShard => shard !== null);

  const properties: Record<string, string> = {};
  if (isRecord(input.properties)) {
    for (const [key, value] of Object.entries(input.properties)) {
      const cid = str(value);
      if (cid) properties[key] = cid;
    }
  }

  return {
    county: str(input.county),
    generatedAt: str(input.generatedAt),
    totalProperties: num(input.totalProperties) ?? num(input.total_properties),
    shards,
    properties,
  };
}

/** Latest run first. */
export function sortRunsDesc(runs: PipelineRun[]): PipelineRun[] {
  return [...runs].sort((a, b) =>
    (b.started_at ?? "").localeCompare(a.started_at ?? ""),
  );
}

/**
 * The newest run that actually ingested sources.
 *
 * The consolidation pass runs right after each ingestion run, so it is almost always the
 * newest entry in the history. Taking `runs[0]` as "the latest run" therefore described the
 * whole dataset with one synthetic row: "across 1 sources", a totals table holding only
 * `consolidation`, and no per source deltas at all. Consolidation evidence is real and is
 * surfaced separately; it just never stands in for an ingestion run.
 */
export function latestIngestionRun(runs: PipelineRun[]): PipelineRun | null {
  return sortRunsDesc(runs).find((run) => run.kind === "ingestion") ?? null;
}

/** The newest consolidation pass, whose artifacts are the published open-data index. */
export function latestConsolidationRun(
  runs: PipelineRun[],
): PipelineRun | null {
  return sortRunsDesc(runs).find((run) => run.kind === "consolidation") ?? null;
}

/** Source names that are real data sources. Excludes the consolidation maintenance track. */
export function ingestionSourceNames(runs: PipelineRun[]): string[] {
  const names = new Set<string>();
  for (const run of runs) {
    if (run.kind === "consolidation") continue;
    for (const source of run.sources) {
      if (source.source !== CONSOLIDATION_TRACK) names.add(source.source);
    }
  }
  return [...names].sort();
}

/**
 * Distinct `source: limitation` pairs.
 *
 * Summing `limitations.length` over every run counted the same two `sales` caveats once per
 * run, so one standing constraint observed across fourteen runs read as fourteen problems.
 * A limitation is a property of a source, not an event.
 */
export function distinctLimitations(
  runs: PipelineRun[],
): { source: string; limitation: string }[] {
  const seen = new Map<string, { source: string; limitation: string }>();
  for (const run of runs) {
    for (const source of run.sources) {
      for (const limitation of source.limitations) {
        seen.set(`${source.source}\u0000${limitation}`, {
          source: source.source,
          limitation,
        });
      }
    }
  }
  return [...seen.values()].sort(
    (a, b) =>
      a.source.localeCompare(b.source) ||
      a.limitation.localeCompare(b.limitation),
  );
}

/** One row of the run-by-run table, and one mark on each chart. */
export interface RunSummary {
  run: PipelineRun;
  run_id: string;
  kind: RunKind;
  startedMs: number | null;
  durationMs: number | null;
  trackCount: number;
  sourcesCompleted: number;
  sourcesSkipped: number;
  sourcesFailed: number;
  /**
   * Rows this run read out of its sources and checked against what is already stored. This is
   * the corpus each run re-verifies, and it is the number that stays flat while the pipeline
   * proves it is incremental.
   */
  rowsVerified: number;
  rowsInserted: number;
  rowsUpdated: number;
  /** Rows the run actually had to write: inserted plus updated. */
  rowsWritten: number;
  /** Movement in the target tables' own totals, summed across the run's sources. */
  tableDelta: number | null;
  artifactCount: number;
  limitationCount: number;
}

function sumOrNull(values: (number | null)[]): number | null {
  const present = values.filter((value): value is number => value !== null);
  return present.length === 0
    ? null
    : present.reduce((sum, value) => sum + value, 0);
}

/**
 * The run's own table movement: the sum of its sources' deltas.
 *
 * A source whose delta is unknown BUT which did record a table total makes the sum unknown. Adding
 * it as zero would publish a run total nobody measured, on the one row of the page that is supposed
 * to total the movement. A source with no table total at all never got as far as a merge (a skipped
 * or failed track), so it moved nothing, contributes nothing, and does not make the run unknown,
 * which is the case most runs in the published history are in.
 */
function runTableDelta(sources: RunSource[]): number | null {
  const unknown = sources.some(
    (s) => s.delta_vs_previous === null && s.table_total_after !== null,
  );
  return unknown ? null : sumOrNull(sources.map((s) => s.delta_vs_previous));
}

export function summariseRun(run: PipelineRun): RunSummary {
  const started = parseTimestamp(run.started_at);
  const rowsInserted = run.sources.reduce(
    (sum, s) => sum + (s.inserted ?? 0),
    0,
  );
  const rowsUpdated = run.sources.reduce((sum, s) => sum + (s.updated ?? 0), 0);
  const statusOf = (source: RunSource) => source.status ?? "completed";
  return {
    run,
    run_id: run.run_id,
    kind: run.kind,
    startedMs: started === null ? null : started.getTime(),
    durationMs: durationMs(run.started_at, run.finished_at),
    trackCount: run.tracks.length > 0 ? run.tracks.length : run.sources.length,
    sourcesCompleted: run.sources.filter((s) => statusOf(s) === "completed")
      .length,
    sourcesSkipped: run.sources.filter((s) => statusOf(s) === "skipped").length,
    sourcesFailed: run.sources.filter((s) => statusOf(s) === "failed").length,
    rowsVerified: run.sources.reduce(
      (sum, s) => sum + (s.rows_fetched ?? 0),
      0,
    ),
    rowsInserted,
    rowsUpdated,
    rowsWritten: rowsInserted + rowsUpdated,
    tableDelta: runTableDelta(run.sources),
    artifactCount: run.artifacts.length,
    limitationCount: run.sources.reduce(
      (sum, s) => sum + s.limitations.length,
      0,
    ),
  };
}

/** Newest first, which is the order the run table renders in. */
export function summariseRuns(runs: PipelineRun[]): RunSummary[] {
  return sortRunsDesc(runs).map(summariseRun);
}
