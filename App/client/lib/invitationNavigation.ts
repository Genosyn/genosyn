/** An invitation is a token, never an arbitrary post-login redirect URL. */
export function invitationTokenFromSearch(search: string): string | null {
  const value = new URLSearchParams(search).get("invitation");
  return value && value.length <= 512 ? value : null;
}

export function invitationPath(token: string | null): string {
  return token ? `/invite/${encodeURIComponent(token)}` : "/";
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
