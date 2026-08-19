import { AppDataSource } from "../db/datasource.js";
import { AppSetting } from "../db/entities/AppSetting.js";
import { decryptSecret, encryptSecret } from "../lib/secret.js";
import { googleRedirectUri } from "../integrations/providers/google/auth.js";
import { githubRedirectUri } from "../integrations/providers/github-oauth.js";
import { linkedinRedirectUri } from "../integrations/providers/linkedin.js";
import { microsoftRedirectUri } from "../integrations/providers/microsoft-ads.js";
import { redditRedirectUri } from "../integrations/providers/reddit.js";
import { xRedirectUri } from "../integrations/providers/x.js";
import { listCatalog } from "../integrations/index.js";
import type { OauthApp } from "./oauth.js";

/**
 * Install-wide OAuth apps — register the client credentials **once** for the
 * whole deployment instead of once per Connection.
 *
 * Historically every Connection carried its own `clientId` + `clientSecret`,
 * which meant the person connecting a Gmail mailbox first had to create a
 * Google Cloud project, enable the API, configure a consent screen, register a
 * Web OAuth client, and paste two secrets into the connect modal — and then do
 * it all again for the next mailbox, and again in the next company. That
 * ceremony, not the consent screen, is what made connecting an email account
 * hard.
 *
 * A master admin now registers each OAuth app once at Admin → Integrations.
 * After that, `startOauth` falls back to the registered credentials whenever a
 * Connection doesn't bring its own, so connecting Gmail is: click Google →
 * approve on Google's screen → done. Nothing to type.
 *
 * Storage is a single JSON `AppSetting` row, the same mechanism the global
 * SMTP override and the Web Push VAPID keypair use — so this is a settings
 * change, not a schema change. Client secrets are encrypted at rest with the
 * instance key (`lib/secret.ts`) and are only ever decrypted into memory to
 * build an authorize URL or exchange a code; they are never returned to the
 * client.
 *
 * Per-Connection credentials still work and still win. An install can mix the
 * two: register a shared Google app for the team, and let one company bring
 * its own client for a Workspace tenant that requires it.
 */

export const OAUTH_APPS_SETTING_KEY = "oauth.apps";

/** Static, non-secret description of one registerable OAuth app. */
export type OauthAppInfo = {
  app: OauthApp;
  /** Display name, e.g. "Google". */
  label: string;
  /** Where the operator registers the client. */
  consoleUrl: string;
  /** Short, ordered setup steps rendered above the form. */
  steps: string[];
};

/** Non-secret view of one app's registration, safe to return to the client. */
export type OauthAppDescriptor = OauthAppInfo & {
  /** Names of the catalog integrations this one registration unlocks, derived
   * from the provider registry so the copy can never drift from reality —
   * several integrations share an app (`google` covers Workspace, Analytics,
   * Search Console, and Ads). */
  unlocks: string[];
  /** True when a usable clientId + clientSecret are stored. */
  configured: boolean;
  /** Client ids are not secrets — showing them lets an admin confirm which
   * app is wired up without re-reading Google Cloud Console. */
  clientId: string;
  /** Whether a secret is on file (never the value itself). */
  hasClientSecret: boolean;
  /** The exact URI the operator must allow-list on the provider's side. */
  redirectUri: string;
  updatedAt: string | null;
};

/** Payload the admin form submits. */
export type OauthAppInput = {
  clientId: string;
  /** Blank means "keep the secret currently stored". */
  clientSecret: string;
};

/** Shape persisted per app inside the `AppSetting` JSON value. */
type StoredOauthApp = {
  clientId: string;
  /** Encrypted; empty string when no secret is stored. */
  encryptedClientSecret: string;
  updatedAt: string;
};

type StoredOauthApps = Partial<Record<OauthApp, StoredOauthApp>>;

/**
 * The apps an operator can register, in the order the admin page lists them.
 * Google leads because email is the reason most installs come here.
 *
 * `redirectUri` is a thunk rather than a value: it resolves against the
 * instance public URL, which a master admin can change at runtime from
 * Admin → General.
 */
