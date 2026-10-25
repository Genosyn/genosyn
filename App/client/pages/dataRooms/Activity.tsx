import React from "react";
import {
  Clock,
  Download,
  Eye,
  FileText,
  LogIn,
  MessageCircleQuestion,
  Signature,
  Users,
} from "lucide-react";

import { useLiveRefetch } from "@/components/CompanySocket";
import { Button } from "@/components/ui/Button";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { SectionHeader } from "@/components/ui/PageHeader";
import { SkeletonList } from "@/components/ui/Skeleton";
import { TD, TH, THead, TR, Table, TableCard } from "@/components/ui/Table";
import { agoText, dataRoomsApi, type ActivityFeedItem, type RoomActivity } from "@/lib/dataRooms";
import { errorMessage } from "@/lib/errors";
import { formatDuration } from "../../../shared/dataRooms";
import type { RoomTabProps } from "../DataRoomDetail";
import { StatTile } from "./shared";

const FEED_ICON: Record<ActivityFeedItem["kind"], React.ReactNode> = {
  room_opened: <LogIn size={14} />,
  terms_accepted: <Signature size={14} />,
  document_viewed: <Eye size={14} />,
  document_downloaded: <Download size={14} />,
  question_asked: <MessageCircleQuestion size={14} />,
};

function feedSentence(item: ActivityFeedItem): string {
  const who = item.organization ? `${item.guestName} (${item.organization})` : item.guestName;
  switch (item.kind) {
    case "room_opened":
      return `${who} opened the room`;
    case "terms_accepted":
      return `${who} accepted the room's terms`;
    case "document_viewed":
      return `${who} read ${item.documentTitle ?? "a document"}${item.seconds ? ` for ${formatDuration(item.seconds)}` : ""}`;
    case "document_downloaded":
      return `${who} downloaded ${item.documentTitle ?? "a document"}`;
    case "question_asked":
      return `${who} asked a question${item.documentTitle ? ` about ${item.documentTitle}` : ""}`;
  }
}

