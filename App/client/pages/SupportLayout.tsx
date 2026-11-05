import React from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import {
  AlarmClock,
  Bot,
  CheckCircle2,
  Clock,
  Hourglass,
  Inbox,
  LayoutList,
  Mailbox,
  ShieldOff,
  Sparkles,
  UserCircle2,
  UserX,
} from "lucide-react";

import { ContextualLayout, sidebarLinkClassName } from "@/components/AppShell";
import { useLiveRefetch } from "@/components/CompanySocket";
import {
  SectionRailHeader,
  SectionRailLinks,
  railHeadingClassName,
} from "@/components/SectionRail";
import { CountBadge } from "@/components/ui/Badge";
import type { Company } from "@/lib/api";
import { supportApi, type SupportCounts, type SupportInbox } from "@/lib/support";
import { SUPPORT_VIEW_LABELS, type SupportTopic, type SupportView } from "../../shared/support";

export type SupportOutletContext = {
  company: Company;
  /** Every Support inbox; null while loading. */
  inboxes: SupportInbox[] | null;
  topics: SupportTopic[];
  counts: SupportCounts;
  /** Where published Articles are public, while the help center is on. */
  helpCenterUrl: string | null;
  reload: () => Promise<void>;
};

const VIEW_ICONS: Partial<Record<SupportView, React.ReactNode>> = {
  inbox: <Inbox size={14} />,
  mine: <UserCircle2 size={14} />,
  unassigned: <UserX size={14} />,
  review: <Sparkles size={14} />,
  ai: <Bot size={14} />,
  at_risk: <AlarmClock size={14} />,
  waiting: <Hourglass size={14} />,
  snoozed: <Clock size={14} />,
  solved: <CheckCircle2 size={14} />,
  spam: <ShieldOff size={14} />,
  all: <LayoutList size={14} />,
};

/** Queues someone works through, and the ones they look something up in. */
const WORK_VIEWS: SupportView[] = ["inbox", "mine", "unassigned", "review", "at_risk"];
const STATE_VIEWS: SupportView[] = ["ai", "waiting", "snoozed", "solved", "all", "spam"];

function ViewLink({
  slug,
  view,
  count,
  tone,
}: {
  slug: string;
  view: SupportView;
  count?: number;
  tone?: "accent" | "danger";
}) {
  const location = useLocation();
  const params = new URLSearchParams(location.search);
  const here = location.pathname === `/c/${slug}/support`;
  const active = here && (params.get("view") ?? "inbox") === view && !params.get("inbox");
  return (
    <NavLink
      to={view === "inbox" ? `/c/${slug}/support` : `/c/${slug}/support?view=${view}`}
      end
      className={() => sidebarLinkClassName(active)}
    >
      {VIEW_ICONS[view]}
      <span className="min-w-0 flex-1 truncate">{SUPPORT_VIEW_LABELS[view]}</span>
      {count ? (
        <CountBadge
          count={count}
          tone={tone === "danger" ? "danger" : active ? "accent" : "neutral"}
          aria-label={`${count} tickets`}
        />
      ) : null}
    </NavLink>
  );
}

/**
 * The queues are the section: the rail leads with what is waiting, counted by the
 * server by the same rules as the lists they open, then the Support inboxes, then
 * the pages catalogued for the ⌘K palette.
 */
export default function SupportLayout({ company }: { company: Company }) {
  const [inboxes, setInboxes] = React.useState<SupportInbox[] | null>(null);
  const [topics, setTopics] = React.useState<SupportTopic[]>([]);
  const [counts, setCounts] = React.useState<SupportCounts>({});
  const [helpCenterUrl, setHelpCenterUrl] = React.useState<string | null>(null);
  const location = useLocation();
  const activeInbox = new URLSearchParams(location.search).get("inbox");

  const api = React.useMemo(() => supportApi(company.id), [company.id]);

  const reload = React.useCallback(async () => {
    try {
      const [inboxResult, settingsResult, countResult] = await Promise.all([
        api.inboxes(),
        api.settings(),
        api.counts(),
      ]);
      setInboxes(inboxResult.inboxes);
      setTopics(settingsResult.settings.topics);
      setHelpCenterUrl(
        settingsResult.settings.helpCenterEnabled ? settingsResult.settings.helpCenterUrl : null,
      );
      setCounts(countResult.counts);
    } catch {
      // The pages show their own errors; the rail keeps what it had.
      setInboxes((current) => current ?? []);
    }
  }, [api]);

  React.useEffect(() => {
    void reload();
  }, [reload]);
  useLiveRefetch(["support_ticket", "support_inbox", "support_settings"], () => void reload());

  const sidebar = (
    <div className="flex h-full flex-col">
      <SectionRailHeader section="support" />
      <nav className="flex-1 space-y-0.5 overflow-y-auto p-2" aria-label="Support">
        {WORK_VIEWS.map((view) => (
          <ViewLink
            key={view}
            slug={company.slug}
            view={view}
            count={counts[view]}
            tone={view === "at_risk" ? "danger" : "accent"}
          />
        ))}
        <div className={`px-2 pb-1 pt-3 ${railHeadingClassName}`}>By status</div>
        {STATE_VIEWS.map((view) => (
          <ViewLink key={view} slug={company.slug} view={view} count={counts[view]} />
        ))}
        {inboxes && inboxes.length > 1 && (
          <>
            <div className={`px-2 pb-1 pt-3 ${railHeadingClassName}`}>Support inboxes</div>
            {inboxes.map((inbox) => (
              <NavLink
                key={inbox.id}
                to={`/c/${company.slug}/support?inbox=${inbox.id}`}
                end
                className={() => sidebarLinkClassName(activeInbox === inbox.id)}
              >
                <Mailbox size={14} />
                <span className="min-w-0 flex-1 truncate">{inbox.name}</span>
                {inbox.openTickets ? (
                  <CountBadge
                    count={inbox.openTickets}
                    tone="neutral"
                    aria-label={`${inbox.openTickets} open tickets`}
                  />
                ) : null}
              </NavLink>
            ))}
          </>
        )}
        <div className={`px-2 pb-1 pt-3 ${railHeadingClassName}`}>Manage</div>
        <SectionRailLinks section="support" companySlug={company.slug} viewer={company} continued />
      </nav>
    </div>
  );

  return (
    <ContextualLayout sidebar={sidebar}>
      <Outlet
        context={
          { company, inboxes, topics, counts, helpCenterUrl, reload } satisfies SupportOutletContext
        }
      />
    </ContextualLayout>
  );
}
