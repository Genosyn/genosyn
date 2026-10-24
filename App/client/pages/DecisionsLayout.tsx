import React from "react";
import { Outlet } from "react-router-dom";
import { ContextualLayout } from "@/components/AppShell";
import { useLiveRefetch } from "@/components/CompanySocket";
import { SectionRailHeader, SectionRailLinks } from "@/components/SectionRail";
import { api, type Company } from "@/lib/api";
import type { WaitingElsewhere } from "../../shared/navigation";

/** What the stack's pages read from their layout. */
export type DecisionsOutletContext = {
  /** What waits in the queues beside the stack; null until it has loaded. */
  waiting: WaitingElsewhere | null;
};

/**
 * Sidebar + layout for `/c/:slug/decisions/*` — the one place for everything
 * waiting on someone. The active stack holds the questions and the email and
 * work reviews; Approvals, Revisions, and Initiatives are the other queues of
 * the same kind, each on its own page with a count of what it holds; History
 * keeps what was settled, so the stack stays short enough to clear. Rail
 * links come from the subpage catalogue (`lib/subpages.ts`) the ⌘K palette
 * searches.
 */
export default function DecisionsLayout({ company }: { company: Company }) {
  const [waiting, setWaiting] = React.useState<WaitingElsewhere | null>(null);
  const latest = React.useRef(0);
  const reload = React.useCallback(() => {
    const request = ++latest.current;
    api
      .get<WaitingElsewhere>(`/api/companies/${company.id}/navigation/waiting`)
      .then((body) => {
        if (request === latest.current) setWaiting(body);
      })
      .catch(() => {
        // Counts are a convenience beside links that work without them; a
        // failed read leaves the last ones (or none) rather than an error.
      });
  }, [company.id]);

  React.useEffect(() => {
    setWaiting(null);
    reload();
  }, [reload]);
  useLiveRefetch(["approval", "revision", "initiative", "todo", "finance", "decision"], reload);

  const counts = {
    "/decisions/approvals": waiting?.approvals,
    "/decisions/revisions": waiting?.revisions,
    "/decisions/initiatives": waiting?.initiatives,
  };

  const slug = company.slug;
  const sidebar = (
    <div className="flex h-full flex-col">
      <SectionRailHeader section="decisions" label="Decision stack" />
      <nav className="flex-1 space-y-0.5 overflow-y-auto p-2">
        <SectionRailLinks section="decisions" companySlug={slug} viewer={company} counts={counts} />
      </nav>
    </div>
  );

  return (
    <ContextualLayout sidebar={sidebar}>
      <Outlet context={{ waiting } satisfies DecisionsOutletContext} />
    </ContextualLayout>
  );
}
