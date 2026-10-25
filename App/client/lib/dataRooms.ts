import { api } from "./api";
import type {
  DataRoomAccessLevel,
  DataRoomAiAnswerMode,
  DataRoomCitation,
  DataRoomDocumentBrief,
  DataRoomInsights,
  DataRoomJobKind,
  DataRoomJobStatus,
  DataRoomPurpose,
  DataRoomQuestionStatus,
  DataRoomReadiness,
  DataRoomStatus,
  DataRoomViewerKind,
} from "../../shared/dataRooms";

/**
 * Data rooms in the App: the shapes the server returns
 * (`server/services/dataRooms/serialize.ts`), the calls that fetch and change
 * them — the company's side and the guest's — and the small decisions every
 * data room screen makes the same way.
 */

export type EmployeeStub = { id: string; name: string; slug: string; avatarKey: string | null };

export type DataRoomCounts = {
  documents: number;
  folders: number;
  guests: number;
  guestsVisited: number;
  openQuestions: number;
};

export type DataRoom = {
  id: string;
  name: string;
  purpose: DataRoomPurpose;
  status: DataRoomStatus;
  description: string;
  welcomeMessage: string;
  allowDownloads: boolean;
  watermark: boolean;
  requireTerms: boolean;
  termsText: string;
  aiEmployeeId: string | null;
  aiEmployee: EmployeeStub | null;
  aiAnswerMode: DataRoomAiAnswerMode;
  readiness: DataRoomReadiness | null;
  readinessAt: string | null;
  readinessScore: number | null;
  insights: DataRoomInsights | null;
  insightsAt: string | null;
  lastGuestActivityAt: string | null;
  closedAt: string | null;
  createdByUserId: string | null;
  createdByEmployeeId: string | null;
  createdAt: string;
  updatedAt: string;
  counts?: DataRoomCounts;
};

export type DataRoomFolder = { id: string; name: string; position: number; number: number };

export type DataRoomDocument = {
  id: string;
  folderId: string | null;
  title: string;
  filename: string;
  mimeType: string;
  viewerKind: DataRoomViewerKind;
  sizeBytes: number;
  sha256: string;
  pageCount: number;
  position: number;
  textStatus: "pending" | "extracted" | "none";
  textChars: number;
  brief: DataRoomDocumentBrief | null;
  briefAt: string | null;
  sourceResourceId: string | null;
  uploadedByUserId: string | null;
  uploadedByEmployeeId: string | null;
  createdAt: string;
  updatedAt: string;
};

export type DataRoomJob = {
  id: string;
  kind: DataRoomJobKind;
  targetId: string;
  status: DataRoomJobStatus;
  attempts: number;
  error: string;
  runAfter: string;
  updatedAt: string;
};

export type DataRoomDetail = {
  room: DataRoom;
  folders: DataRoomFolder[];
  documents: DataRoomDocument[];
  jobs: DataRoomJob[];
  /** False while the room's AI Employee has no connected AI Model to think with. */
  aiModelConnected: boolean;
};

export type DataRoomGuest = {
  id: string;
  name: string;
  email: string;
  organization: string;
  status: "active" | "revoked";
  folderIds: string[];
  expiresAt: string | null;
  expired: boolean;
  termsAcceptedAt: string | null;
  termsAcceptedName: string;
  firstViewedAt: string | null;
  lastViewedAt: string | null;
  visitCount: number;
  totalSeconds: number;
  inviteStatus: "none" | "sent" | "failed" | "skipped";
  inviteError: string;
  inviteSentAt: string | null;
  invitedByUserId: string | null;
  invitedByEmployeeId: string | null;
  revokedAt: string | null;
  createdAt: string;
};

export type InvitationDelivery = { status: "none" | "sent" | "failed" | "skipped"; error: string };

export type DataRoomQuestion = {
  id: string;
  guestId: string;
  guest: { id: string; name: string; email: string; organization: string } | null;
  documentId: string | null;
  body: string;
  status: DataRoomQuestionStatus;
  answer: string;
  citations: DataRoomCitation[];
  answeredByUserId: string | null;
  answeredByEmployeeId: string | null;
  answeredAt: string | null;
  draftAnswer: string;
  draftCitations: DataRoomCitation[];
  draftNote: string;
  draftByEmployeeId: string | null;
  draftAt: string | null;
  injectionFlag: boolean;
  createdAt: string;
  updatedAt: string;
};

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
  kind:
    | "room_opened"
    | "terms_accepted"
    | "document_viewed"
    | "document_downloaded"
    | "question_asked";
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