const OAUTH_APP_CATALOG: Array<OauthAppInfo & { redirectUri: () => string }> = [
  {
    app: "google",
    label: "Google",
    consoleUrl: "https://console.cloud.google.com/apis/credentials",
    steps: [
      "Google Cloud Console → APIs & Services → Credentials → Create credentials → OAuth client ID.",
      "Pick Web application, then add the redirect URI below under Authorized redirect URIs.",
      "Enable the APIs you want on the project — Gmail API for email, Drive/Calendar for the rest.",
      "Paste the Client ID and Client Secret here.",
    ],
    redirectUri: googleRedirectUri,
  },
  {
    app: "github",
    label: "GitHub",
    consoleUrl: "https://github.com/settings/developers",
    steps: [
      "github.com → Settings → Developer settings → OAuth Apps → New OAuth App.",
      "Set the Homepage URL to this instance and paste the redirect URI below as the Authorization callback URL.",
      "Generate a client secret, then paste both values here.",
    ],
    redirectUri: githubRedirectUri,
  },
  {
    app: "microsoft",
    label: "Microsoft",
    consoleUrl: "https://portal.azure.com",
    steps: [
      "Azure portal → Microsoft Entra ID → App registrations → New registration.",
      "Choose the Web platform and add the redirect URI below.",
      "Certificates & secrets → New client secret, then paste the Application (client) ID and the secret value here.",
    ],
    redirectUri: microsoftRedirectUri,
  },
  {
    app: "linkedin",
    label: "LinkedIn",
    consoleUrl: "https://www.linkedin.com/developers/apps",
    steps: [
      "LinkedIn Developer Portal → your app → Auth → add the redirect URI below.",
      "Products → enable “Sign In with LinkedIn using OpenID Connect” and “Share on LinkedIn”.",
      "Paste the Client ID and Primary Client Secret here.",
    ],
    redirectUri: linkedinRedirectUri,
  },
  {
    app: "reddit",
    label: "Reddit",
    consoleUrl: "https://www.reddit.com/prefs/apps",
    steps: [
      "reddit.com/prefs/apps → create another app… → choose the web app type.",
      "Set the redirect uri to the URI below.",
      "Paste the client id (under the app name) and the secret here.",
    ],
    redirectUri: redditRedirectUri,
  },
  {
    app: "x",
    label: "X",
    consoleUrl: "https://developer.x.com/en/portal/dashboard",
    steps: [
      "X Developer Portal → your project → User authentication settings.",
      "Turn on OAuth 2.0, pick the Web App type, and add the callback URI below.",
      "Paste the OAuth 2.0 Client ID and Client Secret here.",
    ],
    redirectUri: xRedirectUri,
  },
];

const CATALOG_BY_APP = new Map(OAUTH_APP_CATALOG.map((entry) => [entry.app, entry]));

export function isRegisterableOauthApp(value: string): value is OauthApp {
  return CATALOG_BY_APP.has(value as OauthApp);
}

/**
 * Read + parse the settings row, tolerating a corrupt or partial value.
 *
 * Deliberately uncached, like `ssoSettings.ts` — the closest precedent, and
 * also an admin-managed OAuth client. One row holds *all* the apps, so every
 * write is a read-modify-write of the whole map; a cached snapshot would let a
 * replica serialize a stale map back over the row and erase registrations it
 * never saw, or keep minting authorize URLs from a client an admin has already
 * revoked. Both reads are cheap and cold: the catalog endpoint and the start
 * of an OAuth handshake.
 */
async function readStored(): Promise<{ apps: StoredOauthApps; rawValue: string }> {
  const repo = AppDataSource.getRepository(AppSetting);
  const row = await repo.findOneBy({ key: OAUTH_APPS_SETTING_KEY });
  const rawValue = row?.value ?? "";
  return { apps: parseStored(rawValue), rawValue };
}

/** Exported for tests: the tolerant parse of a stored settings value. */
export function parseStored(value: string): StoredOauthApps {
  if (!value) return {};
  let raw: unknown;
  try {
    raw = JSON.parse(value);
  } catch {
    // A corrupt row must not break every connect flow on the install — treat
    // it as "nothing registered" and let the admin page rewrite it.
    // eslint-disable-next-line no-console
    console.warn("[oauth] registered OAuth apps setting is not valid JSON; ignoring it");
    return {};
  }
  if (!raw || typeof raw !== "object") return {};
  const out: StoredOauthApps = {};
  for (const [key, entry] of Object.entries(raw as Record<string, unknown>)) {
    if (!isRegisterableOauthApp(key)) continue;
    if (!entry || typeof entry !== "object") continue;
    const o = entry as Record<string, unknown>;
    const clientId = typeof o.clientId === "string" ? o.clientId : "";
    if (!clientId) continue;
    out[key] = {
      clientId,
      encryptedClientSecret:
        typeof o.encryptedClientSecret === "string" ? o.encryptedClientSecret : "",
      updatedAt: typeof o.updatedAt === "string" ? o.updatedAt : "",
    };
  }
  return out;
}

/**
 * Compare-and-swap the settings row against the value the caller read, the
 * same conditional-write shape `persistConnectionConfigIfCurrent` uses for
 * Connection credentials. Returns false when someone else wrote first, so a
 * concurrent save of a *different* app is retried against fresh state rather
 * than silently clobbering it. Portable across SQLite and Postgres — no row
 * locks, no `SELECT … FOR UPDATE`.
 */
async function writeStoredIfCurrent(args: {
  next: StoredOauthApps;
  previousRawValue: string;
}): Promise<boolean> {
  const repo = AppDataSource.getRepository(AppSetting);
  const value = JSON.stringify(args.next);
  if (args.previousRawValue === "") {
    // No row yet (or an empty one). INSERT, and let a UNIQUE violation from a
    // racing insert mean "someone else got there first" — the caller retries.
    try {
      await repo.insert({ key: OAUTH_APPS_SETTING_KEY, value });
      return true;
    } catch {
      return false;
    }
  }
  const result = await repo
    .createQueryBuilder()
    .update()
    .set({ value })
    .where("key = :key", { key: OAUTH_APPS_SETTING_KEY })
    .andWhere("value = :previous", { previous: args.previousRawValue })
    .execute();
  return (result.affected ?? 0) === 1;
}

