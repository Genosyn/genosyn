import type crypto from "node:crypto";

import { readField, readStringField } from "./client.js";
import {
  BitwardenCryptoError,
  type BitwardenSymmetricKey,
  decryptEncStringToText,
} from "./encString.js";
import {
  unwrapBitwardenOrganizationKey,
  unwrapBitwardenPrivateKey,
  unwrapBitwardenSymmetricKey,
} from "./keys.js";

/**
 * Turning a decrypted Bitwarden vault into the small, boring shape Genosyn's
 * own Vault understands.
 *
 * Only Logins and Secure notes cross over. Cards, identities, SSH keys and the
 * newer record types have no counterpart in a Genosyn Vault item, and
 * inventing one would mean guessing which field is "the secret" — so they are
 * skipped and counted rather than mangled.
 *
 * The one non-obvious rule here is the per-item key. A cipher may carry its own
 * `key`, wrapped by the user or organization key; when it does, **every other
 * field of that cipher is encrypted under that key instead**. Missing this is
 * the classic third-party client bug, and it presents as an integrity failure
 * on every field of some items rather than as a missing feature.
 */

export type BitwardenItemType = "login" | "secure_note";

export type BitwardenItem = {
  /** The cipher id, stable across edits. */
  id: string;
  type: BitwardenItemType;
  title: string;
  username: string;
  secret: string;
  websiteUrl: string;
  /** The raw TOTP setup value — an `otpauth://` URI or a bare base32 seed. */
  totpSetupKey: string | null;
  organizationId: string | null;
  /** Folder and collection names, for the optional scope filter. */
  scopeNames: string[];
  revisionDate: string;
};

export type BitwardenVaultKeys = {
  userKey: BitwardenSymmetricKey;
  organizationKeys: Map<string, BitwardenSymmetricKey>;
};

/**
 * Unwrap every key the sync response's ciphers can be encrypted under.
 *
 * An organization key is RSA-encapsulated to the account's public key, so the
 * account private key has to be recovered first. A vault with no organizations
 * never needs it, and an account whose private key is unreadable should still
 * be able to use its personal items — hence the per-organization tolerance.
 */
export function readBitwardenVaultKeys(
  sync: unknown,
  userKey: BitwardenSymmetricKey,
): BitwardenVaultKeys {
  const profile = readField(sync, "profile");
  const organizations = readField(profile, "organizations");
  const organizationKeys = new Map<string, BitwardenSymmetricKey>();
  if (!Array.isArray(organizations) || organizations.length === 0) {
    return { userKey, organizationKeys };
  }
  const protectedPrivateKey = readStringField(profile, "privateKey");
  if (!protectedPrivateKey) return { userKey, organizationKeys };
  let privateKey: crypto.KeyObject;
  try {
    privateKey = unwrapBitwardenPrivateKey(protectedPrivateKey, userKey);
  } catch {
    return { userKey, organizationKeys };
  }
  for (const organization of organizations) {
    const id = readStringField(organization, "id");
    const wrapped = readStringField(organization, "key");
    if (!id || !wrapped) continue;
    try {
      organizationKeys.set(id, unwrapBitwardenOrganizationKey(wrapped, privateKey));
    } catch {
      // One unreadable organization must not cost the rest of the vault.
    }
  }
  return { userKey, organizationKeys };
}

/**
 * Decrypt the folder and collection names a cipher can be filed under, so an
 * operator can narrow a sync to one of them by name.
 */
export function readBitwardenScopeNames(
  sync: unknown,
  keys: BitwardenVaultKeys,
): { folders: Map<string, string>; collections: Map<string, string> } {
  const folders = new Map<string, string>();
  const collections = new Map<string, string>();
  const folderRows = readField(sync, "folders");
  if (Array.isArray(folderRows)) {
    for (const folder of folderRows) {
      const id = readStringField(folder, "id");
      const name = readStringField(folder, "name");
      if (!id || !name) continue;
      const decrypted = tryDecrypt(name, keys.userKey);
      if (decrypted !== null) folders.set(id, decrypted);
    }
  }
  const collectionRows = readField(sync, "collections");
  if (Array.isArray(collectionRows)) {
    for (const collection of collectionRows) {
      const id = readStringField(collection, "id");
      const name = readStringField(collection, "name");
      const organizationId = readStringField(collection, "organizationId");
      if (!id || !name) continue;
      const key = organizationId ? keys.organizationKeys.get(organizationId) : keys.userKey;
      if (!key) continue;
      const decrypted = tryDecrypt(name, key);
      if (decrypted !== null) collections.set(id, decrypted);
    }
  }
  return { folders, collections };
}

