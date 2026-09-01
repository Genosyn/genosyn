import dns from "node:dns/promises";

import { safeFetchBuffer } from "../../lib/outboundUrl.js";

/**
 * Work out how to connect one email address, from the address alone.
 *
 * Connecting a mailbox used to start with a Google Cloud project. Somebody had
 * to create one, enable the Gmail API, configure a consent screen, register a
 * Web OAuth client, and paste two secrets into Admin → Integrations before the
 * first mailbox could be added — and an install whose team is on Fastmail or a
 * company Exchange server could not connect at all, because the Email section
 * only spoke Gmail.
 *
 * This module removes the guessing. Give it `someone@example.com` and it
 * answers with the routes that will actually work for that address, best
 * first: the provider's OAuth flow when one is wired up, and an IMAP/SMTP
 * route with real host names and ports otherwise. The UI shows one text field,
 * and everything after it is either a button or a password box.
 *
 * Resolution runs in the order a human would try:
 *
 *   1. **Built-in table** — the handful of domains most mail actually lives on
 *      (`gmail.com`, `outlook.com`, `icloud.com`, …). No network at all.
 *   2. **MX records** — a company domain hosted by Google Workspace or
 *      Microsoft 365 is invisible in the address but obvious in its MX, and
 *      the same trick names Fastmail, Zoho, Migadu, and friends.
 *   3. **SRV records** (RFC 6186) — `_imaps._tcp` / `_submission._tcp`, which
 *      well-run mail domains publish precisely so clients stop guessing.
 *   4. **Autoconfig** — the Thunderbird/ISPDB XML a domain can serve at
 *      `autoconfig.<domain>`, and the community database at
 *      `autoconfig.thunderbird.net` that covers thousands of ISPs.
 *   5. **A named guess** — `imap.<domain>` / `smtp.<domain>` on the standard
 *      ports, offered as a pre-filled form rather than a promise.
 *
 * Every network step is injectable ({@link DiscoveryDeps}) so the whole
 * decision table is unit-testable without DNS or HTTP, and every step is
 * allowed to fail: discovery degrades to the next rung rather than erroring,
 * because a wrong guess costs the user one corrected field and a failed
 * lookup would cost them the whole flow.
 */

/** One server coordinate. `secure` is implicit TLS; false means STARTTLS. */
export type MailboxServer = {
  host: string;
  port: number;
  secure: boolean;
};

/** What to tell someone about the password this provider wants. */
export type MailboxPasswordHelp = {
  /** One sentence, rendered under the password field. */
  summary: string;
  /** Where the person creates the credential, when there is such a page. */
  url?: string;
};

/**
 * One way to connect this address. A discovery returns them best-first; the
 * connect dialog renders the first as the primary button and the rest as
 * "another way".
 */
export type MailboxConnectRoute =
  | {
      kind: "oauth";
      /** The Integration whose consent flow authorises this mailbox. */
      provider: "google" | "microsoft";
      /** Button copy — "Continue with Google". */
      label: string;
      /** Scope-group keys the handshake must request. */
      scopeGroups: string[];
      /** True once a master admin has registered the app install-wide. The
       * resolver leaves this undefined; the route handler fills it in, because
       * it is deployment state rather than a property of the address. */
      instanceApp?: boolean;
    }
  | {
      kind: "imap";
      imap: MailboxServer;
      smtp: MailboxServer;
      /** Null when an ordinary account password is expected. */
      password: MailboxPasswordHelp | null;
    };

export type MailboxDiscoverySource = "builtin" | "mx" | "srv" | "autoconfig" | "guess";

export type MailboxDiscovery = {
  /** The address, lowercased and trimmed. */
  email: string;
  domain: string;
  /** Stable id for the recognised provider, or `"custom"`. */
  providerKey: string;
  /** What to call it on screen — "Gmail", "Fastmail", "your mail server". */
  displayName: string;
  /** Which rung of the ladder produced the answer. Shown as a quiet hint so
   * the person can tell "we know this" from "we guessed this". */
  source: MailboxDiscoverySource;
  /** Best route first. Empty only when {@link unsupportedReason} is set. */
  routes: MailboxConnectRoute[];
  /** Set when the provider is known to offer no IMAP at all, so the dialog
   * can say so instead of letting the person fail at a password prompt. */
  unsupportedReason?: string;
};

