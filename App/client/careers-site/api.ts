import type { PublicOpening, PublicOpeningCard, PublicSite } from "./types";

/**
 * The careers site's calls to `/api/careers`. Same-origin on the install's
 * address and on a custom domain alike: the page and its API always share a
 * host, so a Member's session reaches internal Openings and nothing else
 * needs one.
 */

export class CareersApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly fields: Record<string, string> = {},
  ) {
    super(message);
    this.name = "CareersApiError";
  }
}

async function readError(res: Response): Promise<CareersApiError> {
  const text = await res.text().catch(() => "");
  try {
    const data = JSON.parse(text) as { error?: string; fields?: Record<string, string> };
    if (data && typeof data.error === "string") {
      return new CareersApiError(data.error, res.status, data.fields ?? {});
    }
  } catch {
    // An HTML error page from a proxy in front of the install.
  }
  if (res.status === 413) {
    return new CareersApiError("That file is too large. Keep the resume under 10 MB.", 413, {
      resume: "Keep the resume under 10 MB.",
    });
  }
  return new CareersApiError(
    res.status >= 500
      ? "Something went wrong on our side. Your application was not sent — please try again."
      : `The request failed (${res.status}).`,
    res.status,
  );
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { credentials: "same-origin", headers: { accept: "application/json" } });
  if (!res.ok) throw await readError(res);
  return (await res.json()) as T;
}

export function fetchSite(apiPath: string) {
  return getJson<{ site: PublicSite; openings: PublicOpeningCard[] }>(apiPath);
}

export function fetchOpening(apiPath: string, openingSlug: string) {
  return getJson<{ site: PublicSite; opening: PublicOpening }>(
    `${apiPath}/openings/${encodeURIComponent(openingSlug)}`,
  );
}

/** Send one application. Throws a `CareersApiError` whose `fields` name what to fix. */
export async function submitApplication(
  apiPath: string,
  openingSlug: string,
  body: FormData,
): Promise<{ ok: true; email: string }> {
  const res = await fetch(`${apiPath}/openings/${encodeURIComponent(openingSlug)}/applications`, {
    method: "POST",
    credentials: "same-origin",
    body,
  });
  if (!res.ok) throw await readError(res);
  return (await res.json()) as { ok: true; email: string };
}
