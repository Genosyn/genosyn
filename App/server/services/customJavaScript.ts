import { AppDataSource } from "../db/datasource.js";
import { AppSetting } from "../db/entities/AppSetting.js";

/** Database key for master-admin supplied browser JavaScript. */
export const CUSTOM_JAVASCRIPT_SETTING_KEY = "instance.customJavaScript";
export const MAX_CUSTOM_JAVASCRIPT_LENGTH = 100_000;

const MAX_SCRIPT_ELEMENTS = 32;
const REFRESH_INTERVAL_MS = 30_000;
const SCRIPT_ELEMENT = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
const SCRIPT_ATTRIBUTE = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
const SENSITIVE_PATH_PREFIXES = [
  "/api/",
  "/login/",
  "/signup/",
  "/forgot/",
  "/sign/",
  "/reset/",
  "/verify-email/",
  "/invite/",
  "/link-chat/",
];
const SENSITIVE_PATHS = new Set(["/api", "/index.html", "/login", "/signup", "/forgot"]);
const SENSITIVE_QUERY_KEYS = new Set(["invitation", "token", "code", "state", "ssolink"]);

let cachedCustomJavaScript = "";
let cachedCompiledJavaScript = "";
let refreshTimer: ReturnType<typeof setInterval> | null = null;

export type CustomJavaScriptSettings = {
  customJavaScript: string;
  configured: boolean;
};

export class CustomJavaScriptValidationError extends Error {}

type ScriptAttribute = { name: string; value: string };

function scriptAttributes(source: string): ScriptAttribute[] {
  const attributes: ScriptAttribute[] = [];
  for (const match of source.matchAll(SCRIPT_ATTRIBUTE)) {
    attributes.push({
      name: match[1].toLowerCase(),
      value: match[2] ?? match[3] ?? match[4] ?? "",
    });
  }
  return attributes;
}

function externalScriptJavaScript(attributes: ScriptAttribute[]): string {
  const src = attributes.find((attribute) => attribute.name === "src")?.value ?? "";
  if (!src) {
    throw new CustomJavaScriptValidationError("An external custom script needs a src URL");
  }
  let parsed: URL;
  try {
    parsed = new URL(src, "https://genosyn.invalid");
  } catch {
    throw new CustomJavaScriptValidationError("A custom script has an invalid src URL");
  }
  const sameOriginPath = src.startsWith("/") && !src.startsWith("//");
  if (!sameOriginPath && parsed.protocol !== "https:") {
    throw new CustomJavaScriptValidationError(
      "External custom scripts must use HTTPS or a same-origin path",
    );
  }
  if (!attributes.some((attribute) => attribute.name === "async")) {
    throw new CustomJavaScriptValidationError(
      "External <script> snippets must include the async attribute",
    );
  }

  const assignments = attributes
    .filter((attribute) => attribute.name !== "nonce")
    .map(
      (attribute) =>
        `  script.setAttribute(${JSON.stringify(attribute.name)}, ${JSON.stringify(attribute.value)});`,
    )
    .join("\n");
  return `(() => {
  const script = document.createElement("script");
${assignments}
  document.head.appendChild(script);
})();`;
}

/**
 * Accept JavaScript source directly and the complete script snippets analytics
 * vendors publish. Snippets are compiled into one external same-origin asset,
 * so literal closing tags and Windows line endings remain ordinary JS bytes.
 */
export function compileCustomJavaScript(source: string): string {
  if (!source.trim()) return "";
  // Vendor snippets begin with an HTML comment or a script element. Raw
  // JavaScript remains raw even when one of its strings contains `</script>`.
  if (!source.trimStart().startsWith("<")) return source;

  const elements = [...source.matchAll(SCRIPT_ELEMENT)];
  if (elements.length === 0) {
    throw new CustomJavaScriptValidationError(
      "Custom JavaScript contains an incomplete <script> element",
    );
  }
  if (elements.length > MAX_SCRIPT_ELEMENTS) {
    throw new CustomJavaScriptValidationError(
      `Custom JavaScript may contain at most ${MAX_SCRIPT_ELEMENTS} script elements`,
    );
  }

  const residual = source
    .replace(SCRIPT_ELEMENT, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript\s*>/gi, "")
    .trim();
  if (residual) {
    throw new CustomJavaScriptValidationError(
      "Paste JavaScript or complete <script> snippets without other HTML",
    );
  }

  const compiled: string[] = [];
  for (const element of elements) {
    const attributes = scriptAttributes(element[1]);
    const hasSrc = attributes.some((attribute) => attribute.name === "src");
    if (hasSrc) {
      compiled.push(externalScriptJavaScript(attributes));
    } else {
      compiled.push(element[2]);
    }
  }
  // Each element was a separate classic-script execution in the pasted HTML.
  // Keep that statement boundary: plain newlines can let a leading `(`, `[`,
  // or template literal in the next element continue the preceding expression.
  return compiled.join("\n;\n");
}

function updateCache(source: string): void {
  cachedCustomJavaScript = source;
  cachedCompiledJavaScript = compileCustomJavaScript(source);
}

function settingsSnapshot(): CustomJavaScriptSettings {
  return {
    customJavaScript: cachedCustomJavaScript,
    configured: Boolean(cachedCustomJavaScript.trim()),
  };
}