/** Injectable network edges. Tests pass stubs; production omits the argument. */
export type DiscoveryDeps = {
  resolveMx: (domain: string) => Promise<string[]>;
  resolveSrv: (
    name: string,
  ) => Promise<Array<{ name: string; port: number; priority: number }>>;
  fetchAutoconfig: (url: string) => Promise<string | null>;
};

// ───────────────────────────── address parsing ─────────────────────────────

/** Lowercase + trim, and strip a `Display Name <addr>` wrapper if present. */
export function normalizeEmail(input: string): string {
  const trimmed = input.trim();
  const angled = /<([^>]+)>\s*$/.exec(trimmed);
  return (angled ? angled[1] : trimmed).trim().toLowerCase();
}

/**
 * The domain of an address, or "" when the input is not one address.
 *
 * Deliberately stricter than the transport will be: exactly one `@`, a local
 * part and a dotted domain on either side, no whitespace anywhere. Discovery
 * turns its answer into DNS lookups and an outbound fetch, so garbage in must
 * stop here rather than downstream.
 */
export function emailDomain(input: string): string {
  const email = normalizeEmail(input);
  if (/\s/.test(email)) return "";
  const at = email.indexOf("@");
  if (at <= 0 || at !== email.lastIndexOf("@")) return "";
  const domain = email.slice(at + 1);
  if (!domain || domain.length > 253) return "";
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(domain)) {
    return "";
  }
  return domain;
}

// ───────────────────────────── the built-in table ─────────────────────────────

type BuiltinProvider = {
  key: string;
  displayName: string;
  /** Address domains that belong to this provider. */
  domains: string[];
  /** MX suffixes that identify it on a custom domain. */
  mxSuffixes?: string[];
  imap?: MailboxServer;
  smtp?: MailboxServer;
  password?: MailboxPasswordHelp;
  /** An OAuth route to offer ahead of IMAP. */
  oauth?: { provider: "google" | "microsoft"; label: string; scopeGroups: string[] };
  /** Set when there is no IMAP to connect to. */
  unsupportedReason?: string;
};

const APP_PASSWORD = (summary: string, url?: string): MailboxPasswordHelp => ({ summary, url });

/**
 * The providers worth knowing by name.
 *
 * Order matters only for MX matching, where the first suffix hit wins — the
 * Google and Microsoft entries lead because a custom domain sitting behind
 * Workspace or 365 is by far the most common case, and both have an OAuth
 * route that beats IMAP.
 */
