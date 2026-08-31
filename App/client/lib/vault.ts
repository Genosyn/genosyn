import { api } from "@/lib/api";

export type VaultItemType = "login" | "api_key" | "secure_note";
export type VaultVisibility = "company" | "restricted";
export type VaultMemberAccessLevel = "view" | "edit";
export type VaultEmployeeAccessLevel = "use" | "manage";

export type VaultPasskey = {
  id: string;
  rpId: string;
  userName?: string;
  userDisplayName?: string;
  createdAt: string;
  lastUsedAt?: string | null;
};

export type VaultItem = {
  id: string;
  companyId: string;
  type: VaultItemType;
  visibility: VaultVisibility;
  /**
   * Set when this item is mirrored from a connected Vault source. A mirror
   * carries title, username, and website but no stored secret — that one lives
   * in Bitwarden and is read from there whenever it is used.
   */
  vaultSourceId: string | null;
  title: string;
  username: string;
  websiteUrl: string;
  /** Encrypted auxiliary context returned only to an authorized viewer. */
  notes: string;
  /** Whether this Login has an encrypted TOTP authenticator attached. */
  hasTotp: boolean;
  /** Safe metadata for encrypted software passkeys attached to this Login. */
  passkeys: VaultPasskey[];
  version: number;
  createdByUserId: string | null;
  createdByEmployeeId: string | null;
  createdAt: string;
  updatedAt: string;
  effectiveAccessLevel: VaultMemberAccessLevel;
  canEdit: boolean;
  canShare: boolean;
  canDelete: boolean;
  canReveal: boolean;
};

export type CreateVaultItemInput = {
  type: VaultItemType;
  visibility: VaultVisibility;
  title: string;
  username?: string;
  secret: string;
  websiteUrl?: string;
  notes?: string;
  /** Optional Login-only TOTP setup key or otpauth URI, stored atomically on create. */
  totpSetupKey?: string;
};

export type UpdateVaultItemInput = Partial<Omit<CreateVaultItemInput, "totpSetupKey">> & {
  expectedVersion: number;
};

export type VaultMemberAccess = {
  id: string;
  vaultItemId: string;
  userId: string;
  accessLevel: VaultMemberAccessLevel;
  createdAt: string;
  updatedAt: string;
  member: {
    id: string;
    name: string;
    email: string;
    role: "owner" | "admin" | "member";
  };
};

export type VaultMemberCandidate = {
  id: string;
  name: string;
  email: string;
  role: "owner" | "admin" | "member";
  isCreator: boolean;
  access: { id: string; accessLevel: VaultMemberAccessLevel } | null;
};

export type VaultEmployeeGrant = {
  id: string;
  vaultItemId: string;
  employeeId: string;
  accessLevel: VaultEmployeeAccessLevel;
  createdAt: string;
  updatedAt: string;
  employee: {
    id: string;
    name: string;
    slug: string;
    role: string;
  };
};

export type VaultEmployeeCandidate = {
  id: string;
  name: string;
  slug: string;
  role: string;
  grant: { id: string; accessLevel: VaultEmployeeAccessLevel } | null;
};

function vaultBase(companyId: string): string {
  return `/api/companies/${companyId}/vault`;
}

function itemBase(companyId: string, itemId: string): string {
  return `${vaultBase(companyId)}/items/${itemId}`;
}

