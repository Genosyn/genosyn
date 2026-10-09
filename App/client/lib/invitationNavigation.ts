/** An invitation is a token, never an arbitrary post-login redirect URL. */
export function invitationTokenFromSearch(search: string): string | null {
  const value = new URLSearchParams(search).get("invitation");
  return value && value.length <= 512 ? value : null;
}

export function invitationPath(token: string | null): string {
  return token ? `/invite/${encodeURIComponent(token)}` : "/";
}

/**
 * Where accepting an invitation lands: the company just joined. Without its
 * slug, "/" — which opens whichever membership comes first.
 */
export function joinedCompanyPath(companySlug: string | null | undefined): string {
  return companySlug ? `/c/${encodeURIComponent(companySlug)}` : "/";
}

export function invitationAuthPath(page: "login" | "signup", token: string | null): string {
  return `/${page}${token ? `?invitation=${encodeURIComponent(token)}` : ""}`;
}

export function invitationTokenFromPath(pathname: string): string | null {
  const match = /^\/invite\/([^/]+)$/.exec(pathname);
  if (!match) return null;
  try {
    const token = decodeURIComponent(match[1]);
    return token.length <= 512 ? token : null;
  } catch {
    return null;
  }
}