async function refreshCustomJavaScript(): Promise<CustomJavaScriptSettings> {
  const row = await AppDataSource.getRepository(AppSetting).findOneBy({
    key: CUSTOM_JAVASCRIPT_SETTING_KEY,
  });
  const value = row?.value ?? "";
  if (value.length > MAX_CUSTOM_JAVASCRIPT_LENGTH) {
    updateCache("");
    // Never print the browser code itself: it may contain identifiers or
    // vendor configuration that an operator did not intend to put in logs.
    // eslint-disable-next-line no-console
    console.warn("[customJavaScript] ignoring an oversized database value");
    return settingsSnapshot();
  }
  try {
    updateCache(value);
  } catch (err) {
    updateCache("");
    // eslint-disable-next-line no-console
    console.warn(
      `[customJavaScript] ignoring an invalid database value: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return settingsSnapshot();
}

/** Load before Express starts, then keep horizontally-scaled replicas fresh. */
export async function bootCustomJavaScript(): Promise<void> {
  await refreshCustomJavaScript();
  if (refreshTimer) return;
  refreshTimer = setInterval(() => {
    void refreshCustomJavaScript().catch((err: unknown) => {
      // Keep the last known-good value through a transient database failure.
      // eslint-disable-next-line no-console
      console.warn(
        `[customJavaScript] refresh failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  }, REFRESH_INTERVAL_MS);
  refreshTimer.unref();
}

export async function getCustomJavaScriptSettings(): Promise<CustomJavaScriptSettings> {
  return refreshCustomJavaScript();
}

export async function setCustomJavaScript(
  customJavaScript: string,
): Promise<CustomJavaScriptSettings> {
  if (customJavaScript.length > MAX_CUSTOM_JAVASCRIPT_LENGTH) {
    throw new CustomJavaScriptValidationError(
      `Custom JavaScript must be ${MAX_CUSTOM_JAVASCRIPT_LENGTH.toLocaleString()} characters or fewer`,
    );
  }
  // Compile before changing either the row or live cache.
  compileCustomJavaScript(customJavaScript);

  const repo = AppDataSource.getRepository(AppSetting);
  if (!customJavaScript.trim()) {
    await repo.delete({ key: CUSTOM_JAVASCRIPT_SETTING_KEY });
    updateCache("");
    return settingsSnapshot();
  }
  await repo.upsert({ key: CUSTOM_JAVASCRIPT_SETTING_KEY, value: customJavaScript }, ["key"]);
  updateCache(customJavaScript);
  return settingsSnapshot();
}

/**
 * Pages carrying sign-in or bearer-link credentials retain the original CSP
 * and never start custom code. `safe=1` is the operator recovery path.
 */
export function customJavaScriptAllowedForUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value, "https://genosyn.invalid");
  } catch {
    return false;
  }
  let pathname: string;
  try {
    // React Router decodes one segment at a time and preserves encoded slashes.
    // Mirror that behavior so `/l%6fgin` cannot evade the browser-code guard.
    pathname = url.pathname
      .split("/")
      .map((segment) => decodeURIComponent(segment).replace(/\//g, "%2F"))
      .join("/")
      .toLowerCase();
  } catch {
    // A malformed escape cannot be routed reliably; fail closed.
    return false;
  }
  if (SENSITIVE_PATHS.has(pathname)) return false;
  if (SENSITIVE_PATH_PREFIXES.some((prefix) => pathname.startsWith(prefix))) return false;
  if (url.searchParams.getAll("safe").includes("1")) return false;
  for (const key of url.searchParams.keys()) {
    if (SENSITIVE_QUERY_KEYS.has(key.toLowerCase())) return false;
  }
  return true;
}

/** Synchronous readers used by request middleware and the public JS route. */
export function hasCustomJavaScript(): boolean {
  return Boolean(cachedCompiledJavaScript.trim());
}

export function getCustomJavaScriptAsset(): string {
  if (!cachedCompiledJavaScript) return "/* No custom JavaScript configured. */\n";
  // Serve the compiled source directly. Wrapping it would change classic
  // script semantics: top-level `var` and function declarations must remain
  // globals, and an initial "use strict" must remain a directive prologue.
  return `${cachedCompiledJavaScript}\n`;
}

/**
 * Fixed, same-origin bootstrap kept separate from operator code so its local
 * bindings cannot change or collide with classic-script global semantics.
 * It checks the live browser URL before requesting the authenticated asset;
 * the server repeats the page check as defense in depth, while the persisted
 * Member session controls whether operator code is delivered.
 */
export function getCustomJavaScriptLoaderAsset(): string {
  if (!hasCustomJavaScript()) return "/* No custom JavaScript configured. */\n";
  return `(() => {
  let pathname;
  try {
    pathname = window.location.pathname
      .split("/")
      .map((segment) => decodeURIComponent(segment).replace(/\\//g, "%2F"))
      .join("/")
      .toLowerCase();
  } catch {
    return;
  }
  const params = new URLSearchParams(window.location.search);
  const sensitivePrefixes = ${JSON.stringify(SENSITIVE_PATH_PREFIXES.slice(1))};
  const sensitivePaths = ${JSON.stringify([...SENSITIVE_PATHS].filter((path) => !path.startsWith("/api")))};
  const sensitiveQueryKeys = ${JSON.stringify([...SENSITIVE_QUERY_KEYS])};
  const sensitiveQuery = [...params.keys()].some((key) => sensitiveQueryKeys.includes(key.toLowerCase()));
  if (
    sensitivePaths.includes(pathname) ||
    sensitivePrefixes.some((prefix) => pathname.startsWith(prefix)) ||
    sensitiveQuery ||
    params.getAll("safe").includes("1")
  ) return;
  const page = encodeURIComponent(window.location.pathname + window.location.search);
  document.write('<script src="/api/app/custom-javascript.js?page=' + page + '"><\\/script>');
})();
`;
}

/** Keep database-backed tests isolated from this process-level cache. */
export function resetCustomJavaScriptCacheForTests(): void {
  updateCache("");
}
