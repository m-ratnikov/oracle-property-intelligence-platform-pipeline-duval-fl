import type { Metadata } from "next";
import "./globals.css";
import { Nav } from "@/components/Nav";
import { ResizableColumns } from "@/components/ResizableColumns";
import { SampleBanner } from "@/components/SampleBanner";
import { artifactOrigins, config } from "@/lib/config";

export const metadata: Metadata = {
  title: {
    default: `${config.countyName} County property intelligence`,
    template: `%s | ${config.countyName} property intelligence`,
  },
  description:
    "Explorer for the Duval County FL property intelligence dataset published on Elephant IPFS. Every query runs in your browser with DuckDB-WASM against the published parquet.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  /*
   * Every page reads its data from an IPFS gateway, and nothing can be fetched until DNS, TLS and
   * the connection are up. Opening them while the document is still parsing moves that setup off
   * the critical path of the first screen, which is a run summary with four stat tiles that stay
   * empty until the first artifact lands. React hoists these into <head>.
   */
  const origins = artifactOrigins();
  return (
    <html lang="en">
      <head>
        {origins.map((origin) => (
          <link key={`pre-${origin}`} rel="preconnect" href={origin} crossOrigin="anonymous" />
        ))}
        {origins.map((origin) => (
          <link key={`dns-${origin}`} rel="dns-prefetch" href={origin} />
        ))}
      </head>
      <body>
        <SampleBanner />
        <Nav />
        <ResizableColumns />
        <main className="mx-auto w-full max-w-[1400px] px-4 py-6 md:px-6">{children}</main>
        <footer className="mx-auto w-full max-w-[1400px] px-4 pb-10 pt-4 text-xs text-faint md:px-6">
          <div className="hairline pt-3">
            Data is read directly from the published artifacts. No application database, no query
            server. Built for the Oracle property intelligence pipeline assignment.
          </div>
        </footer>
      </body>
    </html>
  );
}
