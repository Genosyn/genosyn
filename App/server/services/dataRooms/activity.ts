import { AppDataSource } from "../../db/datasource.js";
import type { DataRoom } from "../../db/entities/DataRoom.js";
import { DataRoomDocument } from "../../db/entities/DataRoomDocument.js";
import { DataRoomEvent, type DataRoomEventKind } from "../../db/entities/DataRoomEvent.js";
import { DataRoomGuest } from "../../db/entities/DataRoomGuest.js";
import { DataRoomQuestion } from "../../db/entities/DataRoomQuestion.js";

/**
 * What guests did in a room, added up: per guest, per document, and as a feed.
 *
 * Every figure comes from `DataRoomEvent` rows the guests' own requests wrote,
 * so it is what happened rather than anyone's account of it. The AI
 * Employee's reading of the activity is written from these figures and never
 * changes them.
 */

/** How many events a room's activity reads at most — far past any real room. */
const MAX_EVENTS = 20_000;

export type GuestEngagement = {
  guestId: string;
  name: string;
  email: string;
  organization: string;
  status: string;
  visits: number;
  totalSeconds: number;
  documentsViewed: number;
  downloads: number;
  questionsAsked: number;
  firstViewedAt: string | null;
  lastViewedAt: string | null;
  termsAcceptedAt: string | null;
  topDocuments: Array<{ documentId: string; title: string; seconds: number; views: number }>;
};

export type DocumentEngagement = {
  documentId: string;
  title: string;
  folderId: string | null;
  views: number;
  guests: number;
  seconds: number;
  downloads: number;
  lastViewedAt: string | null;
};

export type ActivityFeedItem = {
  id: string;
  kind: DataRoomEventKind;
  guestId: string;
  guestName: string;
  organization: string;
  documentId: string | null;
  documentTitle: string | null;
  seconds: number;
  createdAt: string;
};

export type RoomActivity = {
  totals: {
    guestsInvited: number;
    guestsVisited: number;
    visits: number;
    totalSeconds: number;
    downloads: number;
    questions: number;
  };
  guests: GuestEngagement[];
  documents: DocumentEngagement[];
  feed: ActivityFeedItem[];
};

