import dns from "node:dns/promises";
import net from "node:net";
import crypto from "node:crypto";

import { config } from "../../../config.js";
import { emailDomain, isRoleAddress, normalizeEmail } from "../../lib/emailAddress.js";
import { assertPublicOutboundHost } from "../../lib/outboundUrl.js";
import { getEmailVerificationSettings } from "../runtimeSettings.js";
import { DISPOSABLE_EMAIL_DOMAINS, PUBLIC_EMAIL_DOMAINS } from "./enrichment.js";

/**
 * Find and verify a person's work email, in-house.
 *
 * This is the capability the paid services (Hunter, ZeroBounce, NeverBounce,
 * …) sell, rebuilt from the same three public primitives so a Genosyn install
 * owes nobody a per-lookup fee and leaks no Contact to a third party:
 *
 *   1. **Syntax + classification** — is it a well-formed address, and is it a
 *      shared role box (`sales@`), a free provider (`gmail.com`) or a
 *      throwaway (`mailinator.com`)? All three change how much a "valid"
 *      verdict is worth, so we surface them rather than hiding them.
 *   2. **MX** — does the domain actually receive mail, and through whom? A
 *      domain with no MX (and no A/AAAA fallback, RFC 5321 §5.1) cannot take
 *      mail at all, so every address on it is undeliverable without a single
 *      packet to the mail server.
 *   3. **SMTP callout** — open the conversation the sender's server would, up
 *      to `RCPT TO:`, and read whether the mailbox is accepted. This is the
 *      only step that confirms the mailbox itself rather than the domain.
 *
 * **Finding** an unknown address is the same machine pointed the other way:
 * generate the handful of patterns real companies actually use
 * (`first.last@`, `flast@`, …), then let step 3 say which one the server
 * accepts. With the patterns ranked by real-world frequency, the first hit is
 * almost always the right person.
 *
 * ## Why the verdict is deliberately cautious
 *
 * A verifier that over-promises is worse than none: mail sent to an address it
 * wrongly called "valid" bounces, and bounces burn the company's sending
 * reputation — the exact thing the suppression list and send ceilings exist to
 * protect. So:
 *
 *   - A **catch-all** domain (one that accepts `RCPT TO:` for a mailbox we know
 *     cannot exist) can never confirm a specific mailbox, so every address on
 *     it comes back `risky`, never `valid`, no matter how plausible.
 *   - The big free providers (Gmail, Outlook, Yahoo) answer `RCPT TO:` for
 *     everyone and bounce later, so an SMTP "accept" from them is treated as
 *     `unknown`, not proof.
 *   - A role address is flagged `risky` even when it is perfectly deliverable,
 *     because mailing `info@` is a common spam-complaint trigger and these are
 *     useless as a named sales Contact.
 *   - A temporary SMTP failure, a timeout, a blocked port 25, or SMTP probing
 *     turned off all yield `unknown` (with the domain still MX-checked) rather
 *     than a false `invalid`.
 *
 * ## Safety
 *
 * Every mail host we dial is resolved and refused if it points anywhere
 * non-public ({@link assertPublicOutboundHost}), so a Contact domain whose MX
 * resolves to `127.0.0.1` or an RFC-1918 address cannot turn this into a probe
 * of the operator's own network. SMTP probing is additionally **off on
 * multi-tenant installs** — a shared server must not become an email-existence
 * oracle one tenant points at the world, and its single egress IP is a shared
 * reputation nobody tenant should get to spend. Nothing a mail server says is
 * handed back to the model verbatim: callers receive structured verdicts and a
 * reason string we author, so a hostile SMTP banner has no channel to the
 * model. All network edges are injectable ({@link EmailFinderDeps}) so the
 * whole decision table is unit-testable without DNS or a socket.
 */

/** Where an address sits before any network call is made. */
export type EmailClassification = {
  /** The lowercased, de-wrapped address, or null when it is not an address. */
  normalized: string | null;
  domain: string | null;
  /** A shared-function box — `sales@`, `info@`. Deliverable, but not a person. */
  isRole: boolean;
  /** A free webmail provider — `gmail.com`, `outlook.com`. */
  isFreeProvider: boolean;
  /** A known throwaway/disposable domain — `mailinator.com`. */
  isDisposable: boolean;
};