export const BUILTIN_MAIL_PROVIDERS: BuiltinProvider[] = [
  {
    key: "google",
    displayName: "Gmail",
    domains: ["gmail.com", "googlemail.com"],
    mxSuffixes: ["aspmx.l.google.com", "googlemail.com", "google.com"],
    imap: { host: "imap.gmail.com", port: 993, secure: true },
    smtp: { host: "smtp.gmail.com", port: 465, secure: true },
    password: APP_PASSWORD(
      "Gmail rejects your normal password here. Turn on 2-Step Verification, then create a 16-character App password and paste it below.",
      "https://myaccount.google.com/apppasswords",
    ),
    oauth: { provider: "google", label: "Continue with Google", scopeGroups: ["mail"] },
  },
  {
    key: "microsoft",
    displayName: "Outlook",
    domains: ["outlook.com", "hotmail.com", "live.com", "msn.com", "passport.com"],
    mxSuffixes: ["mail.protection.outlook.com", "olc.protection.outlook.com"],
    imap: { host: "outlook.office365.com", port: 993, secure: true },
    smtp: { host: "smtp-mail.outlook.com", port: 587, secure: false },
    // Microsoft has retired basic authentication for IMAP and SMTP on both
    // personal Outlook.com accounts and Exchange Online, so a plain password
    // fails here no matter how carefully it is typed. An app password still
    // works wherever the tenant or account issues one; saying that up front is
    // the difference between one corrected field and a bewildering rejection.
    password: APP_PASSWORD(
      "Microsoft no longer accepts ordinary sign-in passwords for mail clients. Use an app password — your account or your Microsoft 365 admin has to allow one.",
      "https://account.microsoft.com/security",
    ),
  },
  {
    key: "yahoo",
    displayName: "Yahoo Mail",
    domains: ["yahoo.com", "yahoo.co.uk", "yahoo.co.jp", "yahoo.fr", "yahoo.de", "ymail.com", "rocketmail.com"],
    mxSuffixes: ["yahoodns.net"],
    imap: { host: "imap.mail.yahoo.com", port: 993, secure: true },
    smtp: { host: "smtp.mail.yahoo.com", port: 465, secure: true },
    password: APP_PASSWORD(
      "Yahoo needs an app password, not your sign-in password.",
      "https://login.yahoo.com/account/security",
    ),
  },
  {
    key: "aol",
    displayName: "AOL Mail",
    domains: ["aol.com", "aim.com"],
    imap: { host: "imap.aol.com", port: 993, secure: true },
    smtp: { host: "smtp.aol.com", port: 465, secure: true },
    password: APP_PASSWORD(
      "AOL needs an app password, not your sign-in password.",
      "https://login.aol.com/account/security",
    ),
  },
  {
    key: "icloud",
    displayName: "iCloud Mail",
    domains: ["icloud.com", "me.com", "mac.com"],
    mxSuffixes: ["icloud.com.akadns.net", "mail.icloud.com"],
    imap: { host: "imap.mail.me.com", port: 993, secure: true },
    smtp: { host: "smtp.mail.me.com", port: 587, secure: false },
    password: APP_PASSWORD(
      "iCloud needs an app-specific password created at appleid.apple.com.",
      "https://appleid.apple.com/account/manage",
    ),
  },
  {
    key: "fastmail",
    displayName: "Fastmail",
    domains: ["fastmail.com", "fastmail.fm", "messagingengine.com"],
    mxSuffixes: ["messagingengine.com"],
    imap: { host: "imap.fastmail.com", port: 993, secure: true },
    smtp: { host: "smtp.fastmail.com", port: 465, secure: true },
    password: APP_PASSWORD(
      "Fastmail needs an app password with Mail access.",
      "https://app.fastmail.com/settings/security/apppasswords",
    ),
  },
  {
    key: "zoho",
    displayName: "Zoho Mail",
    domains: ["zoho.com", "zohomail.com"],
    mxSuffixes: ["zoho.com", "zohomail.com"],
    imap: { host: "imap.zoho.com", port: 993, secure: true },
    smtp: { host: "smtp.zoho.com", port: 465, secure: true },
    password: APP_PASSWORD(
      "Zoho needs an application-specific password when two-factor sign-in is on.",
      "https://accounts.zoho.com/home#security/app_password",
    ),
  },
  {
    key: "zoho-eu",
    displayName: "Zoho Mail (EU)",
    domains: ["zoho.eu"],
    mxSuffixes: ["zoho.eu"],
    imap: { host: "imap.zoho.eu", port: 993, secure: true },
    smtp: { host: "smtp.zoho.eu", port: 465, secure: true },
    password: APP_PASSWORD(
      "Zoho needs an application-specific password when two-factor sign-in is on.",
      "https://accounts.zoho.eu/home#security/app_password",
    ),
  },
  {
    key: "gmx",
    displayName: "GMX",
    domains: ["gmx.com", "gmx.net", "gmx.de", "gmx.at", "gmx.ch"],
    imap: { host: "imap.gmx.com", port: 993, secure: true },
    smtp: { host: "mail.gmx.com", port: 587, secure: false },
  },
  {
    key: "webde",
    displayName: "WEB.DE",
    domains: ["web.de"],
    imap: { host: "imap.web.de", port: 993, secure: true },
    smtp: { host: "smtp.web.de", port: 587, secure: false },
  },
  {
    key: "yandex",
    displayName: "Yandex Mail",
    domains: ["yandex.com", "yandex.ru", "ya.ru"],
    mxSuffixes: ["mx.yandex.net"],
    imap: { host: "imap.yandex.com", port: 993, secure: true },
    smtp: { host: "smtp.yandex.com", port: 465, secure: true },
    password: APP_PASSWORD(
      "Yandex needs an app password for mail clients.",
      "https://id.yandex.com/security/app-passwords",
    ),
  },
  {
    key: "mailru",
    displayName: "Mail.ru",
    domains: ["mail.ru", "inbox.ru", "bk.ru", "list.ru"],
    imap: { host: "imap.mail.ru", port: 993, secure: true },
    smtp: { host: "smtp.mail.ru", port: 465, secure: true },
    password: APP_PASSWORD("Mail.ru needs an app password for external mail clients."),
  },
  {
    key: "mailbox-org",
    displayName: "mailbox.org",
    domains: ["mailbox.org"],
    mxSuffixes: ["mailbox.org"],
    imap: { host: "imap.mailbox.org", port: 993, secure: true },
    smtp: { host: "smtp.mailbox.org", port: 465, secure: true },
  },
  {
    key: "migadu",
    displayName: "Migadu",
    domains: ["migadu.com"],
    mxSuffixes: ["migadu.com"],
    imap: { host: "imap.migadu.com", port: 993, secure: true },
    smtp: { host: "smtp.migadu.com", port: 465, secure: true },
  },
  {
    key: "titan",
    displayName: "Titan",
    domains: ["titan.email"],
    mxSuffixes: ["titan.email"],
    imap: { host: "imap.titan.email", port: 993, secure: true },
    smtp: { host: "smtp.titan.email", port: 465, secure: true },
  },
  {
    key: "privateemail",
    displayName: "Namecheap Private Email",
    domains: ["privateemail.com"],
    mxSuffixes: ["privateemail.com", "registrar-servers.com"],
    imap: { host: "mail.privateemail.com", port: 993, secure: true },
    smtp: { host: "mail.privateemail.com", port: 465, secure: true },
  },
  {
    key: "proton",
    displayName: "Proton Mail",
    domains: ["proton.me", "protonmail.com", "protonmail.ch", "pm.me"],
    mxSuffixes: ["protonmail.ch", "proton.me"],
    // Proton speaks IMAP only through the desktop Bridge, on loopback. An
    // install can reach that when the Bridge runs beside it; saying so beats
    // pretending imap.proton.me exists.
    imap: { host: "127.0.0.1", port: 1143, secure: false },
    smtp: { host: "127.0.0.1", port: 1025, secure: false },
    password: APP_PASSWORD(
      "Proton has no public IMAP. Run Proton Mail Bridge next to Genosyn and paste the password the Bridge shows you.",
      "https://proton.me/mail/bridge",
    ),
  },
  {
    key: "tuta",
    displayName: "Tuta",
    domains: ["tuta.com", "tutanota.com", "tutanota.de", "tutamail.com", "keemail.me"],
    mxSuffixes: ["tutanota.de", "tuta.com"],
    unsupportedReason:
      "Tuta encrypts mailboxes end-to-end and exposes no IMAP or SMTP, so no mail client can connect to it — Genosyn included.",
  },
  {
    key: "hey",
    displayName: "HEY",
    domains: ["hey.com"],
    mxSuffixes: ["hey.com"],
    unsupportedReason:
      "HEY does not offer IMAP access, so mail there can only be read in HEY's own apps.",
  },
];

