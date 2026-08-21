/**
 * Shapes of the published JSON artifacts, plus lenient parsers.
 *
 * The pipeline and the UI ship separately, so every parser here is deliberately
 * forgiving: unknown fields are kept in `extra`, missing fields become null, and
 * a shape we do not recognise degrades to an empty collection rather than
 * throwing. The UI renders what exists and says "not available" for the rest.
 */

export interface RunSource {
  source: string;
  rows_fetched: number | null;
  inserted: number | null;
  updated: number | null;
  unchanged: number | null;
  delta_vs_previous: number | null;
  artifact_sha256: string | null;
  source_url: string | null;
  limitations: string[];
}

export interface RunArtifact {
  name: string;
  cid: string | null;
  ipns_label: string | null;
  ipns_name: string | null;
  gateway_url: string | null;
}

export interface PipelineRun {
  run_id: string;
  started_at: string | null;
  finished_at: string | null;
  trigger: string | null;
  git_sha: string | null;
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
  ingested_count: number | null;
  expected_count: number | null;
  first_loaded_at: string | null;
  last_loaded_at: string | null;
  cid: string | null;
  ipns_label: string | null;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function str(value: unknown): string | null {
  if (typeof value === "string") return value.length > 0 ? value : null;
  if (typeof value === "number" || typeof value === "bigint") return String(value);
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

function strList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => str(item)).filter((item): item is string => item !== null);
  }
  const single = str(value);
  return single ? [single] : [];
}

function rest(value: Record<string, unknown>, known: Set<string>): Record<string, unknown> {
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
  "git_sha",
  "sources",
  "artifacts",
]);

export function parseRunHistory(input: unknown): RunHistory {
  if (!isRecord(input)) return { county: null, generatedAt: null, runs: [] };
  const runsRaw = Array.isArray(input.runs) ? input.runs : [];
  const runs: PipelineRun[] = runsRaw.filter(isRecord).map((run) => ({
    run_id: str(run.run_id) ?? "unknown",
    started_at: str(run.started_at),
    finished_at: str(run.finished_at),
    trigger: str(run.trigger),
    git_sha: str(run.git_sha),
    sources: (Array.isArray(run.sources) ? run.sources : []).filter(isRecord).map((source) => ({
      source: str(source.source) ?? "unknown",
      rows_fetched: num(source.rows_fetched),
      inserted: num(source.inserted),
      updated: num(source.updated),
      unchanged: num(source.unchanged),
      delta_vs_previous: num(source.delta_vs_previous),
      artifact_sha256: str(source.artifact_sha256),
      source_url: str(source.source_url),
      limitations: strList(source.limitations),
    })),
    artifacts: (Array.isArray(run.artifacts) ? run.artifacts : [])
      .filter(isRecord)
      .map((artifact) => ({
        name: str(artifact.name) ?? "artifact",
        cid: str(artifact.cid),
        ipns_label: str(artifact.ipns_label),
        ipns_name: str(artifact.ipns_name),
        gateway_url: str(artifact.gateway_url),
      })),
    extra: rest(run, KNOWN_RUN_KEYS),
  }));
  return {
    county: str(input.county),
    generatedAt: str(input.generatedAt) ?? str(input.generated_at),
    runs,
  };
}

const KNOWN_DATASET_KEYS = new Set([
  "county",
  "source",
  "ingested_count",
  "expected_count",
  "first_loaded_at",
  "last_loaded_at",
  "cid",
  "ipns_label",
]);

export function parseCoverage(input: unknown): CoverageSnapshot {
  if (!isRecord(input)) return { county: null, exportedAt: null, datasets: [] };
  const datasets = (Array.isArray(input.datasets) ? input.datasets : [])
    .filter(isRecord)
    .map((dataset) => ({
      county: str(dataset.county),
      source: str(dataset.source) ?? "unknown",
      ingested_count: num(dataset.ingested_count),
      expected_count: num(dataset.expected_count),
      first_loaded_at: str(dataset.first_loaded_at),
      last_loaded_at: str(dataset.last_loaded_at),
      cid: str(dataset.cid),
      ipns_label: str(dataset.ipns_label),
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
  if (!isRecord(input)) return { schemaVersion: null, generatedAt: null, counties: [] };
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

export function parseOpenDataIndex(input: unknown): OpenDataIndex {
  if (!isRecord(input)) {
    return { county: null, generatedAt: null, totalProperties: null, shards: [], properties: {} };
  }
  const shards = (Array.isArray(input.shards) ? input.shards : [])
    .map((shard): OpenDataShard | null => {
      if (typeof shard === "string") return { shard };
      if (isRecord(shard)) {
        const name = str(shard.shard) ?? str(shard.name) ?? str(shard.file);
        if (!name) return null;
        return {
          shard: name,
          url: str(shard.url) ?? undefined,
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

/** Aggregate a run history into per source cumulative totals across runs. */
export function cumulativeBySource(
  runs: PipelineRun[],
): { source: string; points: { run_id: string; total: number }[] }[] {
  const ordered = [...runs].sort((a, b) => (a.started_at ?? "").localeCompare(b.started_at ?? ""));
  const sources = new Set<string>();
  for (const run of ordered) for (const source of run.sources) sources.add(source.source);

  return [...sources].sort().map((source) => {
    let total = 0;
    const points = ordered.map((run) => {
      const entry = run.sources.find((item) => item.source === source);
      if (entry) {
        // Prefer an explicit cumulative signal, otherwise accumulate inserts.
        total += entry.inserted ?? entry.delta_vs_previous ?? 0;
      }
      return { run_id: run.run_id, total };
    });
    return { source, points };
  });
}

/** Latest run first. */
export function sortRunsDesc(runs: PipelineRun[]): PipelineRun[] {
  return [...runs].sort((a, b) => (b.started_at ?? "").localeCompare(a.started_at ?? ""));
}
