import { api } from "@/lib/api";
import type { VaultVisibility } from "@/lib/vault";

/**
 * Vault sources — an external Bitwarden or Vaultwarden vault a company has
 * connected. Genosyn mirrors each readable item as a Vault item that carries
 * title, username, and website but no secret; the secret is fetched from the
 * source at the moment it is revealed, copied, or filled.
 *
 * Every route below is admin-only on the server, so the panel that calls them
 * renders for owners and admins only.
 */

export type VaultSourceKind = "bitwarden";
export type VaultSourceStatus = "connected" | "error";

export type VaultSource = {
  id: string;
  companyId: string;
  kind: VaultSourceKind;
  label: string;
  serverUrl: string;
  /** The account the source signs in as, safe to show. */
  accountHint: string;
  /** Optional folder or collection the mirror is limited to; empty means all. */
  scopeName: string;
  defaultVisibility: VaultVisibility;
  /** True when the source signs in with a Bitwarden API key rather than the password grant. */
  usesApiKey: boolean;
  status: VaultSourceStatus;
  statusMessage: string;
  lastSyncedAt: string | null;
  lastSyncItemCount: number;
  /** How many Vault items this source currently mirrors. */
  itemCount: number;
  createdAt: string;
  updatedAt: string;
};

export type CreateVaultSourceInput = {
  label: string;
  serverUrl: string;
  email: string;
  masterPassword: string;
  clientId?: string;
  clientSecret?: string;
  scopeName?: string;
  defaultVisibility?: VaultVisibility;
  /** A current authenticator code, when the account asks for two-step login. */
  twoFactorCode?: string;
};

/** Every field is optional; the server re-proves the sign-in when one moves. */
export type UpdateVaultSourceInput = Partial<CreateVaultSourceInput>;

export type VaultSourceSyncResult = {
  added: number;
  updated: number;
  removed: number;
  /** Items the external vault holds that a Genosyn Vault cannot represent. */
  skipped: { unsupportedType: number; unreadable: number; outOfScope: number };
  itemCount: number;
};

function sourcesBase(companyId: string): string {
  return `/api/companies/${companyId}/vault/sources`;
}

function sourceBase(companyId: string, sourceId: string): string {
  return `${sourcesBase(companyId)}/${sourceId}`;
}

export const vaultSourcesApi = {
  async list(companyId: string): Promise<VaultSource[]> {
    const result = await api.get<{ sources: VaultSource[] }>(sourcesBase(companyId));
    return result.sources;
  },

  async create(companyId: string, input: CreateVaultSourceInput): Promise<VaultSource> {
    const result = await api.post<{ source: VaultSource }>(sourcesBase(companyId), input);
    return result.source;
  },

  async update(
    companyId: string,
    sourceId: string,
    input: UpdateVaultSourceInput,
  ): Promise<VaultSource> {
    const result = await api.patch<{ source: VaultSource }>(sourceBase(companyId, sourceId), input);
    return result.source;
  },

  remove(companyId: string, sourceId: string): Promise<{ ok: true; removedItems: number }> {
    return api.del<{ ok: true; removedItems: number }>(sourceBase(companyId, sourceId));
  },

  sync(
    companyId: string,
    sourceId: string,
  ): Promise<{ result: VaultSourceSyncResult; source: VaultSource }> {
    return api.post<{ result: VaultSourceSyncResult; source: VaultSource }>(
      `${sourceBase(companyId, sourceId)}/sync`,
    );
  },
};

/**
 * Whether a failed sign-in is asking for a second factor.
 *
 * The server answers a two-step account with one sentence naming it, and the
 * only way past it is a current code — so the form reveals the field rather
 * than leaving the person to guess what to change.
 */
export function isTwoStepLoginError(message: string): boolean {
  return /two-step login/i.test(message);
}