const BUILTIN_BY_DOMAIN = new Map<string, BuiltinProvider>();
for (const provider of BUILTIN_MAIL_PROVIDERS) {
  for (const domain of provider.domains) BUILTIN_BY_DOMAIN.set(domain, provider);
}

/** The provider that owns an address domain outright, if any. */
export function lookupBuiltinProvider(domain: string): BuiltinProvider | null {
  return BUILTIN_BY_DOMAIN.get(domain) ?? null;
}

/**
 * The provider a domain's MX records point at, if we recognise it.
 *
 * Matching is on a dot-boundary suffix so `aspmx.l.google.com` is Google and
 * `notgoogle.com` is not. Gateway vendors (Proofpoint, Mimecast, Barracuda)
 * deliberately match nothing: they front somebody else's mailbox server, so
 * their MX says who filters the mail, never who stores it.
 */
export function providerFromMxHosts(hosts: string[]): BuiltinProvider | null {
  const normalized = hosts.map((h) => h.trim().toLowerCase().replace(/\.$/, "")).filter(Boolean);
  for (const provider of BUILTIN_MAIL_PROVIDERS) {
    for (const suffix of provider.mxSuffixes ?? []) {
      if (normalized.some((host) => host === suffix || host.endsWith(`.${suffix}`))) {
        return provider;
      }
    }
  }
  return null;
}

// ───────────────────────────── route assembly ─────────────────────────────

function routesFor(provider: BuiltinProvider): MailboxConnectRoute[] {
  const routes: MailboxConnectRoute[] = [];
  if (provider.oauth) {
    routes.push({
      kind: "oauth",
      provider: provider.oauth.provider,
      label: provider.oauth.label,
      scopeGroups: provider.oauth.scopeGroups,
    });
  }
  if (provider.imap && provider.smtp) {
    routes.push({
      kind: "imap",
      imap: provider.imap,
      smtp: provider.smtp,
      password: provider.password ?? null,
    });
  }
  return routes;
}

