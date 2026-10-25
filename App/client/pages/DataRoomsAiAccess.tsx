import React from "react";
import { useOutletContext } from "react-router-dom";
import { Eye, FolderPlus, Send, ShieldCheck } from "lucide-react";

import { Avatar, employeeAvatarUrl } from "@/components/ui/Avatar";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { useDialog } from "@/components/ui/Dialog";
import { EmptyState } from "@/components/ui/EmptyState";
import { PageHeader } from "@/components/ui/PageHeader";
import { Select } from "@/components/ui/Select";
import { SkeletonList } from "@/components/ui/Skeleton";
import { dataRoomsApi, type DataRoomGrantRow } from "@/lib/dataRooms";
import { errorMessage } from "@/lib/errors";
import { canOpenSubpage, subpageAt } from "@/lib/subpages";
import {
  DATA_ROOM_ACCESS_HINTS,
  DATA_ROOM_ACCESS_LABELS,
  DATA_ROOM_ACCESS_LEVELS,
  type DataRoomAccessLevel,
} from "../../shared/dataRooms";
import type { DataRoomsOutletContext } from "./DataRoomsLayout";
import { OwnersOnlyNote } from "./dataRooms/shared";

const LEVEL_ICONS: Record<DataRoomAccessLevel, React.ReactNode> = {
  read: <Eye size={15} />,
  prepare: <FolderPlus size={15} />,
  share: <Send size={15} />,
};

export default function DataRoomsAiAccess() {
  const { company } = useOutletContext<DataRoomsOutletContext>();
  if (!canOpenSubpage(subpageAt("/data-rooms/ai-access"), company)) return <OwnersOnlyNote />;
  return <AccessTable />;
}

function AccessTable() {
  const { company } = useOutletContext<DataRoomsOutletContext>();
  const dialog = useDialog();
  const [rows, setRows] = React.useState<DataRoomGrantRow[] | null>(null);
  const [loadError, setLoadError] = React.useState("");
  const [busy, setBusy] = React.useState<string | null>(null);
  const crumbs = [
    { label: "Data rooms", to: `/c/${company.slug}/data-rooms` },
    { label: "AI access" },
  ];

  const load = React.useCallback(async () => {
    setRows((await dataRoomsApi(company.id).grants()).rows);
  }, [company.id]);

  const firstLoad = React.useCallback(() => {
    setLoadError("");
    load().catch((err: unknown) => setLoadError(errorMessage(err, "Could not load AI access")));
  }, [load]);

  React.useEffect(() => {
    firstLoad();
  }, [firstLoad]);

  async function setAccess(row: DataRoomGrantRow, level: string) {
    setBusy(row.employee.id);
    try {
      if (!level) await dataRoomsApi(company.id).removeGrant(row.employee.id);
      else await dataRoomsApi(company.id).setGrant(row.employee.id, level as DataRoomAccessLevel);
      await load();
    } catch (err) {
      void dialog.error(err, { title: "Couldn’t update data room access" });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="page-shell max-w-4xl p-4 sm:p-8">
      <PageHeader
        breadcrumbs={crumbs}
        title="AI access"
        description="Which AI Employees may work with data rooms through their own tools, and how far. The AI Employee each room names in its settings needs none of this to brief documents and draft answers there."
      />

      {loadError ? (
        <EmptyState
          title="AI access could not be loaded"
          description={loadError}
          action={<Button onClick={firstLoad}>Try again</Button>}
        />
      ) : rows === null ? (
        <SkeletonList rows={4} />
      ) : rows.length === 0 ? (
        <EmptyState
          title="No AI Employees yet"
          description="Hire an AI Employee before giving it data room access."
        />
      ) : (
        <Card className="overflow-hidden">
          <div className="grid grid-cols-[minmax(0,1fr)_10rem] gap-4 border-b border-slate-100 bg-slate-50/80 px-5 py-2.5 text-xs font-medium text-slate-500 dark:border-slate-800 dark:bg-slate-800/40 dark:text-slate-400">
            <span>AI Employee</span>
            <span>Data room access</span>
          </div>
          <div className="divide-y divide-slate-100 dark:divide-slate-800">
            {rows.map((row) => (
              <div
                key={row.employee.id}
                className="grid grid-cols-[minmax(0,1fr)_10rem] items-center gap-4 px-5 py-3.5"
              >
                <div className="flex min-w-0 items-center gap-3">
                  <Avatar
                    src={employeeAvatarUrl(company.id, row.employee.id, row.employee.avatarKey)}
                    name={row.employee.name}
                    kind="ai"
                    size="sm"
                  />
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium text-slate-900 dark:text-slate-100">
                      {row.employee.name}
                    </div>
                    <div className="truncate text-xs text-slate-500 dark:text-slate-400">
                      {row.employee.role}
                    </div>
                  </div>
                </div>
                <Select
                  aria-label={`Data room access for ${row.employee.name}`}
                  value={row.grant?.accessLevel ?? ""}
                  disabled={busy === row.employee.id}
                  onChange={(event) => void setAccess(row, event.target.value)}
                >
                  <option value="">No access</option>
                  {DATA_ROOM_ACCESS_LEVELS.map((level) => (
                    <option key={level} value={level}>
                      {DATA_ROOM_ACCESS_LABELS[level]}
                    </option>
                  ))}
                </Select>
              </div>
            ))}
          </div>
        </Card>
      )}

      <div className="mt-5 grid gap-3 md:grid-cols-3">
        {DATA_ROOM_ACCESS_LEVELS.map((level) => (
          <Card key={level} className="p-4">
            <div className="flex items-center gap-2 text-sm font-semibold text-slate-900 dark:text-slate-100">
              {LEVEL_ICONS[level]} {DATA_ROOM_ACCESS_LABELS[level]}
            </div>
            <p className="mt-1 text-xs leading-5 text-slate-500 dark:text-slate-400">
              {DATA_ROOM_ACCESS_HINTS[level]}
            </p>
          </Card>
        ))}
      </div>

      <div className="mt-5 flex items-start gap-3 rounded-xl border border-indigo-100 bg-indigo-50 p-4 text-sm text-indigo-900 dark:border-indigo-500/20 dark:bg-indigo-500/10 dark:text-indigo-200">
        <ShieldCheck size={18} className="mt-0.5 shrink-0" />
        <p>
          Guests&apos; questions are written by people outside the company. An AI Employee that
          reads them is treated as having read outside content, so an invitation or a published
          answer in the same turn waits for a person. Every answer quotes documents the guest can
          open, and every quote is checked.
        </p>
      </div>
    </div>
  );
}