export async function roomActivity(
  room: Pick<DataRoom, "id">,
  options: { feedLimit?: number } = {},
): Promise<RoomActivity> {
  const [guests, documents, events, questions] = await Promise.all([
    AppDataSource.getRepository(DataRoomGuest).find({
      where: { roomId: room.id },
      order: { createdAt: "ASC" },
    }),
    AppDataSource.getRepository(DataRoomDocument).find({
      where: { roomId: room.id },
      select: { id: true, title: true, folderId: true },
    }),
    AppDataSource.getRepository(DataRoomEvent).find({
      where: { roomId: room.id },
      order: { createdAt: "DESC" },
      take: MAX_EVENTS,
    }),
    AppDataSource.getRepository(DataRoomQuestion).find({
      where: { roomId: room.id },
      select: { id: true, guestId: true },
    }),
  ]);
  const titles = new Map(documents.map((document) => [document.id, document.title]));
  const guestById = new Map(guests.map((guest) => [guest.id, guest]));

  type GuestTally = {
    viewed: Set<string>;
    downloads: number;
    perDocument: Map<string, { seconds: number; views: number }>;
  };
  const tallies = new Map<string, GuestTally>();
  const tally = (guestId: string): GuestTally => {
    let entry = tallies.get(guestId);
    if (!entry) {
      entry = { viewed: new Set(), downloads: 0, perDocument: new Map() };
      tallies.set(guestId, entry);
    }
    return entry;
  };
  const documentTallies = new Map<
    string,
    { views: number; guests: Set<string>; seconds: number; downloads: number; last: Date | null }
  >();
  const documentTally = (documentId: string) => {
    let entry = documentTallies.get(documentId);
    if (!entry) {
      entry = { views: 0, guests: new Set(), seconds: 0, downloads: 0, last: null };
      documentTallies.set(documentId, entry);
    }
    return entry;
  };

  let downloads = 0;
  for (const event of events) {
    if (!event.documentId || !titles.has(event.documentId)) continue;
    const guestTally = tally(event.guestId);
    const docTally = documentTally(event.documentId);
    if (event.kind === "document_viewed") {
      guestTally.viewed.add(event.documentId);
      const perDocument = guestTally.perDocument.get(event.documentId) ?? { seconds: 0, views: 0 };
      perDocument.seconds += event.seconds;
      perDocument.views += 1;
      guestTally.perDocument.set(event.documentId, perDocument);
      docTally.views += 1;
      docTally.guests.add(event.guestId);
      docTally.seconds += event.seconds;
      if (!docTally.last || event.createdAt > docTally.last) docTally.last = event.createdAt;
    } else if (event.kind === "document_downloaded") {
      guestTally.downloads += 1;
      docTally.downloads += 1;
      downloads += 1;
    }
  }
  const questionCounts = new Map<string, number>();
  for (const question of questions) {
    questionCounts.set(question.guestId, (questionCounts.get(question.guestId) ?? 0) + 1);
  }

  const guestRows: GuestEngagement[] = guests.map((guest) => {
    const entry = tallies.get(guest.id);
    const topDocuments = [...(entry?.perDocument ?? new Map()).entries()]
      .map(([documentId, value]) => ({
        documentId,
        title: titles.get(documentId) ?? "Removed document",
        seconds: value.seconds,
        views: value.views,
      }))
      .sort((a, b) => b.seconds - a.seconds || b.views - a.views)
      .slice(0, 5);
    return {
      guestId: guest.id,
      name: guest.name,
      email: guest.email,
      organization: guest.organization,
      status: guest.status,
      visits: guest.visitCount,
      totalSeconds: guest.totalSeconds,
      documentsViewed: entry?.viewed.size ?? 0,
      downloads: entry?.downloads ?? 0,
      questionsAsked: questionCounts.get(guest.id) ?? 0,
      firstViewedAt: guest.firstViewedAt?.toISOString() ?? null,
      lastViewedAt: guest.lastViewedAt?.toISOString() ?? null,
      termsAcceptedAt: guest.termsAcceptedAt?.toISOString() ?? null,
      topDocuments,
    };
  });
  guestRows.sort(
    (a, b) =>
      b.totalSeconds - a.totalSeconds ||
      (b.lastViewedAt ?? "").localeCompare(a.lastViewedAt ?? "") ||
      a.name.localeCompare(b.name),
  );

  const documentRows: DocumentEngagement[] = documents
    .map((document) => {
      const entry = documentTallies.get(document.id);
      return {
        documentId: document.id,
        title: document.title,
        folderId: document.folderId,
        views: entry?.views ?? 0,
        guests: entry?.guests.size ?? 0,
        seconds: entry?.seconds ?? 0,
        downloads: entry?.downloads ?? 0,
        lastViewedAt: entry?.last?.toISOString() ?? null,
      };
    })
    .sort((a, b) => b.seconds - a.seconds || b.views - a.views || a.title.localeCompare(b.title));

  const feed: ActivityFeedItem[] = events.slice(0, options.feedLimit ?? 100).map((event) => {
    const guest = guestById.get(event.guestId);
    return {
      id: event.id,
      kind: event.kind,
      guestId: event.guestId,
      guestName: guest?.name ?? "Removed guest",
      organization: guest?.organization ?? "",
      documentId: event.documentId,
      documentTitle: event.documentId ? (titles.get(event.documentId) ?? "Removed document") : null,
      seconds: event.seconds,
      createdAt: event.createdAt.toISOString(),
    };
  });

  return {
    totals: {
      guestsInvited: guests.length,
      guestsVisited: guests.filter((guest) => guest.firstViewedAt).length,
      visits: guests.reduce((sum, guest) => sum + guest.visitCount, 0),
      totalSeconds: guests.reduce((sum, guest) => sum + guest.totalSeconds, 0),
      downloads,
      questions: questions.length,
    },
    guests: guestRows,
    documents: documentRows,
    feed,
  };
}