/** The pre-filled form we offer when nothing recognised the domain. */
export function guessRoute(domain: string): MailboxConnectRoute {
  return {
    kind: "imap",
    imap: { host: `imap.${domain}`, port: 993, secure: true },
    smtp: { host: `smtp.${domain}`, port: 587, secure: false },
    password: null,
  };
}

// ───────────────────────────── SRV (RFC 6186) ─────────────────────────────

/**
 * Turn `_imaps._tcp` / `_submission._tcp` answers into a route.
 *
 * RFC 6186 says a target of `.` means "this service is not offered", and that
 * the lowest priority wins. Both matter: a domain that publishes `_imaps` with
 * a `.` target is telling us not to try IMAPS, and taking the first record
 * DNS happened to return would pick a backup server at random.
 */
export function routeFromSrv(args: {
  imaps: Array<{ name: string; port: number; priority: number }>;
  submissions: Array<{ name: string; port: number; priority: number }>;
  submission: Array<{ name: string; port: number; priority: number }>;
}): MailboxConnectRoute | null {
  const pick = (records: Array<{ name: string; port: number; priority: number }>) =>
    records
      .filter((r) => r.name && r.name !== "." && r.port > 0)
      .sort((a, b) => a.priority - b.priority)[0] ?? null;

  const imap = pick(args.imaps);
  if (!imap) return null;
  const submissions = pick(args.submissions);
  const submission = pick(args.submission);
  const smtp = submissions
    ? { host: strip(submissions.name), port: submissions.port, secure: true }
    : submission
      ? { host: strip(submission.name), port: submission.port, secure: false }
      : null;
  if (!smtp) return null;
  return {
    kind: "imap",
    imap: { host: strip(imap.name), port: imap.port, secure: true },
    smtp,
    password: null,
  };
}

function strip(host: string): string {
  return host.trim().toLowerCase().replace(/\.$/, "");
}

// ───────────────────────────── autoconfig XML ─────────────────────────────

/**
 * Read the incoming/outgoing servers out of a Thunderbird autoconfig document.
 *
 * The format is small and stable, and the two facts we need — an IMAP server
 * and an SMTP server — sit in fixed elements, so a couple of anchored regexes
 * beat adding an XML parser to the dependency list for one call site. Anything
 * unexpected returns null and discovery falls through to a guess.
 */
export function parseAutoconfig(xml: string): MailboxConnectRoute | null {
  const incoming = /<incomingServer\b[^>]*type\s*=\s*"imap"[^>]*>([\s\S]*?)<\/incomingServer>/i.exec(
    xml,
  );
  const outgoing = /<outgoingServer\b[^>]*type\s*=\s*"smtp"[^>]*>([\s\S]*?)<\/outgoingServer>/i.exec(
    xml,
  );
  if (!incoming || !outgoing) return null;
  const imap = serverFromAutoconfigBlock(incoming[1], 993);
  const smtp = serverFromAutoconfigBlock(outgoing[1], 587);
  if (!imap || !smtp) return null;
  return { kind: "imap", imap, smtp, password: null };
}

function serverFromAutoconfigBlock(block: string, fallbackPort: number): MailboxServer | null {
  const host = /<hostname>\s*([^<\s]+)\s*<\/hostname>/i.exec(block)?.[1];
  if (!host) return null;
  const port = Number(/<port>\s*(\d+)\s*<\/port>/i.exec(block)?.[1] ?? fallbackPort);
  const socket = (/<socketType>\s*([A-Za-z]+)\s*<\/socketType>/i.exec(block)?.[1] ?? "").toUpperCase();
  // SSL means implicit TLS; STARTTLS and plain both open in the clear and
  // upgrade (or do not), which is exactly what `secure: false` means to
  // nodemailer and imapflow.
  const secure = socket === "SSL" ? true : socket === "STARTTLS" || socket === "PLAIN" ? false : port === 993 || port === 465;
  if (!Number.isFinite(port) || port <= 0 || port > 65535) return null;
  return { host: strip(host), port, secure };
}

// ───────────────────────────── the resolver ─────────────────────────────

const AUTOCONFIG_TIMEOUT_MS = 4000;
/** An autoconfig document is a few kilobytes; anything larger is not one. */
const AUTOCONFIG_MAX_BYTES = 256 * 1024;

