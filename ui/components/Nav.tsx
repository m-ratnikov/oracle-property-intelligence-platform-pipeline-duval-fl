"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { config } from "@/lib/config";

const LINKS = [
  { href: "/", label: "Overview" },
  { href: "/runs", label: "Runs" },
  { href: "/data", label: "Data" },
  { href: "/query", label: "Query" },
  { href: "/questions", label: "Questions" },
  { href: "/agent", label: "Agent" },
  { href: "/mcp", label: "MCP" },
];

export function Nav() {
  const pathname = usePathname();

  return (
    <header className="sticky top-0 z-30 border-b border-border bg-surface/95 backdrop-blur">
      <div className="mx-auto flex w-full max-w-[1400px] flex-wrap items-center gap-x-5 gap-y-2 px-4 py-2.5 md:px-6">
        <Link href="/" className="flex items-baseline gap-2 !text-text hover:!no-underline">
          <span className="text-[15px] font-semibold tracking-tight">
            {config.countyName} County
          </span>
          <span className="text-xs text-muted">property intelligence</span>
        </Link>

        <nav className="flex flex-wrap items-center gap-1">
          {LINKS.map((link) => {
            const active =
              link.href === "/" ? pathname === "/" : pathname.startsWith(link.href);
            return (
              <Link
                key={link.href}
                href={link.href}
                aria-current={active ? "page" : undefined}
                className={
                  active
                    ? "rounded bg-accent-soft px-2 py-1 text-[13px] font-medium !text-accent hover:!no-underline"
                    : "rounded px-2 py-1 text-[13px] !text-muted hover:bg-sunken hover:!text-text hover:!no-underline"
                }
              >
                {link.label}
              </Link>
            );
          })}
        </nav>
      </div>
    </header>
  );
}
