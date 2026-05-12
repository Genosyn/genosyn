import { ArrowRight } from "lucide-react";
import { Link } from "@/lib/router";
import { H2, P, PageHeader } from "@/docs/Prose";

export function NotFound() {
  return (
    <>
      <PageHeader
        eyebrow="404"
        title="That page doesn't exist."
        lead="The docs URL you followed isn't a page we ship. The link might be stale, or you may have typed the path by hand."
      />

      <H2 id="try">Try one of these</H2>
      <P>
        Most of what people land here looking for is one of these:
      </P>
      <ul className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-2">
        {[
          { href: "/docs", label: "Introduction" },
          { href: "/docs/install", label: "Install" },
          { href: "/docs/employees", label: "AI Employees" },
          { href: "/docs/routines", label: "Routines & Runs" },
        ].map((l) => (
          <li key={l.href}>
            <Link
              href={l.href}
              className="flex items-center justify-between rounded-xl border border-zinc-200 bg-white px-4 py-3 text-sm font-medium text-zinc-950 shadow-card transition hover:-translate-y-0.5 hover:border-zinc-300 hover:shadow-lift"
            >
              {l.label}
              <ArrowRight className="h-3.5 w-3.5 text-zinc-400" />
            </Link>
          </li>
        ))}
      </ul>
    </>
  );
}