export const vaultApi = {
  async listItems(companyId: string): Promise<VaultItem[]> {
    const result = await api.get<{ items: VaultItem[] }>(`${vaultBase(companyId)}/items`);
    return result.items;
  },

  async getItem(companyId: string, itemId: string): Promise<VaultItem> {
    const result = await api.get<{ item: VaultItem }>(itemBase(companyId, itemId));
    return result.item;
  },

  async createItem(companyId: string, input: CreateVaultItemInput): Promise<VaultItem> {
    const result = await api.post<{ item: VaultItem }>(`${vaultBase(companyId)}/items`, input);
    return result.item;
  },

  async updateItem(
    companyId: string,
    itemId: string,
    input: UpdateVaultItemInput,
  ): Promise<VaultItem> {
    const result = await api.patch<{ item: VaultItem }>(itemBase(companyId, itemId), input);
    return result.item;
  },

  deleteItem(companyId: string, itemId: string): Promise<{ ok: true }> {
    return api.del<{ ok: true }>(itemBase(companyId, itemId));
  },

  async revealItem(companyId: string, itemId: string, purpose: "reveal" | "copy"): Promise<string> {
    const result = await api.post<{ secret: string }>(`${itemBase(companyId, itemId)}/reveal`, {
      purpose,
    });
    return result.secret;
  },

  async setTotp(companyId: string, itemId: string, setupKey: string): Promise<VaultItem> {
    const result = await api.post<{ item: VaultItem }>(`${itemBase(companyId, itemId)}/totp`, {
      setupKey,
    });
    return result.item;
  },

  async deleteTotp(companyId: string, itemId: string): Promise<VaultItem> {
    const result = await api.del<{ item: VaultItem }>(`${itemBase(companyId, itemId)}/totp`);
    return result.item;
  },

  async getTotpCode(
    companyId: string,
    itemId: string,
    purpose: "reveal" | "copy",
  ): Promise<{ code: string; expiresAt: string }> {
    return api.post<{ code: string; expiresAt: string }>(
      `${itemBase(companyId, itemId)}/totp/code`,
      { purpose },
    );
  },

  async deletePasskey(companyId: string, itemId: string, passkeyId: string): Promise<VaultItem> {
    const result = await api.del<{ item: VaultItem }>(
      `${itemBase(companyId, itemId)}/passkeys/${passkeyId}`,
    );
    return result.item;
  },

  async listMemberAccess(companyId: string, itemId: string): Promise<VaultMemberAccess[]> {
    const result = await api.get<{ access: VaultMemberAccess[] }>(
      `${itemBase(companyId, itemId)}/member-access`,
    );
    return result.access;
  },

  async listMemberCandidates(companyId: string, itemId: string): Promise<VaultMemberCandidate[]> {
    const result = await api.get<{ candidates: VaultMemberCandidate[] }>(
      `${itemBase(companyId, itemId)}/member-access-candidates`,
    );
    return result.candidates;
  },

  createMemberAccess(
    companyId: string,
    itemId: string,
    userId: string,
    accessLevel: VaultMemberAccessLevel,
  ): Promise<unknown> {
    return api.post(`${itemBase(companyId, itemId)}/member-access`, { userId, accessLevel });
  },

  updateMemberAccess(
    companyId: string,
    itemId: string,
    accessId: string,
    accessLevel: VaultMemberAccessLevel,
  ): Promise<unknown> {
    return api.patch(`${itemBase(companyId, itemId)}/member-access/${accessId}`, { accessLevel });
  },

  deleteMemberAccess(companyId: string, itemId: string, accessId: string): Promise<unknown> {
    return api.del(`${itemBase(companyId, itemId)}/member-access/${accessId}`);
  },

  async listEmployeeGrants(companyId: string, itemId: string): Promise<VaultEmployeeGrant[]> {
    const result = await api.get<{ grants: VaultEmployeeGrant[] }>(
      `${itemBase(companyId, itemId)}/employee-grants`,
    );
    return result.grants;
  },

  async listEmployeeCandidates(
    companyId: string,
    itemId: string,
  ): Promise<VaultEmployeeCandidate[]> {
    const result = await api.get<{ candidates: VaultEmployeeCandidate[] }>(
      `${itemBase(companyId, itemId)}/employee-grant-candidates`,
    );
    return result.candidates;
  },

  createEmployeeGrant(
    companyId: string,
    itemId: string,
    employeeId: string,
    accessLevel: VaultEmployeeAccessLevel,
  ): Promise<unknown> {
    return api.post(`${itemBase(companyId, itemId)}/employee-grants`, {
      employeeId,
      accessLevel,
    });
  },

  updateEmployeeGrant(
    companyId: string,
    itemId: string,
    grantId: string,
    accessLevel: VaultEmployeeAccessLevel,
  ): Promise<unknown> {
    return api.patch(`${itemBase(companyId, itemId)}/employee-grants/${grantId}`, { accessLevel });
  },

  deleteEmployeeGrant(companyId: string, itemId: string, grantId: string): Promise<unknown> {
    return api.del(`${itemBase(companyId, itemId)}/employee-grants/${grantId}`);
  },
};

