import { WebSocket as NodeWebSocket } from "ws";
import { finalizeEvent, getPublicKey, type EventTemplate } from "nostr-tools/pure";
import { type Filter } from "nostr-tools/filter";
import { SimplePool, useWebSocketImplementation } from "nostr-tools/pool";
import * as nip04 from "nostr-tools/nip04";
import * as nip19 from "nostr-tools/nip19";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";
import type {
  IntegrationConfig,
  IntegrationProvider,
  IntegrationRuntimeContext,
} from "../types.js";
import { maskSecret } from "../../lib/secret.js";

/**
 * Nostr — protocol-native integration. Each Connection holds one
 * secp256k1 keypair (the `nsec`) and a list of WebSocket relays to
 * publish to and read from. Auth is "API-key" only because Nostr does
 * not have OAuth — the private key *is* the identity.
 *
 * Tools fall into three buckets, each gated by a scope-group bundle so
 * the user can decide what each Connection is allowed to do:
 *
 *   - **Read** — query relays for kind:0 (profiles), kind:1 (notes),
 *     kind:3 (contact lists), and arbitrary filters.
 *   - **Publish** — sign and broadcast new events: text notes, profile
 *     updates, reactions, deletions.
 *   - **DM** — read and send NIP-04 encrypted direct messages
 *     (kind:4). Older spec than NIP-17 but supported by every Nostr
 *     client; gift-wrapped DMs (NIP-17) are not implemented yet.
 *
 * The keypair never leaves the server. `nostr-tools` runs the schnorr
 * signing and NIP-04 encryption in-process; we inject `ws` as the
 * WebSocket implementation since `nostr-tools/pool` runs in Node here,
 * not the browser.
 */

// Node has no global WebSocket. Wire it once at module load so SimplePool
// can open relay connections without each call having to pass it. The
// eslint-disable is a false positive — `useWebSocketImplementation` is
// nostr-tools' setter, not a React hook.
// eslint-disable-next-line react-hooks/rules-of-hooks
useWebSocketImplementation(NodeWebSocket as unknown as typeof WebSocket);

const DEFAULT_RELAYS = [
  "wss://relay.damus.io",
  "wss://nos.lol",
  "wss://relay.snort.social",
  "wss://relay.primal.net",
];

const RELAY_TIMEOUT_MS = 8_000;
const MAX_RELAYS = 16;

const KIND_METADATA = 0;
const KIND_TEXT_NOTE = 1;
const KIND_DM = 4;
const KIND_DELETION = 5;
const KIND_REACTION = 7;

type NostrConfig = {
  /** Private key, 64-char hex. The nsec is decoded once at connect time. */
  privateKey: string;
  /** Public key (x-coord), 64-char hex. */
  publicKey: string;
  /** Bech32-encoded public key — what the user sees in clients. */
  npub: string;
  /** Relay URLs the AI can talk to. Defaults to a small public set if
   * the user didn't supply any. */
  relays: string[];
  /** Display name pulled from kind:0 metadata at connect time, if the
   * user has published one. Used in the account hint. */
  displayName?: string;
};

// --------------------------------------------------------------------------
// Provider
// --------------------------------------------------------------------------

