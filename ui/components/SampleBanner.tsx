import { config } from "@/lib/config";

/**
 * When any artifact URL is missing the app reads public/sample instead. That has
 * to be impossible to miss: an ungated banner on every page, plus SAMPLE badges
 * on the individual panels.
 */
export function SampleBanner() {
  if (!config.isSample) return null;

  return (
    <div className="border-b border-warn/40 bg-warn-soft px-4 py-1.5 text-center text-[12px] text-warn md:px-6">
      <strong className="font-bold tracking-wide">SAMPLE DATA</strong>
      <span className="mx-2 opacity-60">|</span>
      These are synthetic records generated for local development, not Duval County records.
      Missing artifact URLs: <span className="mono">{config.sampleArtifacts.join(", ")}</span>. Set
      the <span className="mono">NEXT_PUBLIC_*_URL</span> variables to read published data.
    </div>
  );
}

/** Inline badge for a single panel that is showing synthetic data. */
export function SampleBadge({ when = config.isSample }: { when?: boolean }) {
  if (!when) return null;
  return <span className="badge badge-warn">sample</span>;
}