function tryDecrypt(value: string, key: BitwardenSymmetricKey): string | null {
  try {
    return decryptEncStringToText(value, key);
  } catch {
    return null;
  }
}

/** Resolve the key every encrypted field of one cipher is protected by. */
function contentKeyFor(cipher: unknown, keys: BitwardenVaultKeys): BitwardenSymmetricKey {
  const organizationId = readStringField(cipher, "organizationId");
  const vaultKey = organizationId ? keys.organizationKeys.get(organizationId) : keys.userKey;
  if (!vaultKey) {
    throw new BitwardenCryptoError("No key for that Bitwarden organization");
  }
  const itemKey = readStringField(cipher, "key");
  return itemKey ? unwrapBitwardenSymmetricKey(itemKey, vaultKey) : vaultKey;
}

/**
 * Read the encrypted properties of a cipher.
 *
 * Current servers still populate the typed `name` / `login` / `notes` fields
 * alongside the canonical `data` blob, so those are read first. A cipher whose
 * whole payload is one opaque ciphertext has no typed fields at all; its `data`
 * is not JSON, and it is reported as unreadable rather than half-decoded.
 */
function cipherFields(cipher: unknown): {
  name: string | null;
  notes: string | null;
  username: string | null;
  password: string | null;
  totp: string | null;
  uris: string[];
} {
  const login = readField(cipher, "login");
  let name = readStringField(cipher, "name");
  let notes = readStringField(cipher, "notes");
  let username = readStringField(login, "username");
  let password = readStringField(login, "password");
  let totp = readStringField(login, "totp");
  const uris: string[] = [];
  const uriRows = readField(login, "uris");
  if (Array.isArray(uriRows)) {
    for (const row of uriRows) {
      const uri = readStringField(row, "uri");
      if (uri) uris.push(uri);
    }
  }

  if (name === null) {
    const rawData = readField(cipher, "data");
    if (typeof rawData === "string" && rawData.trim().startsWith("{")) {
      let data: unknown = null;
      try {
        data = JSON.parse(rawData);
      } catch {
        data = null;
      }
      name = name ?? readStringField(data, "Name");
      notes = notes ?? readStringField(data, "Notes");
      username = username ?? readStringField(data, "Username");
      password = password ?? readStringField(data, "Password");
      totp = totp ?? readStringField(data, "Totp");
      if (uris.length === 0) {
        const dataUris = readField(data, "Uris");
        if (Array.isArray(dataUris)) {
          for (const row of dataUris) {
            const uri = readStringField(row, "Uri");
            if (uri) uris.push(uri);
          }
        }
      }
    }
  }

  return { name, notes, username, password, totp, uris };
}

/**
 * Pick the website a Login is for.
 *
 * Bitwarden stores whatever the user typed, which is often a bare host and is
 * sometimes not a URL at all — `androidapp://…`, `regexp:…`, or a stray word.
 * A bare host is worth completing to `https://`, but only when it actually
 * looks like one: turning `notes` into `https://notes/` would put a website on
 * an item that has none, and the Browser's exact-origin check deserves a real
 * origin or nothing.
 */