/** The outcome of each stage, so a caller can see *why* the verdict landed. */
export type EmailDeliverabilityChecks = {
  syntax: boolean;
  domain: string | null;
  hasMx: boolean;
  /** The mail host the callout used, after MX (or A/AAAA fallback). */
  mxHost: string | null;
  /** Whether the domain accepts mail for an address we know cannot exist. */
  catchAll: boolean | null;
  smtp:
    | "accepted"
    | "rejected"
    | "catch_all"
    | "accept_all_provider"
    | "skipped"
    | "disabled"
    | "unsupported"
    | "tempfail"
    | "error"
    | "timeout";
};

export type EmailVerificationStatus = "valid" | "risky" | "invalid" | "unknown";

export type EmailVerification = EmailClassification & {
  address: string;
  status: EmailVerificationStatus;
  /** 0–100. A rough "how much would you stake on a send" rather than a probability. */
  confidence: number;
  /** One human-readable sentence explaining the status. */
  reason: string;
  checks: EmailDeliverabilityChecks;
};

/** One generated address plus the pattern that produced it. */
export type EmailCandidate = EmailVerification & {
  /** The pattern label, e.g. "first.last" — so a human can see the shape. */
  pattern: string;
};

export type EmailSearchResult = {
  name: string;
  domain: string;
  /** Set when SMTP confirmed exactly one mailbox; the single best bet otherwise. */
  best: EmailCandidate | null;
  /** Every candidate considered, best-ranked first. */
  candidates: EmailCandidate[];
  /** True when the domain accepts everything, so no candidate could be confirmed. */
  catchAll: boolean;
  /** Plain-language summary for the model — what was found and how sure to be. */
  summary: string;
};

/** What one `RCPT TO:` conversation concluded. */
export type SmtpRcptResult =
  | "accepted"
  | "rejected"
  | "tempfail"
  | "unsupported"
  | "error"
  | "timeout";

/** The injectable network edges. Production omits them; tests pass stubs. */
export type EmailFinderDeps = {
  /** MX exchanges for a domain, best (lowest preference) first. */
  resolveMx: (domain: string) => Promise<string[]>;
  /** A/AAAA presence, for the implicit-MX fallback (RFC 5321 §5.1). */
  resolveAddr: (domain: string) => Promise<boolean>;
  /** Walk one `RCPT TO:` on a mail host. Never throws; returns an outcome. */
  probeMailbox: (args: {
    host: string;
    from: string;
    to: string;
    timeoutMs: number;
  }) => Promise<SmtpRcptResult>;
  /** Resolve a host and throw if it is not public — the SSRF guard. */
  assertHostPublic: (host: string) => Promise<void>;
};

// ───────────────────────────── classification ──────────────────────────────

export function classifyEmail(raw: string): EmailClassification {
  const normalized = normalizeEmail(raw);
  if (!normalized) {
    return { normalized: null, domain: null, isRole: false, isFreeProvider: false, isDisposable: false };
  }
  const domain = emailDomain(normalized)!;
  return {
    normalized,
    domain,
    isRole: isRoleAddress(normalized),
    isFreeProvider: PUBLIC_EMAIL_DOMAINS.has(domain),
    isDisposable: DISPOSABLE_EMAIL_DOMAINS.has(domain),
  };
}

// ────────────────────────── candidate generation ───────────────────────────

const HONORIFICS = new Set(["mr", "mrs", "ms", "miss", "dr", "prof", "sir", "madam", "mx"]);
const SUFFIXES = new Set(["jr", "sr", "ii", "iii", "iv", "phd", "md", "esq"]);

