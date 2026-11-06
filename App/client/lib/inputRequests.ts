import type { InputRequestView } from "../../shared/inputRequests";
import { api } from "./api";

/** Narrow a list to one piece of work, for the Run, Todo or chat it belongs to. */
export type InputRequestWorkFilter = {
  runId?: string;
  todoId?: string;
  conversationId?: string;
};

function base(companyId: string): string {
  return `/api/companies/${companyId}/input-requests`;
}

export const inputRequestsApi = {
  listOpen(companyId: string, work: InputRequestWorkFilter = {}): Promise<InputRequestView[]> {
    const query = new URLSearchParams(
      Object.entries(work).filter((entry): entry is [string, string] => Boolean(entry[1])),
    ).toString();
    return api.get<InputRequestView[]>(`${base(companyId)}${query ? `?${query}` : ""}`);
  },
  get(companyId: string, id: string): Promise<InputRequestView> {
    return api.get<InputRequestView>(`${base(companyId)}/${id}`);
  },
  ready(companyId: string, id: string): Promise<InputRequestView> {
    return api.post<InputRequestView>(`${base(companyId)}/${id}/ready`, {});
  },
  answer(
    companyId: string,
    id: string,
    value?: string,
    pageOrigin?: string,
  ): Promise<InputRequestView> {
    return api.post<InputRequestView>(`${base(companyId)}/${id}/answer`, {
      ...(value === undefined ? {} : { value }),
      ...(pageOrigin === undefined ? {} : { pageOrigin }),
    });
  },
  decline(companyId: string, id: string, note?: string): Promise<InputRequestView> {
    return api.post<InputRequestView>(`${base(companyId)}/${id}/decline`, note ? { note } : {});
  },
};

/** The host a person recognises, without the scheme. */
export function inputRequestSite(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
}

/** How long is left, the way a person reads a countdown. */
export function countdownLabel(msLeft: number): string {
  const seconds = Math.max(0, Math.ceil(msLeft / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
