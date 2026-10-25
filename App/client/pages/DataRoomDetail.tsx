import React from "react";
import { Link, useOutletContext, useParams, useSearchParams } from "react-router-dom";
import { Settings2, UserPlus } from "lucide-react";

import { useLiveRefetch } from "@/components/CompanySocket";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { PageHeader } from "@/components/ui/PageHeader";
import { Skeleton } from "@/components/ui/Skeleton";
import { clsx } from "@/components/ui/clsx";
import { dataRoomsApi, type DataRoomDetail as Detail } from "@/lib/dataRooms";
import { errorMessage } from "@/lib/errors";
import { canOpenSection } from "@/lib/sectionVisibility";
import type { DataRoomsOutletContext } from "./DataRoomsLayout";
import { RoomActivityTab } from "./dataRooms/Activity";
import { RoomDocumentsTab } from "./dataRooms/Documents";
import { RoomGuestsTab } from "./dataRooms/Guests";
import { RoomOverviewTab } from "./dataRooms/Overview";
import { RoomQuestionsTab } from "./dataRooms/Questions";
import { RoomSettingsTab } from "./dataRooms/Settings";
import {
  ModelMissingCallout,
  OwnersOnlyNote,
  PurposeBadge,
  RoomStatusBadge,
} from "./dataRooms/shared";

export type RoomTab = "overview" | "documents" | "guests" | "questions" | "activity" | "settings";

const TABS: Array<{ key: RoomTab; label: string }> = [
  { key: "overview", label: "Overview" },
  { key: "documents", label: "Documents" },
  { key: "guests", label: "Guests" },
  { key: "questions", label: "Questions" },
  { key: "activity", label: "Activity" },
  { key: "settings", label: "Settings" },
];

/** What every tab of a room gets. */
export type RoomTabProps = {
  companyId: string;
  companySlug: string;
  detail: Detail;
  reload: () => Promise<void>;
  setDetail: (detail: Detail) => void;
  goTo: (tab: RoomTab) => void;
};

export default function DataRoomDetail() {
  const { company, reloadRooms } = useOutletContext<DataRoomsOutletContext>();
  const { roomId = "" } = useParams<{ roomId: string }>();
  const [params, setParams] = useSearchParams();
  const tab = (
    TABS.some((item) => item.key === params.get("tab")) ? params.get("tab") : "overview"
  ) as RoomTab;
  const [detail, setDetail] = React.useState<Detail | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const allowed = canOpenSection("dataRooms", company);

  const reload = React.useCallback(async () => {
    if (!allowed) return;
    try {
      setDetail(await dataRoomsApi(company.id).get(roomId));
      setError(null);
    } catch (err) {
      setError(errorMessage(err, "Could not load the data room"));
    }
  }, [allowed, company.id, roomId]);

  React.useEffect(() => {
    setDetail(null);
    void reload();
  }, [reload]);
  useLiveRefetch(["data_room"], () => void reload(), roomId);

  const goTo = React.useCallback(
    (next: RoomTab) => {
      const nextParams = new URLSearchParams(params);
      if (next === "overview") nextParams.delete("tab");
      else nextParams.set("tab", next);
      setParams(nextParams, { replace: false });
    },
    [params, setParams],
  );

  if (!allowed) return <OwnersOnlyNote />;
  const base = `/c/${company.slug}/data-rooms`;

  if (error && !detail) {
    return (
      <div className="page-shell p-4 sm:p-8">
        <PageHeader
          breadcrumbs={[{ label: "Data rooms", to: base }, { label: "Room" }]}
          title="Data room"
        />
        <EmptyState
          title="This data room could not be loaded"
          description={error}
          action={
            <Link to={base}>
              <Button variant="secondary">All data rooms</Button>
            </Link>
          }
        />
      </div>
    );
  }
  if (!detail) {
    return (
      <div className="page-shell space-y-4 p-4 sm:p-8">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-10 w-full max-w-xl" />
        <Skeleton className="h-64 w-full rounded-xl" />
      </div>
    );
  }

  const { room } = detail;
  const questions = room.counts?.openQuestions ?? 0;
  const props: RoomTabProps = {
    companyId: company.id,
    companySlug: company.slug,
    detail,
    reload: async () => {
      await reload();
      await reloadRooms();
    },
    setDetail,
    goTo,
  };

  return (
    <div className="page-shell p-4 sm:p-8">
      <PageHeader
        className="mb-4"
        breadcrumbs={[{ label: "Data rooms", to: base }, { label: room.name }]}
        title={room.name}
        aside={
          <div className="flex flex-wrap items-center gap-1.5">
            <RoomStatusBadge room={room} />
            <PurposeBadge room={room} />
          </div>
        }
        description={room.description || undefined}
        actions={
          room.status === "open" ? (
            <Button onClick={() => setParams(new URLSearchParams({ tab: "guests", invite: "1" }))}>
              <UserPlus size={15} /> Invite a guest
            </Button>
          ) : (
            <Button variant="secondary" onClick={() => goTo("settings")}>
              <Settings2 size={15} /> Room settings
            </Button>
          )
        }
      />

      {/* Narrow screens swipe the tab row; its scrollbar would only add a gray bar. */}
      <nav
        aria-label="Data room"
        className="-mx-4 mb-6 overflow-x-auto px-4 [scrollbar-width:none] sm:mx-0 sm:px-0 [&::-webkit-scrollbar]:hidden"
      >
        <div className="flex min-w-max gap-1 border-b border-slate-200 dark:border-slate-800">
          {TABS.map((item) => {
            const count =
              item.key === "questions"
                ? questions
                : item.key === "documents"
                  ? (room.counts?.documents ?? 0)
                  : item.key === "guests"
                    ? (room.counts?.guests ?? 0)
                    : null;
            return (
              <button
                key={item.key}
                type="button"
                onClick={() => goTo(item.key)}
                aria-current={tab === item.key ? "page" : undefined}
                className={clsx(
                  "-mb-px flex h-10 shrink-0 items-center gap-1.5 border-b-2 px-3 text-sm font-medium transition-colors",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus",
                  tab === item.key
                    ? "border-indigo-600 text-slate-900 dark:border-indigo-400 dark:text-slate-100"
                    : "border-transparent text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200",
                )}
              >
                {item.label}
                {count ? (
                  <span
                    className={clsx(
                      "rounded-full px-1.5 text-xs tabular-nums",
                      item.key === "questions"
                        ? "bg-indigo-100 text-indigo-700 dark:bg-indigo-500/20 dark:text-indigo-200"
                        : "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300",
                    )}
                  >
                    {count}
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
      </nav>

      {room.aiEmployee && !detail.aiModelConnected && (
        <ModelMissingCallout companySlug={company.slug} employee={room.aiEmployee} />
      )}

      {tab === "overview" && <RoomOverviewTab {...props} />}
      {tab === "documents" && <RoomDocumentsTab {...props} />}
      {tab === "guests" && <RoomGuestsTab {...props} />}
      {tab === "questions" && <RoomQuestionsTab {...props} />}
      {tab === "activity" && <RoomActivityTab {...props} />}
      {tab === "settings" && <RoomSettingsTab {...props} />}
    </div>
  );
}