/** Fold accents, drop anything a local part may not hold, lowercase. */
function asciiToken(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

/**
 * Split a display name into the first and last token that matter, dropping
 * honorifics and generational suffixes. Middle names are ignored — almost no
 * company encodes them in an address.
 */
export function splitName(name: string): { first: string; last: string | null } {
  const tokens = name
    .split(/[\s]+/)
    .map(asciiToken)
    .filter((token) => token.length > 0 && !HONORIFICS.has(token) && !SUFFIXES.has(token));
  if (tokens.length === 0) return { first: "", last: null };
  if (tokens.length === 1) return { first: tokens[0], last: null };
  return { first: tokens[0], last: tokens[tokens.length - 1] };
}

/**
 * The local-part patterns real companies use, most common first. The order is
 * what makes "the first candidate is usually right" true, so it is tuned to
 * published pattern-frequency data, not alphabetised.
 */
export function candidateLocalParts(name: string): Array<{ pattern: string; local: string }> {
  const { first, last } = splitName(name);
  if (!first) return [];
  const f = first[0];
  const out: Array<{ pattern: string; local: string }> = [];
  const push = (pattern: string, local: string) => {
    if (local && !out.some((entry) => entry.local === local)) out.push({ pattern, local });
  };

  if (last) {
    const l = last[0];
    push("first.last", `${first}.${last}`);
    push("firstlast", `${first}${last}`);
    push("flast", `${f}${last}`);
    push("first", first);
    push("first_last", `${first}_${last}`);
    push("f.last", `${f}.${last}`);
    push("firstl", `${first}${l}`);
    push("last", last);
    push("last.first", `${last}.${first}`);
    push("lastfirst", `${last}${first}`);
    push("first-last", `${first}-${last}`);
  } else {
    push("first", first);
  }
  return out;
}

// ─────────────────────────── default network edges ─────────────────────────

const RCPT_HELO_FALLBACK = "verifier.genosyn.com";

const defaultDeps: EmailFinderDeps = {
  async resolveMx(domain) {
    const records = await dns.resolveMx(domain);
    return records
      .filter((record) => record.exchange)
      .sort((a, b) => a.priority - b.priority)
      .map((record) => record.exchange.replace(/\.$/, ""));
  },
  async resolveAddr(domain) {
    try {
      const v4 = await dns.resolve4(domain);
      if (v4.length > 0) return true;
    } catch {
      /* fall through to AAAA */
    }
    try {
      const v6 = await dns.resolve6(domain);
      return v6.length > 0;
    } catch {
      return false;
    }
  },
  assertHostPublic: assertPublicOutboundHost,
  probeMailbox: defaultProbeMailbox,
};

/**
 * Drive one SMTP session to `RCPT TO:` on a mail host and report what the
 * server decided. A raw socket, because this never sends mail — it opens the
 * dialogue, reads the recipient verdict, and quits. Every failure mode (a
 * refused connection, a 4xx, a server that will not EHLO, a timeout) resolves
 * to a result rather than rejecting, so one dead MX never throws through the
 * ranking loop above it.
 */
async function defaultProbeMailbox(args: {
  host: string;
  from: string;
  to: string;
  timeoutMs: number;
}): Promise<SmtpRcptResult> {
  const { host, from, to, timeoutMs } = args;
  const heloDomain = from.includes("@") ? from.slice(from.indexOf("@") + 1) : RCPT_HELO_FALLBACK;
  const mailFrom = from ? `<${from}>` : "<>";

  return new Promise<SmtpRcptResult>((resolve) => {
    let settled = false;
    let stage: "greet" | "ehlo" | "helo" | "mail" | "rcpt" = "greet";
    let buffer = "";
    const socket = net.createConnection({ host, port: 25 });

    const finish = (result: SmtpRcptResult) => {
      if (settled) return;
      settled = true;
      try {
        if (socket.writable) socket.write("QUIT\r\n");
      } catch {
        /* best effort */
      }
      socket.destroy();
      resolve(result);
    };

    socket.setTimeout(timeoutMs, () => finish("timeout"));
    socket.on("error", () => finish("error"));
    socket.on("close", () => finish("error"));

    const send = (line: string) => {
      try {
        socket.write(`${line}\r\n`);
      } catch {
        finish("error");
      }
    };

    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      for (;;) {
        const response = takeSmtpResponse(buffer);
        if (!response) break;
        buffer = response.rest;
        advance(response.code);
      }
    });

    const advance = (code: number) => {
      switch (stage) {
        case "greet":
          if (code >= 200 && code < 400) {
            stage = "ehlo";
            send(`EHLO ${heloDomain}`);
          } else finish("error");
          break;
        case "ehlo":
          if (code >= 200 && code < 400) {
            stage = "mail";
            send(`MAIL FROM:${mailFrom}`);
          } else {
            stage = "helo";
            send(`HELO ${heloDomain}`);
          }
          break;
        case "helo":
          if (code >= 200 && code < 400) {
            stage = "mail";
            send(`MAIL FROM:${mailFrom}`);
          } else finish("unsupported");
          break;
        case "mail":
          if (code >= 200 && code < 400) {
            stage = "rcpt";
            send(`RCPT TO:<${to}>`);
          } else if (code >= 500) {
            finish("unsupported");
          } else {
            finish("tempfail");
          }
          break;
        case "rcpt":
          // 250/251 accept the recipient. 252 is "cannot verify, will try" —
          // the accept-all tell, so it is not proof. 5xx is a hard refusal;
          // 4xx is greylisting or a transient limit we must not read as "no".
          if (code === 250 || code === 251) finish("accepted");
          else if (code === 252) finish("unsupported");
          else if (code >= 500) finish("rejected");
          else finish("tempfail");
          break;
      }
    };
  });
}

