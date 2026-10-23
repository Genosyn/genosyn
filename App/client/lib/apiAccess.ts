/**
 * What Settings → API keys tells someone about to script Genosyn: where the
 * company's endpoints live and a first request to try with a new key.
 *
 * An API key only works for the one company it was minted for, and every
 * operation for that company sits below `/api/companies/<id>` — so the base
 * URL is the one thing a script needs besides the key, and it is spelled out
 * with the real id rather than a placeholder to look up.
 */

/** `https://host/api/companies/<id>`: the prefix of every company operation. */
export function companyApiBaseUrl(origin: string, companyId: string): string {
  return `${origin.replace(/\/+$/, "")}/api/companies/${encodeURIComponent(companyId)}`;
}

/** The API reference's address on this install. */
export function apiReferenceUrl(origin: string): string {
  return `${origin.replace(/\/+$/, "")}/api/docs`;
}

/**
 * A request that proves a new key works: `GET …/me` answers with the Member
 * it acts as, their role and the key itself.
 */
export function apiKeyCurlExample(origin: string, companyId: string, token: string): string {
  return `curl -H "Authorization: Bearer ${token}" \\\n  ${companyApiBaseUrl(origin, companyId)}/me`;
}