export type DataRoomGrantRow = {
  employee: { id: string; name: string; slug: string; role: string; avatarKey: string | null };
  grant: { id: string; accessLevel: DataRoomAccessLevel; createdAt: string } | null;
};

export type RoomSettingsPatch = Partial<
  Pick<
    DataRoom,
    | "name"
    | "purpose"
    | "description"
    | "welcomeMessage"
    | "allowDownloads"
    | "watermark"
    | "requireTerms"
    | "termsText"
    | "aiEmployeeId"
    | "aiAnswerMode"
    | "status"
  >
>;

export type GuestInvite = {
  name: string;
  email: string;
  organization?: string;
  folderIds?: string[];
  expiresAt?: string | null;
  sendInvitation?: boolean;
  message?: string;
};

export function dataRoomsApi(companyId: string) {
  const base = `/api/companies/${companyId}/data-rooms`;
  const room = (roomId: string) => `${base}/${roomId}`;
  return {
    list: (status?: DataRoomStatus) =>
      api.get<{ rooms: DataRoom[] }>(`${base}${status ? `?status=${status}` : ""}`),
    create: (input: {
      name: string;
      purpose: DataRoomPurpose;
      description?: string;
      welcomeMessage?: string;
      aiEmployeeId?: string | null;
      seedFolders?: boolean;
    }) => api.post<DataRoomDetail>(base, input),
    get: (roomId: string) => api.get<DataRoomDetail>(room(roomId)),
    update: (roomId: string, patch: RoomSettingsPatch) =>
      api.patch<DataRoomDetail>(room(roomId), patch),
    remove: (roomId: string) => api.del<void>(room(roomId)),
    requestReadiness: (roomId: string) => api.post<DataRoomDetail>(`${room(roomId)}/readiness`, {}),
    requestInsights: (roomId: string) => api.post<DataRoomDetail>(`${room(roomId)}/insights`, {}),
    activity: (roomId: string) => api.get<RoomActivity>(`${room(roomId)}/activity`),

    createFolder: (roomId: string, name: string) =>
      api.post<DataRoomFolder>(`${room(roomId)}/folders`, { name }),
    renameFolder: (roomId: string, folderId: string, name: string) =>
      api.patch<DataRoomFolder>(`${room(roomId)}/folders/${folderId}`, { name }),
    reorderFolders: (roomId: string, folderIds: string[]) =>
      api.put<{ folders: DataRoomFolder[] }>(`${room(roomId)}/folders/order`, { folderIds }),
    deleteFolder: (roomId: string, folderId: string) =>
      api.del<void>(`${room(roomId)}/folders/${folderId}`),

    upload: (
      roomId: string,
      file: File,
      fields: { folderId?: string | null; title?: string } = {},
    ) =>
      api.uploadFile<DataRoomDocument>(`${room(roomId)}/documents`, file, {
        ...(fields.folderId ? { folderId: fields.folderId } : {}),
        ...(fields.title ? { title: fields.title } : {}),
      }),
    fromResource: (roomId: string, resourceId: string, folderId: string | null) =>
      api.post<DataRoomDocument>(`${room(roomId)}/documents/from-resource`, {
        resourceId,
        folderId,
      }),
    updateDocument: (
      roomId: string,
      documentId: string,
      patch: { title?: string; folderId?: string | null; position?: number },
    ) => api.patch<DataRoomDocument>(`${room(roomId)}/documents/${documentId}`, patch),
    deleteDocument: (roomId: string, documentId: string) =>
      api.del<void>(`${room(roomId)}/documents/${documentId}`),
    documentFileUrl: (roomId: string, documentId: string, download = false) =>
      `${room(roomId)}/documents/${documentId}/file${download ? "?download=1" : ""}`,
    documentText: (roomId: string, documentId: string) =>
      api.get<{ textStatus: string; text: string; truncated: boolean; totalChars: number }>(
        `${room(roomId)}/documents/${documentId}/text`,
      ),
    requestBrief: (roomId: string, documentId: string) =>
      api.post<DataRoomDetail>(`${room(roomId)}/documents/${documentId}/brief`, {}),
    requestMissingBriefs: (roomId: string) =>
      api.post<DataRoomDetail>(`${room(roomId)}/briefs`, {}),

    guests: (roomId: string) => api.get<{ guests: DataRoomGuest[] }>(`${room(roomId)}/guests`),
    invite: (roomId: string, input: GuestInvite) =>
      api.post<{ guest: DataRoomGuest; link: string; delivery: InvitationDelivery | null }>(
        `${room(roomId)}/guests`,
        input,
      ),
    updateGuest: (
      roomId: string,
      guestId: string,
      patch: {
        name?: string;
        organization?: string;
        folderIds?: string[];
        expiresAt?: string | null;
      },
    ) => api.patch<DataRoomGuest>(`${room(roomId)}/guests/${guestId}`, patch),
    revokeGuest: (roomId: string, guestId: string) =>
      api.post<DataRoomGuest>(`${room(roomId)}/guests/${guestId}/revoke`, {}),
    restoreGuest: (roomId: string, guestId: string) =>
      api.post<DataRoomGuest>(`${room(roomId)}/guests/${guestId}/restore`, {}),
    guestLink: (roomId: string, guestId: string) =>
      api.get<{ link: string }>(`${room(roomId)}/guests/${guestId}/link`),
    reissueLink: (roomId: string, guestId: string, sendInvitation: boolean) =>
      api.post<{ guest: DataRoomGuest; link: string; delivery: InvitationDelivery | null }>(
        `${room(roomId)}/guests/${guestId}/reissue-link`,
        { sendInvitation },
      ),
    resendInvitation: (roomId: string, guestId: string) =>
      api.post<{ guest: DataRoomGuest; delivery: InvitationDelivery }>(
        `${room(roomId)}/guests/${guestId}/resend`,
        {},
      ),

    questions: (roomId: string, status?: DataRoomQuestionStatus) =>
      api.get<{ questions: DataRoomQuestion[] }>(
        `${room(roomId)}/questions${status ? `?status=${status}` : ""}`,
      ),
    answer: (
      roomId: string,
      questionId: string,
      answer: string,
      citations: Array<{ documentId: string; quote: string }>,
    ) =>
      api.post<DataRoomQuestion>(`${room(roomId)}/questions/${questionId}/answer`, {
        answer,
        citations,
      }),
    publishDraft: (roomId: string, questionId: string) =>
      api.post<DataRoomQuestion>(`${room(roomId)}/questions/${questionId}/publish-draft`, {}),
    requestDraft: (roomId: string, questionId: string) =>
      api.post<DataRoomDetail>(`${room(roomId)}/questions/${questionId}/draft`, {}),
    closeQuestion: (roomId: string, questionId: string) =>
      api.post<DataRoomQuestion>(`${room(roomId)}/questions/${questionId}/close`, {}),
    reopenQuestion: (roomId: string, questionId: string) =>
      api.post<DataRoomQuestion>(`${room(roomId)}/questions/${questionId}/reopen`, {}),

    grants: () => api.get<{ rows: DataRoomGrantRow[] }>(`${base}/ai-access`),
    setGrant: (employeeId: string, accessLevel: DataRoomAccessLevel) =>
      api.put<{ id: string }>(`${base}/ai-access/${employeeId}`, { accessLevel }),
    removeGrant: (employeeId: string) => api.del<void>(`${base}/ai-access/${employeeId}`),
  };
}

