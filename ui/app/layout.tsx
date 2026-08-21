import type { Metadata } from "next";
import "./globals.css";
import { Nav } from "@/components/Nav";
import { SampleBanner } from "@/components/SampleBanner";
import { config } from "@/lib/config";

export const metadata: Metadata = {
  title: {
    default: `${config.countyName} County property intelligence`,
    template: `%s | ${config.countyName} property intelligence`,
  },
  description:
    "Explorer for the Duval County FL property intelligence dataset published on Elephant IPFS. Every query runs in your browser with DuckDB-WASM against the published parquet.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <SampleBanner />
        <Nav />
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