export const VAULT_ITEM_TYPES: Array<{ value: VaultItemType; label: string }> = [
  { value: "login", label: "Login" },
  { value: "api_key", label: "API key" },
  { value: "secure_note", label: "Secure note" },
];

export function vaultItemTypeLabel(type: VaultItemType): string {
  return VAULT_ITEM_TYPES.find((item) => item.value === type)?.label ?? "Vault item";
}

export function scheduleVaultClipboardClear(secret: string, delayMs = 30_000): void {
  window.setTimeout(() => {
    const clipboard = navigator.clipboard;
    if (!clipboard?.readText || !clipboard?.writeText) return;
    void clipboard
      .readText()
      .then((current) => (current === secret ? clipboard.writeText("") : undefined))
      .catch(() => undefined);
  }, delayMs);
}

export function vaultSecretLabel(type: VaultItemType): string {
  if (type === "login") return "Password";
  if (type === "api_key") return "API key";
  return "Secure note";
}

export function vaultUsernameLabel(type: VaultItemType): string {
  return type === "api_key" ? "Account or key ID" : "Username or email";
}

export function filterVaultItems(
  items: VaultItem[],
  query: string,
  type: VaultItemType | "all",
): VaultItem[] {
  const needle = query.trim().toLocaleLowerCase();
  return items.filter((item) => {
    if (type !== "all" && item.type !== type) return false;
    if (!needle) return true;
    return [
      item.title,
      item.username,
      item.websiteUrl,
      item.notes,
      vaultItemTypeLabel(item.type),
      item.hasTotp ? "authenticator totp two-factor" : "",
      ...(item.passkeys ?? []).flatMap((passkey) => [
        "passkey",
        passkey.rpId,
        passkey.userName ?? "",
        passkey.userDisplayName ?? "",
      ]),
    ]
      .join("\n")
      .toLocaleLowerCase()
      .includes(needle);
  });
}

const PASSWORD_ALPHABETS = [
  "ABCDEFGHJKLMNPQRSTUVWXYZ",
  "abcdefghijkmnopqrstuvwxyz",
  "23456789",
  "!@#$%^&*()-_=+[]{}",
] as const;
const PASSWORD_ALPHABET = PASSWORD_ALPHABETS.join("");

function randomIndex(maxExclusive: number): number {
  if (maxExclusive < 1) throw new Error("Random range must be positive");
  const range = 0x1_0000_0000;
  const limit = range - (range % maxExclusive);
  const sample = new Uint32Array(1);
  do {
    globalThis.crypto.getRandomValues(sample);
  } while (sample[0] >= limit);
  return sample[0] % maxExclusive;
}

function randomCharacter(alphabet: string): string {
  return alphabet[randomIndex(alphabet.length)];
}

/** Generate a cryptographically strong password with every character class. */
export function generateVaultPassword(requestedLength = 24): string {
  const length = Math.max(16, Math.min(128, Math.floor(requestedLength)));
  const characters = PASSWORD_ALPHABETS.map(randomCharacter);
  while (characters.length < length) characters.push(randomCharacter(PASSWORD_ALPHABET));
  for (let index = characters.length - 1; index > 0; index -= 1) {
    const swapAt = randomIndex(index + 1);
    [characters[index], characters[swapAt]] = [characters[swapAt], characters[index]];
  }
  return characters.join("");
}

export function safeVaultWebsiteUrl(value: string): string | null {
  if (!value.trim()) return null;
  try {
    const parsed = new URL(value);
    return (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      !parsed.username &&
      !parsed.password
      ? parsed.toString()
      : null;
  } catch {
    return null;
  }
}