export const nostrProvider: IntegrationProvider = {
  catalog: {
    provider: "nostr",
    name: "Nostr",
    category: "Communication",
    tagline: "Notes, profiles, reactions, encrypted DMs over relays.",
    description:
      "Connect a Nostr identity so AI employees can read notes and profiles, publish text notes and reactions, and exchange NIP-04 encrypted direct messages. Each Connection takes one private key (nsec) and a comma-separated list of relays. The key is encrypted at rest and never leaves the server. If you don't have an nsec yet, generate one in any Nostr client (Damus, Amethyst, Iris, Snort).",
    icon: "Antenna",
    authMode: "apikey",
    fields: [
      {
        key: "nsec",
        label: "Private key (nsec)",
        type: "password",
        placeholder: "nsec1… or 64-char hex",
        required: true,
        hint: "Encrypted at rest. Whoever holds this key controls the identity — generate a fresh one for AI use rather than sharing your personal nsec.",
      },
      {
        key: "relays",
        label: "Relays (comma-separated)",
        type: "text",
        placeholder: "wss://relay.damus.io, wss://nos.lol, wss://relay.snort.social",
        required: false,
        hint: "Defaults to a small set of public relays if blank. Add NIP-50-capable relays (e.g. relay.nostr.band) to enable search.",
      },
    ],
    enabled: true,
  },

  tools: [
    {
      name: "get_self",
      description:
        "Return the npub, hex pubkey, and display-name of the identity this connection holds. Cheap — no relay round-trip.",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
    {
      name: "get_profile",
      description:
        "Fetch the latest kind:0 metadata event for a user (display name, about, picture, NIP-05). Pass `pubkey` (hex or npub).",
      inputSchema: {
        type: "object",
        properties: {
          pubkey: {
            type: "string",
            description: "Hex pubkey or npub1… of the user.",
          },
        },
        required: ["pubkey"],
        additionalProperties: false,
      },
    },
    {
      name: "list_recent_notes",
      description:
        "List recent kind:1 text notes from one or more authors, most recent first.",
      inputSchema: {
        type: "object",
        properties: {
          authors: {
            type: "array",
            items: { type: "string" },
            description: "Hex pubkeys or npub1… handles.",
          },
          limit: { type: "integer", minimum: 1, maximum: 200 },
          since: {
            type: "integer",
            description: "Unix seconds — only return notes after this.",
          },
          until: {
            type: "integer",
            description: "Unix seconds — only return notes before this.",
          },
        },
        required: ["authors"],
        additionalProperties: false,
      },
    },
    {
      name: "search_notes",
      description:
        "Search relays for notes matching a query (NIP-50). Only relays that advertise NIP-50 will return results — relay.nostr.band is the canonical search relay.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string" },
          limit: { type: "integer", minimum: 1, maximum: 200 },
          kinds: {
            type: "array",
            items: { type: "integer" },
            description: "Event kinds to include. Defaults to [1] (text notes).",
          },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
    {
      name: "query_events",
      description:
        "Generic relay query — pass any subset of NIP-01 filter fields (`ids`, `authors`, `kinds`, `since`, `until`, `#e`, `#p`, `limit`, `search`). Returns the union of matching events from every connected relay, deduplicated by event id.",
      inputSchema: {
        type: "object",
        properties: {
          ids: { type: "array", items: { type: "string" } },
          authors: { type: "array", items: { type: "string" } },
          kinds: { type: "array", items: { type: "integer" } },
          since: { type: "integer" },
          until: { type: "integer" },
          limit: { type: "integer", minimum: 1, maximum: 500 },
          search: { type: "string" },
          tagE: {
            type: "array",
            items: { type: "string" },
            description: "Event ids referenced by `#e` tag.",
          },
          tagP: {
            type: "array",
            items: { type: "string" },
            description: "Pubkeys referenced by `#p` tag.",
          },
        },
        additionalProperties: false,
      },
    },
    {
      name: "publish_note",
      description:
        "Sign and broadcast a kind:1 text note on the connection's behalf. Optional `replyTo` makes it a reply to that event id; `mention` p-tags additional users.",
      inputSchema: {
        type: "object",
        properties: {
          content: { type: "string" },
          replyTo: {
            type: "string",
            description: "Event id (hex) to reply to.",
          },
          mention: {
            type: "array",
            items: { type: "string" },
            description: "Pubkeys (hex) to p-tag.",
          },
        },
        required: ["content"],
        additionalProperties: false,
      },
    },
    {
      name: "update_metadata",
      description:
        "Publish a kind:0 metadata event — display name, about, picture, banner, NIP-05, lud16. Replaces any prior metadata.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string" },
          display_name: { type: "string" },
          about: { type: "string" },
          picture: { type: "string", description: "Avatar URL." },
          banner: { type: "string", description: "Banner URL." },
          nip05: { type: "string", description: "NIP-05 verification id, e.g. alice@example.com." },
          lud16: { type: "string", description: "Lightning address." },
          website: { type: "string" },
        },
        additionalProperties: false,
      },
    },
    {
      name: "react_to_note",
      description:
        'Publish a kind:7 reaction. Default reaction is "+", commonly rendered as a like.',
      inputSchema: {
        type: "object",
        properties: {
          eventId: { type: "string", description: "Hex id of the event to react to." },
          authorPubkey: {
            type: "string",
            description: "Hex pubkey of the event's author (for the `p` tag).",
          },
          content: {
            type: "string",
            description: "Reaction text. Empty / `+` / emoji.",
          },
        },
        required: ["eventId", "authorPubkey"],
        additionalProperties: false,
      },
    },
    {
      name: "delete_event",
      description:
        "Publish a kind:5 deletion request for one of your own events. Relays may or may not honour it.",
      inputSchema: {
        type: "object",
        properties: {
          eventId: { type: "string" },
          reason: { type: "string" },
        },
        required: ["eventId"],
        additionalProperties: false,
      },
    },
    {
      name: "send_dm",
      description:
        "Send a NIP-04 encrypted direct message (kind:4) to one user. The body is encrypted with the shared ECDH secret and only the recipient can decrypt it.",
      inputSchema: {
        type: "object",
        properties: {
          recipient: {
            type: "string",
            description: "Recipient hex pubkey or npub1… handle.",
          },
          content: { type: "string" },
        },
        required: ["recipient", "content"],
        additionalProperties: false,
      },
    },
    {
      name: "list_dms",
      description:
        "Fetch recent NIP-04 DMs to or from this identity. Returns events with their decrypted plaintext when the connection holds the right private key, or `null` if decryption fails.",
      inputSchema: {
        type: "object",
        properties: {
          counterparty: {
            type: "string",
            description:
              "Hex pubkey or npub of the other side. When unset, returns DMs with everyone, most recent first.",
          },
          limit: { type: "integer", minimum: 1, maximum: 200 },
          since: { type: "integer" },
          until: { type: "integer" },
        },
        additionalProperties: false,
      },
    },
  ],

  async validateApiKey(input) {
    const rawNsec = (input.nsec ?? "").trim();
    if (!rawNsec) throw new Error("Private key (nsec) is required");
    const sk = decodeNsec(rawNsec);
    const pubkey = getPublicKey(sk);
    const npub = nip19.npubEncode(pubkey);
    const relays = parseRelays(input.relays ?? "");

    // Try once to fetch the user's own kind:0 metadata so the account hint
    // can show a display name. Failure is non-fatal — a brand-new identity
    // legitimately has no metadata yet.
    let displayName: string | undefined;
    try {
      const event = await fetchOne(relays, {
        kinds: [KIND_METADATA],
        authors: [pubkey],
        limit: 1,
      });
      if (event) {
        const parsed = safeJsonObject(event.content);
        const name =
          (typeof parsed?.display_name === "string" && parsed.display_name) ||
          (typeof parsed?.name === "string" && parsed.name) ||
          undefined;
        if (name) displayName = name;
      }
    } catch {
      // ignore — relays may be unreachable, that's the user's problem at runtime
    }

    const cfg: NostrConfig = {
      privateKey: bytesToHex(sk),
      publicKey: pubkey,
      npub,
      relays,
      displayName,
    };
    const display = displayName ? `${displayName} · ${shortNpub(npub)}` : shortNpub(npub);
    const accountHint = `${display} · ${maskSecret(rawNsec)}`;
    return { config: cfg as unknown as IntegrationConfig, accountHint };
  },

  async checkStatus(ctx) {
    const cfg = ctx.config as NostrConfig;
    if (!cfg.privateKey || !cfg.publicKey) {
      return { ok: false, message: "Connection is missing key material." };
    }
    if (cfg.relays.length === 0) {
      return { ok: false, message: "No relays configured." };
    }
    // Open + close a single relay to confirm at least one is reachable.
    const ok = await pingAnyRelay(cfg.relays);
    return ok
      ? { ok: true }
      : {
          ok: false,
          message: `Could not connect to any relay: ${cfg.relays.join(", ")}`,
        };
  },

  async invokeTool(name, args, ctx) {
    const cfg = ctx.config as NostrConfig;
    const a = (args as Record<string, unknown>) ?? {};
    const sk = hexToBytes(cfg.privateKey);
    const relays = cfg.relays.length > 0 ? cfg.relays : DEFAULT_RELAYS;

    switch (name) {
      case "get_self":
        return {
          pubkey: cfg.publicKey,
          npub: cfg.npub,
          displayName: cfg.displayName ?? null,
          relays,
        };

      case "get_profile": {
        const pubkey = decodePubkey(requireString(a.pubkey, "pubkey"));
        const event = await fetchOne(relays, {
          kinds: [KIND_METADATA],
          authors: [pubkey],
          limit: 1,
        });
        if (!event) return null;
        return {
          ...event,
          parsed: safeJsonObject(event.content) ?? null,
        };
      }

      case "list_recent_notes": {
        if (!Array.isArray(a.authors) || a.authors.length === 0) {
          throw new Error("authors must be a non-empty array of pubkeys");
        }
        const authors = (a.authors as unknown[]).map((p) =>
          decodePubkey(requireString(p, "authors[]")),
        );
        const filter: Record<string, unknown> = {
          kinds: [KIND_TEXT_NOTE],
          authors,
          limit: clampInt(a.limit, 1, 200, 25),
        };
        if (typeof a.since === "number") filter.since = Math.floor(a.since);
        if (typeof a.until === "number") filter.until = Math.floor(a.until);
        return queryRelays(relays, filter);
      }

      case "search_notes": {
        const query = requireString(a.query, "query");
        const filter: Record<string, unknown> = {
          search: query,
          kinds: Array.isArray(a.kinds) && a.kinds.length > 0 ? a.kinds : [KIND_TEXT_NOTE],
          limit: clampInt(a.limit, 1, 200, 25),
        };
        return queryRelays(relays, filter);
      }

      case "query_events": {
        const filter: Record<string, unknown> = {};
        if (Array.isArray(a.ids)) filter.ids = a.ids;
        if (Array.isArray(a.authors)) {
          filter.authors = (a.authors as unknown[]).map((p) =>
            decodePubkey(requireString(p, "authors[]")),
          );
        }
        if (Array.isArray(a.kinds)) filter.kinds = a.kinds;
        if (typeof a.since === "number") filter.since = Math.floor(a.since);
        if (typeof a.until === "number") filter.until = Math.floor(a.until);
        if (typeof a.search === "string") filter.search = a.search;
        if (Array.isArray(a.tagE)) filter["#e"] = a.tagE;
        if (Array.isArray(a.tagP)) filter["#p"] = a.tagP;
        filter.limit = clampInt(a.limit, 1, 500, 50);
        return queryRelays(relays, filter);
      }

      case "publish_note": {
        const content = requireString(a.content, "content");
        const tags: string[][] = [];
        if (typeof a.replyTo === "string" && a.replyTo.trim()) {
          tags.push(["e", a.replyTo.trim(), "", "reply"]);
        }
        if (Array.isArray(a.mention)) {
          for (const p of a.mention as unknown[]) {
            if (typeof p === "string" && p.trim()) {
              tags.push(["p", decodePubkey(p.trim())]);
            }
          }
        }
        const tmpl: EventTemplate = {
          kind: KIND_TEXT_NOTE,
          created_at: nowSeconds(),
          tags,
          content,
        };
        return publishSigned(relays, finalizeEvent(tmpl, sk));
      }

      case "update_metadata": {
        const profile: Record<string, string> = {};
        for (const k of [
          "name",
          "display_name",
          "about",
          "picture",
          "banner",
          "nip05",
          "lud16",
          "website",
        ]) {
          const v = a[k];
          if (typeof v === "string") profile[k] = v;
        }
        if (Object.keys(profile).length === 0) {
          throw new Error("Pass at least one profile field to update_metadata");
        }
        const tmpl: EventTemplate = {
          kind: KIND_METADATA,
          created_at: nowSeconds(),
          tags: [],
          content: JSON.stringify(profile),
        };
        return publishSigned(relays, finalizeEvent(tmpl, sk));
      }

      case "react_to_note": {
        const eventId = requireString(a.eventId, "eventId");
        const authorPubkey = decodePubkey(requireString(a.authorPubkey, "authorPubkey"));
        const content = typeof a.content === "string" && a.content ? a.content : "+";
        const tmpl: EventTemplate = {
          kind: KIND_REACTION,
          created_at: nowSeconds(),
          tags: [
            ["e", eventId],
            ["p", authorPubkey],
          ],
          content,
        };
        return publishSigned(relays, finalizeEvent(tmpl, sk));
      }

      case "delete_event": {
        const eventId = requireString(a.eventId, "eventId");
        const tmpl: EventTemplate = {
          kind: KIND_DELETION,
          created_at: nowSeconds(),
          tags: [["e", eventId]],
          content: typeof a.reason === "string" ? a.reason : "",
        };
        return publishSigned(relays, finalizeEvent(tmpl, sk));
      }

      case "send_dm": {
        const recipient = decodePubkey(requireString(a.recipient, "recipient"));
        const content = requireString(a.content, "content");
        const ciphertext = await nip04.encrypt(sk, recipient, content);
        const tmpl: EventTemplate = {
          kind: KIND_DM,
          created_at: nowSeconds(),
          tags: [["p", recipient]],
          content: ciphertext,
        };
        return publishSigned(relays, finalizeEvent(tmpl, sk));
      }

      case "list_dms": {
        const limit = clampInt(a.limit, 1, 200, 50);
        const filterIn: Record<string, unknown> = {
          kinds: [KIND_DM],
          "#p": [cfg.publicKey],
          limit,
        };
        const filterOut: Record<string, unknown> = {
          kinds: [KIND_DM],
          authors: [cfg.publicKey],
          limit,
        };
        if (typeof a.since === "number") {
          filterIn.since = filterOut.since = Math.floor(a.since);
        }
        if (typeof a.until === "number") {
          filterIn.until = filterOut.until = Math.floor(a.until);
        }
        if (typeof a.counterparty === "string" && a.counterparty.trim()) {
          const cp = decodePubkey(a.counterparty.trim());
          filterIn.authors = [cp];
          filterOut["#p"] = [cp];
        }
        const [incoming, outgoing] = await Promise.all([
          queryRelays(relays, filterIn),
          queryRelays(relays, filterOut),
        ]);
        const merged = [...incoming, ...outgoing];
        const seen = new Set<string>();
        const unique = merged.filter((e) => {
          if (seen.has(e.id)) return false;
          seen.add(e.id);
          return true;
        });
        unique.sort((a, b) => b.created_at - a.created_at);
        const out: Array<Record<string, unknown>> = [];
        for (const e of unique.slice(0, limit)) {
          const counterpartyPubkey =
            e.pubkey === cfg.publicKey
              ? extractRecipient(e)
              : e.pubkey;
          let plaintext: string | null = null;
          try {
            plaintext = counterpartyPubkey
              ? await nip04.decrypt(sk, counterpartyPubkey, e.content)
              : null;
          } catch {
            plaintext = null;
          }
          out.push({
            ...e,
            direction: e.pubkey === cfg.publicKey ? "outgoing" : "incoming",
            counterparty: counterpartyPubkey,
            plaintext,
          });
        }
        return out;
      }

      default:
        throw new Error(`Unknown Nostr tool: ${name}`);
    }
  },
};

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

