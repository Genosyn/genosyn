import React from "react";
import { Outlet } from "react-router-dom";
import { FolderLock } from "lucide-react";

import { ContextualLayout, SidebarLink } from "@/components/AppShell";
import { useLiveRefetch } from "@/components/CompanySocket";
import {
  SectionRailHeader,
  SectionRailLinks,
  railHeadingClassName,
} from "@/components/SectionRail";
import { CountBadge } from "@/components/ui/Badge";
import type { Company } from "@/lib/api";
import { dataRoomsApi, type DataRoom } from "@/lib/dataRooms";
import { canOpenSection } from "@/lib/sectionVisibility";

export type DataRoomsOutletContext = {
  company: Company;
  /** Every room, newest activity first; null while loading. */
  rooms: DataRoom[] | null;
  reloadRooms: () => Promise<void>;
};

/**
 * Rail links come from the subpage catalogue (`lib/subpages.ts`) the ⌘K
 * palette searches; the rooms below them are the company's own, each with
 * the guests' questions still waiting on it.
 */
export default function DataRoomsLayout({ company }: { company: Company }) {
  const allowed = canOpenSection("dataRooms", company);
  const [rooms, setRooms] = React.useState<DataRoom[] | null>(null);

  const reloadRooms = React.useCallback(async () => {
    if (!allowed) return;
    try {
      setRooms((await dataRoomsApi(company.id).list()).rooms);
    } catch {
      // The pages show their own errors; the rail just keeps what it had.
      setRooms((current) => current ?? []);
    }
  }, [allowed, company.id]);

  React.useEffect(() => {
    void reloadRooms();
  }, [reloadRooms]);
  useLiveRefetch(["data_room", "data_room_question", "data_room_guest"], () => void reloadRooms());

  const open = (rooms ?? []).filter((room) => room.status === "open");
  const sidebar = (
    <div className="flex h-full flex-col">
      <SectionRailHeader section="dataRooms" />
      <nav className="flex-1 space-y-0.5 overflow-y-auto p-2">
        <SectionRailLinks section="dataRooms" companySlug={company.slug} viewer={company} />
        {allowed && open.length > 0 && (
          <>
            <div className={`px-2 pb-1 pt-3 ${railHeadingClassName}`}>Open rooms</div>
            {open.map((room) => (
              <SidebarLink
                key={room.id}
                to={`/c/${company.slug}/data-rooms/${room.id}`}
                icon={<FolderLock size={14} />}
                label={
                  <span className="flex items-center justify-between gap-2">
                    <span className="truncate">{room.name}</span>
                    {room.counts?.openQuestions ? (
                      <CountBadge
                        count={room.counts.openQuestions}
                        tone="accent"
                        aria-label={`${room.counts.openQuestions} questions waiting`}
                      />
                    ) : null}
                  </span>
                }
              />
            ))}
          </>
        )}
      </nav>
      <div className="border-t border-slate-100 p-3 text-xs leading-5 text-slate-500 dark:border-slate-800 dark:text-slate-400">
        Every guest opens a room through their own link. What they read and ask is recorded here.
      </div>
    </div>
  );

  return (
    <ContextualLayout sidebar={sidebar}>
      <Outlet context={{ company, rooms, reloadRooms } satisfies DataRoomsOutletContext} />
    </ContextualLayout>
  );
}