// ── The guest's side ────────────────────────────────────────────────────────

export type GuestDocument = {
  id: string;
  folderId: string | null;
  title: string;
  filename: string;
  viewerKind: DataRoomViewerKind;
  sizeBytes: number;
  pageCount: number;
  updatedAt: string;
};

export type GuestQuestion = {
  id: string;
  body: string;
  documentId: string | null;
  status: DataRoomQuestionStatus;
  answer: string | null;
  citations: DataRoomCitation[];
  answeredAt: string | null;
  createdAt: string;
};

export type GuestRoomView = {
  company: { name: string };
  room: {
    name: string;
    purpose: string;
    welcomeMessage: string;
    allowDownloads: boolean;
    watermark: boolean;
    requireTerms: boolean;
    termsText: string;
  };
  guest: { name: string; email: string; organization: string; expiresAt: string | null };
  termsAccepted: boolean;
  folders: Array<{ id: string; name: string; number: number }>;
  documents: GuestDocument[];
  questions: GuestQuestion[];
};

/** A known link that no longer opens the room. */
export type GuestBlocked = {
  error: string;
  blocked: "closed" | "revoked" | "expired";
  companyName: string;
  roomName: string;
};

export function guestRoomApi(token: string) {
  const base = `/api/room/${encodeURIComponent(token)}`;
  return {
    get: () => api.get<GuestRoomView>(base),
    visit: () => api.post<void>(`${base}/visit`, {}),
    acceptTerms: (name: string) => api.post<GuestRoomView>(`${base}/terms`, { name, accept: true }),
    fileUrl: (documentId: string, download = false) =>
      `${base}/documents/${documentId}/file${download ? "?download=1" : ""}`,
    text: (documentId: string) =>
      api.get<{ text: string; truncated: boolean }>(`${base}/documents/${documentId}/text`),
    openView: (documentId: string) => api.post<{ viewId: string }>(`${base}/views`, { documentId }),
    heartbeat: (viewId: string, seconds: number) =>
      api.post<void>(`${base}/views/${viewId}/heartbeat`, { seconds }),
    ask: (question: string, documentId: string | null) =>
      api.post<GuestQuestion>(`${base}/questions`, { question, documentId }),
  };
}