const defaultDeps: DiscoveryDeps = {
  async resolveMx(domain) {
    const records = await dns.resolveMx(domain);
    return records.sort((a, b) => a.priority - b.priority).map((r) => r.exchange);
  },
  async resolveSrv(name) {
    const records = await dns.resolveSrv(name);
    return records.map((r) => ({ name: r.name, port: r.port, priority: r.priority }));
  },
  async fetchAutoconfig(url) {
    // `safeFetchBuffer` rather than a bare `fetch`: it enforces the install's
    // outbound policy (a domain pointing `autoconfig.` at 127.0.0.1 must not
    // turn this convenience into a request against the operator's own network)
    // and, just as importantly, stops reading at the cap. Reading the whole
    // body first and slicing afterwards would let a hostile — or merely
    // misconfigured — host stream gigabytes into memory before we truncated a
    // single byte of it.
    const result = await safeFetchBuffer(
      url,
      {},
      {
        maxBytes: AUTOCONFIG_MAX_BYTES,
        timeoutMs: AUTOCONFIG_TIMEOUT_MS,
        allowedProtocols: ["https:"],
      },
    );
    if (!result.ok) return null;
    return result.body.toString("utf8");
  },
};

async function quiet<T>(work: Promise<T>, fallback: T): Promise<T> {
  try {
    return await work;
  } catch {
    return fallback;
  }
}

/**
 * Work out how to connect `email`. Never throws for a resolvable address:
 * the worst answer is a named guess the person can correct in the form.
 */
export async function discoverMailbox(
  email: string,
  deps: Partial<DiscoveryDeps> = {},
): Promise<MailboxDiscovery> {
  const d: DiscoveryDeps = { ...defaultDeps, ...deps };
  const normalized = normalizeEmail(email);
  const domain = emailDomain(normalized);
  if (!domain) {
    throw new Error("Enter a full email address, like you@example.com.");
  }

  const base = { email: normalized, domain };

  const builtin = lookupBuiltinProvider(domain);
  if (builtin) {
    return {
      ...base,
      providerKey: builtin.key,
      displayName: builtin.displayName,
      source: "builtin",
      routes: routesFor(builtin),
      ...(builtin.unsupportedReason ? { unsupportedReason: builtin.unsupportedReason } : {}),
    };
  }

  const mxHosts = await quiet(d.resolveMx(domain), [] as string[]);
  const byMx = providerFromMxHosts(mxHosts);
  if (byMx) {
    return {
      ...base,
      providerKey: byMx.key,
      displayName: byMx.displayName,
      source: "mx",
      routes: routesFor(byMx),
      ...(byMx.unsupportedReason ? { unsupportedReason: byMx.unsupportedReason } : {}),
    };
  }

  const [imaps, submissions, submission] = await Promise.all([
    quiet(d.resolveSrv(`_imaps._tcp.${domain}`), []),
    quiet(d.resolveSrv(`_submissions._tcp.${domain}`), []),
    quiet(d.resolveSrv(`_submission._tcp.${domain}`), []),
  ]);
  const srvRoute = routeFromSrv({ imaps, submissions, submission });
  if (srvRoute) {
    return {
      ...base,
      providerKey: "custom",
      displayName: domain,
      source: "srv",
      routes: [srvRoute],
    };
  }

  for (const url of autoconfigUrls(domain)) {
    const xml = await quiet(d.fetchAutoconfig(url), null);
    if (!xml) continue;
    const route = parseAutoconfig(xml);
    if (route) {
      return {
        ...base,
        providerKey: "custom",
        displayName: domain,
        source: "autoconfig",
        routes: [route],
      };
    }
  }

  return {
    ...base,
    providerKey: "custom",
    displayName: domain,
    source: "guess",
    routes: [guessRoute(domain)],
  };
}

/**
 * Where a domain's autoconfig might live, most authoritative first.
 *
 * The domain's own two locations come before Thunderbird's shared database so
 * a company that publishes its real settings always wins over a community
 * guess about its ISP.
 */
export function autoconfigUrls(domain: string): string[] {
  return [
    `https://autoconfig.${domain}/mail/config-v1.1.xml`,
    `https://${domain}/.well-known/autoconfig/mail/config-v1.1.xml`,
    `https://autoconfig.thunderbird.net/v1.1/${domain}`,
  ];
}
