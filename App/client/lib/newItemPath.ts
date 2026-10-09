/**
 * Where "New routine" and "New skill" send someone. The list they pressed it
 * on was often already narrowed — to one AI Employee's routines, or a folder —
 * and the form reads those back from the URL, so carrying them across means
 * the new item lands with the right owner and in the right folder instead of
 * on whichever employee happens to be first in the roster.
 */

type From = { folder?: string | null; employee?: string | null };

function withQuery(path: string, entries: Array<[string, string | null | undefined]>): string {
  const params = new URLSearchParams();
  for (const [key, value] of entries) if (value) params.set(key, value);
  const query = params.toString();
  return query ? `${path}?${query}` : path;
}

export function newRoutinePath(companySlug: string, from: From = {}): string {
  return withQuery(`/c/${companySlug}/routines/new`, [
    ["folder", from.folder],
    ["employee", from.employee],
  ]);
}

export function newSkillPath(companySlug: string, from: Pick<From, "employee"> = {}): string {
  return withQuery(`/c/${companySlug}/skills/new`, [["employee", from.employee]]);
}