function firstWebsiteUrl(uris: string[], key: BitwardenSymmetricKey): string {
  for (const encrypted of uris) {
    const decrypted = tryDecrypt(encrypted, key)?.trim();
    if (!decrypted) continue;
    let candidate = decrypted;
    if (!/^https?:\/\//i.test(decrypted)) {
      if (/^[a-z][a-z0-9+.-]*:/i.test(decrypted)) continue;
      const host = decrypted.split(/[/?#]/, 1)[0];
      if (!host.includes(".") && host.toLowerCase() !== "localhost") continue;
      candidate = `https://${decrypted}`;
    }
    try {
      const url = new URL(candidate);
      if (
        (url.protocol === "http:" || url.protocol === "https:") &&
        !url.username &&
        !url.password
      ) {
        return url.toString();
      }
    } catch {
      // Bitwarden accepts match patterns that are not URLs; skip those.
    }
  }
  return "";
}

/**
 * Convert one cipher into a Genosyn-shaped item, or null when it is not
 * something the Vault can represent (a card, a trashed item, an unreadable
 * blob).
 */
export function decodeBitwardenCipher(
  cipher: unknown,
  keys: BitwardenVaultKeys,
  scopes: { folders: Map<string, string>; collections: Map<string, string> },
): BitwardenItem | null {
  const id = readStringField(cipher, "id");
  if (!id) return null;
  if (readField(cipher, "deletedDate")) return null;
  const rawType = readField(cipher, "type");
  const type = rawType === 1 ? "login" : rawType === 2 ? "secure_note" : null;
  if (!type) return null;

  const key = contentKeyFor(cipher, keys);
  const fields = cipherFields(cipher);
  if (fields.name === null) return null;
  const title = tryDecrypt(fields.name, key);
  if (title === null) return null;

  const notes = fields.notes ? (tryDecrypt(fields.notes, key) ?? "") : "";
  const secret =
    type === "secure_note"
      ? notes
      : fields.password
        ? (tryDecrypt(fields.password, key) ?? "")
        : "";

  const scopeNames: string[] = [];
  const folderId = readStringField(cipher, "folderId");
  const folderName = folderId ? scopes.folders.get(folderId) : undefined;
  if (folderName) scopeNames.push(folderName);
  const collectionIds = readField(cipher, "collectionIds");
  if (Array.isArray(collectionIds)) {
    for (const collectionId of collectionIds) {
      const name =
        typeof collectionId === "string" ? scopes.collections.get(collectionId) : undefined;
      if (name) scopeNames.push(name);
    }
  }

  return {
    id,
    type,
    title: title.trim() || "Untitled Bitwarden item",
    username: fields.username ? (tryDecrypt(fields.username, key) ?? "") : "",
    secret,
    websiteUrl: type === "login" ? firstWebsiteUrl(fields.uris, key) : "",
    totpSetupKey: fields.totp ? tryDecrypt(fields.totp, key) : null,
    organizationId: readStringField(cipher, "organizationId"),
    scopeNames,
    revisionDate: readStringField(cipher, "revisionDate") ?? "",
  };
}

export type BitwardenVaultRead = {
  items: BitwardenItem[];
  /** Ciphers Genosyn deliberately did not mirror, by reason. */
  skipped: { unsupportedType: number; unreadable: number };
  /**
   * Ids of ciphers that exist but could not be decoded this pass. They are
   * emphatically *not* absent from the vault, so a sync must leave their
   * mirrors — and the Grants attached to them — alone.
   */
  unreadableIds: string[];
};

/** Decode every cipher in a sync response, keeping count of what was skipped. */
export function readBitwardenVault(
  sync: unknown,
  userKey: BitwardenSymmetricKey,
): BitwardenVaultRead {
  const keys = readBitwardenVaultKeys(sync, userKey);
  const scopes = readBitwardenScopeNames(sync, keys);
  const ciphers = readField(sync, "ciphers");
  const items: BitwardenItem[] = [];
  const skipped = { unsupportedType: 0, unreadable: 0 };
  const unreadableIds: string[] = [];
  if (!Array.isArray(ciphers)) return { items, skipped, unreadableIds };
  for (const cipher of ciphers) {
    const rawType = readField(cipher, "type");
    if (rawType !== 1 && rawType !== 2) {
      if (!readField(cipher, "deletedDate")) skipped.unsupportedType += 1;
      continue;
    }
    const noteUnreadable = () => {
      skipped.unreadable += 1;
      const id = readStringField(cipher, "id");
      if (id) unreadableIds.push(id);
    };
    try {
      const item = decodeBitwardenCipher(cipher, keys, scopes);
      if (item) items.push(item);
      else if (!readField(cipher, "deletedDate")) noteUnreadable();
    } catch {
      noteUnreadable();
    }
  }
  return { items, skipped, unreadableIds };
}
