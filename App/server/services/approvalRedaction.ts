const SECRET_ARGUMENT_KEY =
  /(?:authorization|apikey|accesstoken|refreshtoken|token|secret|password|passwd|cookie|credential|privatekey|clientsecret)/;

const SECRET_LABEL = String.raw`(?:authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password|passwd|cookie|credential|private[_-]?key|client[_-]?secret)`;

function isSecretArgumentKey(key: string): boolean {
  return SECRET_ARGUMENT_KEY.test(key.replace(/[^a-z0-9]/gi, "").toLowerCase());
}

function redactUrlCredentialMaterial(value: string): string {
  return value.replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s<>"'`]+/gi, (candidate) => {
    try {
      const url = new URL(candidate);
      url.username = "";
      url.password = "";
      // A fragment is not sent to an HTTP server, but OAuth and SPA URLs often
      // place credentials there. It adds no useful review context, so omit it.
      url.hash = "";
      for (const key of [...url.searchParams.keys()]) {
        if (isSecretArgumentKey(key) || /^(?:code|state|signature|sig|key|auth)$/i.test(key)) {
          url.searchParams.set(key, "[redacted]");
        }
      }
      return url.toString();
    } catch {
      return candidate;
    }
  });
}

function redactStringCredentials(value: string): string {
  const assignmentPattern = new RegExp(
    String.raw`\b(${SECRET_LABEL})\b(\s*[:=]\s*)(?:\[redacted\]|"(?:\\.|[^"])*"|'(?:\\.|[^'])*'|[^\s,;}&\]]+)`,
    "gi",
  );

  const redacted = value
    .replace(
      /-----BEGIN(?: [A-Z0-9]+)? PRIVATE KEY-----[\s\S]*?-----END(?: [A-Z0-9]+)? PRIVATE KEY-----/gi,
      "[redacted private key]",
    )
    .replace(/\b(?:set-cookie|cookie)\s*:\s*[^\r\n]+/gi, "Cookie: [redacted]")
    .replace(
      /("(?:authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password|passwd|cookie|credential|private[_-]?key|client[_-]?secret)"\s*:\s*)("(?:\\.|[^"])*"|[^,}\s]+)/gi,
      '$1"[redacted]"',
    )
    .replace(/\b(Bearer|Basic)\s+[^\s,;]+/gi, "$1 [redacted]")
    .replace(assignmentPattern, "$1$2[redacted]")
    .replace(
      /([?&](?:access_token|refresh_token|api_?key|token|secret|password|code|signature)=)[^&\s]+/gi,
      "$1[redacted]",
    )
    .replace(/\[redacted\](?:\s+\[redacted\])+/gi, "[redacted]");

  return redactUrlCredentialMaterial(redacted);
}

function redactApprovalValue(value: unknown, depth = 0): unknown {
  if (depth >= 8) return "[truncated]";
  if (typeof value === "string") return redactStringCredentials(value);
  if (Array.isArray(value)) return value.map((item) => redactApprovalValue(item, depth + 1));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, child]) => [
        key,
        isSecretArgumentKey(key) ? "[redacted]" : redactApprovalValue(child, depth + 1),
      ]),
    );
  }
  return value;
}

/**
 * Redact human-review copy at every persistence and response boundary.
 *
 * Approval titles and summaries can originate with a model. Older rows may
 * also predate creation-time redaction, so callers must still apply this when
 * copying their text into notifications, journals, audits, or API responses.
 */
export function redactApprovalSummary(value: string | null): string | null {
  if (value === null) return null;
  try {
    return JSON.stringify(redactApprovalValue(JSON.parse(value) as unknown));
  } catch {
    return redactStringCredentials(value);
  }
}

/** Human-review preview only; the encrypted/replay payload remains untouched. */
export function approvalArgsPreview(args: Record<string, unknown>): string {
  return JSON.stringify(redactApprovalValue(args));
}

/** Safe page context for an approval summary; never used for execution binding. */
export function approvalPageUrlPreview(value: string): string {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (isSecretArgumentKey(key) || /^(?:code|state|signature|sig|key|auth)$/i.test(key)) {
        url.searchParams.set(key, "[redacted]");
      }
    }
    return url.toString();
  } catch {
    return redactStringCredentials(value);
  }
}