/**
 * Pull the first *complete* SMTP response out of the buffer. A reply may span
 * several lines (`250-SIZE\r\n250 OK\r\n`); only a line whose 3-digit code is
 * followed by a space terminates it. Returns the code and whatever is left.
 */
function takeSmtpResponse(buffer: string): { code: number; rest: string } | null {
  const lines = buffer.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/\r$/, "");
    if (/^\d{3} /.test(line)) {
      return { code: Number.parseInt(line.slice(0, 3), 10), rest: lines.slice(i + 1).join("\n") };
    }
  }
  return null;
}

// ───────────────────────────── verification ────────────────────────────────

function randomLocalPart(): string {
  return `genosyn-verify-${crypto.randomBytes(8).toString("hex")}`;
}

type SmtpMode = "probe" | "disabled" | "multitenant";

function smtpMode(): { mode: SmtpMode; timeoutMs: number; from: string; maxCandidates: number } {
  const s = getEmailVerificationSettings();
  const mode: SmtpMode = config.security.multiTenant
    ? "multitenant"
    : s.smtpProbe
      ? "probe"
      : "disabled";
  return { mode, timeoutMs: s.probeTimeoutMs, from: s.probeFromAddress, maxCandidates: s.maxCandidates };
}

/**
 * Resolve the mail hosts for a domain, newest-guarded first, or an empty list
 * when the domain can take no mail. Each host is run past the public-address
 * guard, so a non-public MX is dropped rather than dialled.
 */
async function mailHostsFor(domain: string, deps: EmailFinderDeps): Promise<string[]> {
  let hosts: string[] = [];
  try {
    hosts = await deps.resolveMx(domain);
  } catch {
    hosts = [];
  }
  if (hosts.length === 0) {
    // RFC 5321 §5.1: a domain with no MX but an address record is its own MX.
    const hasAddr = await deps.resolveAddr(domain).catch(() => false);
    if (hasAddr) hosts = [domain];
  }
  const safe: string[] = [];
  for (const host of hosts) {
    try {
      await deps.assertHostPublic(host);
      safe.push(host);
    } catch {
      /* a non-public MX is not ours to dial */
    }
  }
  return safe;
}

/** Try each mail host in turn; the first that is not a connection error wins. */
async function probeAcrossHosts(
  hosts: string[],
  to: string,
  from: string,
  timeoutMs: number,
  deps: EmailFinderDeps,
): Promise<SmtpRcptResult> {
  let last: SmtpRcptResult = "error";
  for (const host of hosts) {
    last = await deps.probeMailbox({ host, from, to, timeoutMs });
    if (last !== "error") return last;
  }
  return last;
}

/**
 * Verify one address end to end. Honours the runtime SMTP switch and the
 * multi-tenant lock; falls back to an MX-level verdict whenever the callout
 * cannot speak with authority.
 */
export async function verifyEmail(
  raw: string,
  deps: EmailFinderDeps = defaultDeps,
): Promise<EmailVerification> {
  const classification = classifyEmail(raw);
  const base = (
    status: EmailVerificationStatus,
    confidence: number,
    reason: string,
    checks: EmailDeliverabilityChecks,
  ): EmailVerification => ({
    ...classification,
    address: classification.normalized ?? raw.trim(),
    status,
    confidence,
    reason,
    checks,
  });

  if (!classification.normalized || !classification.domain) {
    return base("invalid", 0, "That is not a well-formed email address.", {
      syntax: false,
      domain: null,
      hasMx: false,
      mxHost: null,
      catchAll: null,
      smtp: "skipped",
    });
  }
  const domain = classification.domain;

  const hosts = await mailHostsFor(domain, deps);
  if (hosts.length === 0) {
    return base("invalid", 5, `${domain} publishes no mail server, so it cannot receive email.`, {
      syntax: true,
      domain,
      hasMx: false,
      mxHost: null,
      catchAll: null,
      smtp: "skipped",
    });
  }
  const mxHost = hosts[0];

  const { mode, timeoutMs, from } = smtpMode();
  if (mode !== "probe") {
    const reasonTail =
      mode === "multitenant"
        ? "SMTP probing is off on shared installs, so the mailbox itself was not confirmed."
        : "SMTP probing is turned off, so the mailbox itself was not confirmed.";
    return finishWithoutSmtp(classification, mxHost, reasonTail);
  }

  // Catch-all first: if the server accepts a mailbox we know is fake, a yes to
  // the real one proves nothing.
  const catchAllProbe = await probeAcrossHosts(hosts, `${randomLocalPart()}@${domain}`, from, timeoutMs, deps);
  const catchAll = catchAllProbe === "accepted";
  if (catchAll) {
    return base(
      "risky",
      classification.isRole || classification.isDisposable ? 30 : 55,
      `${domain} is a catch-all domain — it accepts mail for any address, so this mailbox cannot be confirmed to exist.`,
      { syntax: true, domain, hasMx: true, mxHost, catchAll: true, smtp: "catch_all" },
    );
  }

  const rcpt = await probeAcrossHosts(hosts, classification.normalized, from, timeoutMs, deps);
  return verdictFromRcpt(classification, mxHost, rcpt);
}