type RelayEvent = {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
};

function _ctxUnused(_: IntegrationRuntimeContext): void {
  // Reserved for symmetry with other providers that update tokens via
  // ctx.setConfig — Nostr never refreshes credentials.
}
void _ctxUnused;

function decodeNsec(input: string): Uint8Array {
  const trimmed = input.trim();
  if (trimmed.startsWith("nsec1")) {
    let decoded;
    try {
      decoded = nip19.decode(trimmed);
    } catch (err) {
      throw new Error(
        `Could not decode nsec: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (decoded.type !== "nsec") {
      throw new Error(`Expected nsec, got ${decoded.type}`);
    }
    return decoded.data as Uint8Array;
  }
  if (!/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    throw new Error(
      "Private key must be either nsec1… (bech32) or 64 hex characters.",
    );
  }
  return hexToBytes(trimmed);
}

function decodePubkey(input: string): string {
  const trimmed = input.trim();
  if (trimmed.startsWith("npub1")) {
    let decoded;
    try {
      decoded = nip19.decode(trimmed);
    } catch (err) {
      throw new Error(
        `Could not decode npub: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (decoded.type !== "npub") {
      throw new Error(`Expected npub, got ${decoded.type}`);
    }
    return decoded.data;
  }
  if (!/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    throw new Error("Pubkey must be either npub1… or 64 hex characters.");
  }
  return trimmed.toLowerCase();
}

function parseRelays(input: string): string[] {
  const parts = input
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const out: string[] = [];
  for (const p of parts) {
    if (!/^wss?:\/\//.test(p)) {
      throw new Error(`Relay URL must start with wss:// or ws:// — got "${p}"`);
    }
    if (out.length >= MAX_RELAYS) {
      throw new Error(`Too many relays — keep it under ${MAX_RELAYS}.`);
    }
    out.push(p.replace(/\/+$/, ""));
  }
  return out.length > 0 ? out : [...DEFAULT_RELAYS];
}

async function queryRelays(
  relays: string[],
  filter: Record<string, unknown>,
): Promise<RelayEvent[]> {
  const pool = new SimplePool();
  try {
    const events = (await Promise.race([
      pool.querySync(relays, filter as Filter),
      timeout<RelayEvent[]>(RELAY_TIMEOUT_MS, "querySync"),
    ])) as RelayEvent[];
    // Deduplicate by id (multiple relays often return the same event).
    const seen = new Set<string>();
    return events.filter((e) => {
      if (!e || typeof e.id !== "string") return false;
      if (seen.has(e.id)) return false;
      seen.add(e.id);
      return true;
    });
  } finally {
    pool.close(relays);
  }
}

async function fetchOne(
  relays: string[],
  filter: Record<string, unknown>,
): Promise<RelayEvent | null> {
  const events = await queryRelays(relays, { ...filter, limit: 1 });
  return events[0] ?? null;
}

async function publishSigned(
  relays: string[],
  signed: RelayEvent,
): Promise<{ event: RelayEvent; results: { relay: string; ok: boolean; reason?: string }[] }> {
  const pool = new SimplePool();
  try {
    const results = await Promise.all(
      pool.publish(relays, signed).map((p, i) =>
        Promise.race([
          p
            .then(() => ({ relay: relays[i], ok: true as const }))
            .catch((err) => ({
              relay: relays[i],
              ok: false as const,
              reason: err instanceof Error ? err.message : String(err),
            })),
          timeout<{ relay: string; ok: false; reason: string }>(
            RELAY_TIMEOUT_MS,
            "publish",
          ).then(() => ({
            relay: relays[i],
            ok: false as const,
            reason: "publish timed out",
          })),
        ]),
      ),
    );
    const accepted = results.filter((r) => r.ok).length;
    if (accepted === 0) {
      const why = results
        .map((r) => `${r.relay}: ${r.ok ? "?" : r.reason}`)
        .join("; ");
      throw new Error(`No relay accepted the event — ${why}`);
    }
    return { event: signed, results };
  } finally {
    pool.close(relays);
  }
}

async function pingAnyRelay(relays: string[]): Promise<boolean> {
  const probes = relays.map(
    (r) =>
      new Promise<boolean>((resolve) => {
        let settled = false;
        const ws = new NodeWebSocket(r);
        const done = (v: boolean) => {
          if (settled) return;
          settled = true;
          try {
            ws.close();
          } catch {
            /* swallow */
          }
          resolve(v);
        };
        ws.on("open", () => done(true));
        ws.on("error", () => done(false));
        setTimeout(() => done(false), RELAY_TIMEOUT_MS);
      }),
  );
  const results = await Promise.all(probes);
  return results.some(Boolean);
}

function timeout<T>(ms: number, label: string): Promise<T> {
  return new Promise((_resolve, reject) => {
    setTimeout(() => reject(new Error(`Nostr ${label} timed out after ${ms}ms`)), ms);
  });
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function safeJsonObject(s: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(s);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // fall through
  }
  return null;
}

function shortNpub(npub: string): string {
  if (npub.length <= 14) return npub;
  return `${npub.slice(0, 8)}…${npub.slice(-4)}`;
}

function extractRecipient(event: RelayEvent): string | null {
  for (const t of event.tags) {
    if (t[0] === "p" && typeof t[1] === "string") return t[1];
  }
  return null;
}

function requireString(v: unknown, name: string): string {
  if (typeof v !== "string" || !v.trim()) {
    throw new Error(`${name} is required`);
  }
  return v.trim();
}

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return fallback;
  const i = Math.floor(v);
  if (i < min) return min;
  if (i > max) return max;
  return i;
}