/** Read-modify-write the whole map, retrying when a concurrent write lands
 * between our read and our write. Bounded: after a few attempts the loser
 * reports a conflict rather than spinning. */
async function mutateStored(
  mutate: (current: StoredOauthApps) => StoredOauthApps,
): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const { apps, rawValue } = await readStored();
    const next = mutate(apps);
    // A mutator that declines the change (nothing to clear, secret missing)
    // returns its input untouched — don't write, and don't create a row.
    if (next === apps) return;
    if (await writeStoredIfCurrent({ next, previousRawValue: rawValue })) return;
  }
  throw new Error("The OAuth apps settings changed while saving. Try again.");
}

function decryptStoredSecret(encrypted: string): string {
  if (!encrypted) return "";
  try {
    return decryptSecret(encrypted);
  } catch {
    // Losing the encryption key makes the secret unreadable. Fail soft here so
    // the admin page still renders (and still shows the client id); the
    // connect path treats an unreadable secret as "not registered" below.
    // eslint-disable-next-line no-console
    console.warn(
      "[oauth] could not decrypt a registered OAuth client secret (is the old key in previousEncryptionSecrets?) — re-enter it at Admin → Integrations",
    );
    return "";
  }
}

/** Every registerable app with its current registration state. */
export async function describeOauthApps(): Promise<OauthAppDescriptor[]> {
  const { apps } = await readStored();
  const catalog = listCatalog();
  return OAUTH_APP_CATALOG.map(({ redirectUri, ...info }) => {
    const row = apps[info.app];
    return {
      ...info,
      unlocks: catalog.filter((e) => e.oauth?.app === info.app).map((e) => e.name),
      configured: !!row?.clientId && !!row.encryptedClientSecret,
      clientId: row?.clientId ?? "",
      hasClientSecret: !!row?.encryptedClientSecret,
      redirectUri: redirectUri(),
      updatedAt: row?.updatedAt || null,
    };
  });
}

/**
 * The set of apps that can currently start a handshake with no per-Connection
 * credentials. Used by the catalog endpoint so the connect modal knows to hide
 * the client id / secret fields.
 */
export async function registeredOauthApps(): Promise<Set<OauthApp>> {
  const { apps } = await readStored();
  const out = new Set<OauthApp>();
  for (const [app, row] of Object.entries(apps)) {
    if (row?.clientId && row.encryptedClientSecret) out.add(app as OauthApp);
  }
  return out;
}

/**
 * Server-only: the decrypted credentials for an app, or null when nothing
 * usable is registered. A stored-but-undecryptable secret counts as null so
 * the caller reports "no app registered" rather than failing at Google with an
 * opaque `invalid_client`.
 */
export async function getRegisteredOauthApp(
  app: OauthApp,
): Promise<{ clientId: string; clientSecret: string } | null> {
  const { apps } = await readStored();
  const row = apps[app];
  if (!row?.clientId) return null;
  const clientSecret = decryptStoredSecret(row.encryptedClientSecret);
  if (!clientSecret) return null;
  return { clientId: row.clientId, clientSecret };
}

/**
 * Save (or update) one app's credentials. A blank `clientSecret` keeps the
 * secret already on file, so an admin can correct a typo'd client id without
 * fetching the secret out of the provider's console again.
 */
export async function saveOauthApp(app: OauthApp, input: OauthAppInput): Promise<void> {
  if (!isRegisterableOauthApp(app)) throw new Error(`Unknown OAuth app: ${app}`);
  const clientId = input.clientId.trim();
  if (!clientId) throw new Error("Client ID is required");
  const secret = input.clientSecret.trim();

  // A blank secret means "keep the stored one", which is only knowable from the
  // state we are about to overwrite — so resolve it inside the retry loop
  // rather than from a snapshot taken before a competing write.
  let missingSecret = false;
  await mutateStored((current) => {
    const encryptedClientSecret = secret
      ? encryptSecret(secret)
      : (current[app]?.encryptedClientSecret ?? "");
    missingSecret = !encryptedClientSecret;
    if (missingSecret) return current;
    return {
      ...current,
      [app]: { clientId, encryptedClientSecret, updatedAt: new Date().toISOString() },
    };
  });
  if (missingSecret) throw new Error("Client Secret is required");
}

/** Forget one app's credentials. Existing Connections keep working — they
 * carry their own copy of the credentials they were created with. */
export async function clearOauthApp(app: OauthApp): Promise<void> {
  await mutateStored((current) => {
    if (!current[app]) return current;
    const next = { ...current };
    delete next[app];
    return next;
  });
}