/** The MX-confirmed-but-SMTP-silent verdict, shared by the off paths. */
function finishWithoutSmtp(
  classification: EmailClassification,
  mxHost: string,
  reasonTail: string,
): EmailVerification {
  const domain = classification.domain!;
  const flags = describeFlags(classification);
  return {
    ...classification,
    address: classification.normalized!,
    status: classification.isRole ? "risky" : "unknown",
    confidence: classification.isRole ? 35 : classification.isDisposable ? 15 : 50,
    reason: `${domain} accepts mail${flags}. ${reasonTail}`.trim(),
    checks: { syntax: true, domain, hasMx: true, mxHost, catchAll: null, smtp: "disabled" },
  };
}

function verdictFromRcpt(
  classification: EmailClassification,
  mxHost: string,
  rcpt: SmtpRcptResult,
): EmailVerification {
  const domain = classification.domain!;
  const address = classification.normalized!;
  const flags = describeFlags(classification);
  const make = (
    status: EmailVerificationStatus,
    confidence: number,
    reason: string,
    smtp: EmailDeliverabilityChecks["smtp"],
  ): EmailVerification => ({
    ...classification,
    address,
    status,
    confidence,
    reason,
    checks: { syntax: true, domain, hasMx: true, mxHost, catchAll: false, smtp },
  });

  switch (rcpt) {
    case "accepted":
      // Free providers accept everyone at RCPT and bounce later, so their
      // "yes" is not proof — and a role box, though real, is still risky.
      if (classification.isFreeProvider) {
        return make(
          "unknown",
          55,
          `${domain} is a free mail provider that accepts every recipient at this stage, so delivery is likely but unconfirmed.`,
          "accept_all_provider",
        );
      }
      if (classification.isRole) {
        return make(
          "risky",
          60,
          `The mail server accepts ${address}, but it is a shared role address — mailing it risks spam complaints and it is not a specific person.`,
          "accepted",
        );
      }
      return make("valid", 95, `The mail server accepts ${address} and the domain is not catch-all.`, "accepted");
    case "rejected":
      return make("invalid", 2, `The mail server rejected ${address}: no such mailbox.`, "rejected");
    case "tempfail":
      return make(
        "unknown",
        45,
        `${domain} accepts mail${flags}, but temporarily deferred the check (greylisting or a rate limit), so the mailbox was not confirmed.`,
        "tempfail",
      );
    case "unsupported":
      return make(
        "unknown",
        45,
        `${domain} accepts mail${flags} but does not answer recipient checks, so the mailbox could not be confirmed.`,
        "unsupported",
      );
    case "timeout":
      return make("unknown", 40, `${domain} did not answer the mail-server check in time.`, "timeout");
    default:
      return make("unknown", 40, `The mail server for ${domain} could not be reached for a recipient check.`, "error");
  }
}

function describeFlags(classification: EmailClassification): string {
  if (classification.isDisposable) return " (a disposable-mail domain)";
  if (classification.isFreeProvider) return " (a free mail provider)";
  if (classification.isRole) return " (a shared role address)";
  return "";
}

// ───────────────────────────────── finding ─────────────────────────────────

/**
 * Find the likeliest work email for a person at a domain. Generates the common
 * patterns, then — when SMTP probing is available and the domain is not
 * catch-all — confirms them one at a time in frequency order and stops at the
 * first the server accepts.
 */