// ── Shared decisions ────────────────────────────────────────────────────────

/** "2.3" for the third document of the second folder; "" for the top level. */
export function documentIndexNumbers(
  folders: Array<Pick<DataRoomFolder, "id" | "number">>,
  documents: Array<Pick<DataRoomDocument, "id" | "folderId" | "position">>,
): Map<string, string> {
  const folderNumber = new Map(folders.map((folder) => [folder.id, folder.number]));
  const byFolder = new Map<string, Array<Pick<DataRoomDocument, "id" | "position">>>();
  for (const document of documents) {
    if (!document.folderId) continue;
    const list = byFolder.get(document.folderId) ?? [];
    list.push(document);
    byFolder.set(document.folderId, list);
  }
  const numbers = new Map<string, string>();
  for (const [folderId, list] of byFolder) {
    const number = folderNumber.get(folderId);
    if (!number) continue;
    [...list]
      .sort((a, b) => a.position - b.position)
      .forEach((document, index) => numbers.set(document.id, `${number}.${index + 1}`));
  }
  return numbers;
}

/** The newest job about one document, question or room, if any is waiting, running or failed. */
export function jobFor(
  jobs: DataRoomJob[],
  kind: DataRoomJobKind,
  targetId: string,
): DataRoomJob | null {
  const matches = jobs.filter((job) => job.kind === kind && job.targetId === targetId);
  return matches[matches.length - 1] ?? null;
}

export function jobIsActive(job: DataRoomJob | null): boolean {
  return job?.status === "queued" || job?.status === "running";
}

/** The readiness review no longer matches what the room holds. */
export function readinessIsStale(room: DataRoom, documentCount: number): boolean {
  return Boolean(room.readiness && room.readiness.documentCount !== documentCount);
}

/** Tone for a readiness score: green from 80, amber from 50, red below. */
export function readinessTone(score: number): "success" | "warning" | "danger" {
  if (score >= 80) return "success";
  if (score >= 50) return "warning";
  return "danger";
}

/** "3m ago", "2h ago", "5d ago", "on Mar 3", "never". */
export function agoText(iso: string | null, now = new Date()): string {
  if (!iso) return "never";
  const then = new Date(iso);
  const seconds = Math.max(0, Math.round((now.getTime() - then.getTime()) / 1000));
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
  if (seconds < 30 * 86_400) return `${Math.floor(seconds / 86_400)}d ago`;
  return `on ${then.toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;
}

export function formatDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

/** A date input's value (yyyy-mm-dd) as the end of that day, in ISO. */
export function endOfDayIso(value: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T23:59:59`);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}