export function RoomActivityTab({ companyId, detail }: RoomTabProps) {
  const { room } = detail;
  const [activity, setActivity] = React.useState<RoomActivity | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    try {
      setActivity(await dataRoomsApi(companyId).activity(room.id));
      setError(null);
    } catch (err) {
      setError(errorMessage(err, "Could not load the activity"));
    }
  }, [companyId, room.id]);
  React.useEffect(() => {
    void load();
  }, [load]);
  useLiveRefetch(
    ["data_room_activity", "data_room_guest", "data_room_question"],
    () => void load(),
    room.id,
  );

  if (error) {
    return (
      <EmptyState
        title="Activity could not be loaded"
        description={error}
        action={<Button onClick={() => void load()}>Try again</Button>}
      />
    );
  }
  if (!activity) return <SkeletonList rows={4} />;

  const { totals } = activity;
  const read = activity.documents.filter((document) => document.views > 0);
  return (
    <div className="space-y-6">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile
          icon={<Users size={14} />}
          label="Guests who visited"
          value={`${totals.guestsVisited} of ${totals.guestsInvited}`}
        />
        <StatTile icon={<LogIn size={14} />} label="Visits" value={totals.visits} />
        <StatTile
          icon={<Clock size={14} />}
          label="Time reading"
          value={formatDuration(totals.totalSeconds)}
        />
        <StatTile
          icon={<Download size={14} />}
          label="Downloads"
          value={totals.downloads}
          hint={room.allowDownloads ? "Downloads are allowed" : "The room is view only"}
        />
      </div>

      <section>
        <SectionHeader
          title="Guests"
          description="Most engaged first. Time counts only while a document is open on their screen."
        />
        {activity.guests.length === 0 ? (
          <EmptyState
            icon={<Users />}
            title="Nobody is invited yet"
            description="Invite a guest from the Guests tab."
          />
        ) : (
          <TableCard>
            <Table>
              <THead>
                <tr>
                  <TH>Guest</TH>
                  <TH align="right">Visits</TH>
                  <TH align="right">Reading</TH>
                  <TH align="right" className="hidden md:table-cell">
                    Opened
                  </TH>
                  <TH align="right" className="hidden lg:table-cell">
                    Questions
                  </TH>
                  <TH className="hidden xl:table-cell">Read most</TH>
                  <TH>Last visit</TH>
                </tr>
              </THead>
              <tbody>
                {activity.guests.map((guest) => (
                  <TR key={guest.guestId}>
                    <TD>
                      <div className="max-w-[12rem] sm:max-w-[16rem]">
                        <div className="truncate font-medium text-slate-900 dark:text-slate-100">
                          {guest.name}
                        </div>
                        <div className="truncate text-xs text-slate-500 dark:text-slate-400">
                          {guest.organization || guest.email}
                        </div>
                      </div>
                    </TD>
                    <TD align="right" numeric>
                      {guest.visits}
                    </TD>
                    <TD align="right" numeric>
                      {formatDuration(guest.totalSeconds)}
                    </TD>
                    <TD align="right" numeric className="hidden md:table-cell">
                      {guest.documentsViewed}
                    </TD>
                    <TD align="right" numeric className="hidden lg:table-cell">
                      {guest.questionsAsked}
                    </TD>
                    <TD className="hidden text-sm xl:table-cell">
                      <div className="max-w-[16rem] truncate">
                        {guest.topDocuments[0]?.title ?? "—"}
                      </div>
                    </TD>
                    <TD className="whitespace-nowrap text-sm">
                      {guest.lastViewedAt ? agoText(guest.lastViewedAt) : "Not yet"}
                    </TD>
                  </TR>
                ))}
              </tbody>
            </Table>
          </TableCard>
        )}
      </section>

      <section>
        <SectionHeader title="Documents" description="What guests read, and for how long." />
        {read.length === 0 ? (
          <EmptyState
            icon={<FileText />}
            title="No document has been opened"
            description="Opens appear here as guests read."
          />
        ) : (
          <TableCard>
            <Table>
              <THead>
                <tr>
                  <TH>Document</TH>
                  <TH align="right">Opens</TH>
                  <TH align="right">Guests</TH>
                  <TH align="right">Reading</TH>
                  <TH align="right" className="hidden sm:table-cell">
                    Downloads
                  </TH>
                  <TH className="hidden md:table-cell">Last opened</TH>
                </tr>
              </THead>
              <tbody>
                {read.map((document) => (
                  <TR key={document.documentId}>
                    <TD className="font-medium text-slate-900 dark:text-slate-100">
                      <div className="max-w-[12rem] truncate sm:max-w-[20rem]">
                        {document.title}
                      </div>
                    </TD>
                    <TD align="right" numeric>
                      {document.views}
                    </TD>
                    <TD align="right" numeric>
                      {document.guests}
                    </TD>
                    <TD align="right" numeric>
                      {formatDuration(document.seconds)}
                    </TD>
                    <TD align="right" numeric className="hidden sm:table-cell">
                      {document.downloads}
                    </TD>
                    <TD className="hidden whitespace-nowrap text-sm md:table-cell">
                      {agoText(document.lastViewedAt)}
                    </TD>
                  </TR>
                ))}
              </tbody>
            </Table>
          </TableCard>
        )}
      </section>

      <Card>
        <CardHeader>
          <CardTitle>Recent activity</CardTitle>
        </CardHeader>
        <CardBody>
          {activity.feed.length === 0 ? (
            <p className="text-sm text-slate-500 dark:text-slate-400">Nothing yet.</p>
          ) : (
            <ul className="space-y-3">
              {activity.feed.map((item) => (
                <li key={item.id} className="flex items-start gap-3 text-sm">
                  <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400">
                    {FEED_ICON[item.kind]}
                  </span>
                  <div className="min-w-0">
                    <div className="text-slate-800 dark:text-slate-200">{feedSentence(item)}</div>
                    <div className="text-xs text-slate-500 dark:text-slate-400">
                      {agoText(item.createdAt)}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