export async function findEmail(
  name: string,
  rawDomain: string,
  deps: EmailFinderDeps = defaultDeps,
): Promise<EmailSearchResult> {
  const domain = rawDomain.trim().toLowerCase().replace(/^@/, "").replace(/\.$/, "");
  const patterns = candidateLocalParts(name);
  const { mode, timeoutMs, from, maxCandidates } = smtpMode();

  const empty = (summary: string): EmailSearchResult => ({
    name,
    domain,
    best: null,
    candidates: [],
    catchAll: false,
    summary,
  });

  if (patterns.length === 0) return empty("That name has no usable tokens to build an address from.");
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(domain)) {
    return empty(`"${rawDomain}" is not a usable domain.`);
  }

  const wanted = patterns.slice(0, Math.max(1, maxCandidates));
  const makeCandidate = (pattern: string, verification: EmailVerification): EmailCandidate => ({
    ...verification,
    pattern,
  });

  const hosts = await mailHostsFor(domain, deps);
  if (hosts.length === 0) {
    const candidates = wanted.map(({ pattern, local }) =>
      makeCandidate(pattern, {
        ...classifyEmail(`${local}@${domain}`),
        address: `${local}@${domain}`,
        status: "invalid",
        confidence: 2,
        reason: `${domain} publishes no mail server.`,
        checks: { syntax: true, domain, hasMx: false, mxHost: null, catchAll: null, smtp: "skipped" },
      }),
    );
    return { name, domain, best: null, candidates, catchAll: false, summary: `${domain} cannot receive mail, so there is no address to find.` };
  }
  const mxHost = hosts[0];

  // No live confirmation available → rank by pattern likelihood and say so.
  if (mode !== "probe") {
    const candidates = wanted.map(({ pattern, local }, index) =>
      makeCandidate(pattern, {
        ...classifyEmail(`${local}@${domain}`),
        address: `${local}@${domain}`,
        status: "unknown",
        confidence: Math.max(20, 55 - index * 4),
        reason:
          mode === "multitenant"
            ? "Ranked by how common this pattern is; SMTP confirmation is off on shared installs."
            : "Ranked by how common this pattern is; turn on SMTP probing at Admin → Runtime to confirm which exists.",
        checks: { syntax: true, domain, hasMx: true, mxHost, catchAll: null, smtp: "disabled" },
      }),
    );
    return {
      name,
      domain,
      best: candidates[0] ?? null,
      candidates,
      catchAll: false,
      summary: `${candidates.length} likely address${candidates.length === 1 ? "" : "es"} for ${name} at ${domain}, ranked by pattern. SMTP confirmation was not available, so treat the top one as a best guess.`,
    };
  }

  // Catch-all once for the whole domain: if it says yes to a fake box, no
  // candidate can be confirmed and probing them all is pointless noise.
  const catchAll = (await probeAcrossHosts(hosts, `${randomLocalPart()}@${domain}`, from, timeoutMs, deps)) === "accepted";
  if (catchAll) {
    const candidates = wanted.map(({ pattern, local }, index) =>
      makeCandidate(pattern, {
        ...classifyEmail(`${local}@${domain}`),
        address: `${local}@${domain}`,
        status: "risky",
        confidence: Math.max(20, 50 - index * 4),
        reason: `${domain} is catch-all — it accepts every address, so no single mailbox can be confirmed.`,
        checks: { syntax: true, domain, hasMx: true, mxHost, catchAll: true, smtp: "catch_all" },
      }),
    );
    return {
      name,
      domain,
      best: candidates[0] ?? null,
      candidates,
      catchAll: true,
      summary: `${domain} is a catch-all domain, so the mailbox cannot be confirmed. The top candidate is the most common pattern — verify it another way before relying on it.`,
    };
  }

  const candidates: EmailCandidate[] = [];
  let best: EmailCandidate | null = null;
  for (const { pattern, local } of wanted) {
    const address = `${local}@${domain}`;
    const rcpt = await probeAcrossHosts(hosts, address, from, timeoutMs, deps);
    const verification = verdictFromRcpt(classifyEmail(address), mxHost, rcpt);
    const candidate = makeCandidate(pattern, verification);
    candidates.push(candidate);
    if (verification.status === "valid") {
      best = candidate;
      break; // the server confirmed this mailbox — no need to probe the rest.
    }
  }
  if (!best) {
    // Nothing was confirmed; offer the most frequent pattern as the best bet.
    best = candidates[0] ?? null;
  }

  const summary = best
    ? best.status === "valid"
      ? `Confirmed ${best.address} for ${name} (pattern ${best.pattern}).`
      : `No mailbox was confirmed for ${name} at ${domain}; ${best.address} is the most likely pattern but unverified.`
    : `No address could be built for ${name} at ${domain}.`;

  return { name, domain, best, candidates, catchAll: false, summary };
}
