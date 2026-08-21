import { z } from "zod";
import { COUNTY } from "../config.js";

// Copied from elephant-mcp src/types/publishedCountyCatalog.ts (consumer contract).
export const PublishedCountySchema = z.object({
  countyKey: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  countyName: z.string().min(1),
  stateCode: z.string().regex(/^[A-Z]{2}$/),
  countyFips: z.string().regex(/^\d{5}$/),
  status: z.literal("published"),
  queryTableUrl: z.string().url(),
  datasetCoverageUrl: z.string().url(),
  permitQueryTableUrl: z.string().url().nullable(),
  placesTableUrl: z.string().url().nullable(),
  updatedAt: z.string().datetime({ offset: true }),
});

export const PublishedCountyCatalogSchema = z.object({
  schemaVersion: z.literal("1.0"),
  generatedAt: z.string().datetime({ offset: true }),
  counties: z.array(PublishedCountySchema),
});

export type PublishedCountyCatalog = z.infer<typeof PublishedCountyCatalogSchema>;

export function buildCatalog(opts: {
  generatedAt: string;
  queryTableUrl: string;
  datasetCoverageUrl: string;
  permitQueryTableUrl?: string | null;
  placesTableUrl?: string | null;
}): PublishedCountyCatalog {
  return PublishedCountyCatalogSchema.parse({
    schemaVersion: "1.0",
    generatedAt: opts.generatedAt,
    counties: [
      {
        countyKey: COUNTY.key,
        countyName: COUNTY.name,
        stateCode: COUNTY.stateCode,
        countyFips: COUNTY.fips,
        status: "published",
        queryTableUrl: opts.queryTableUrl,
        datasetCoverageUrl: opts.datasetCoverageUrl,
        permitQueryTableUrl: opts.permitQueryTableUrl ?? null,
        placesTableUrl: opts.placesTableUrl ?? null,
        updatedAt: opts.generatedAt,
      },
    ],
  });
}
