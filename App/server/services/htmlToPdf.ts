import { resolveBrowserExecutable } from "./browserProfile.js";
import type { EmailAttachment } from "./emailTransports.js";

/**
 * One-shot HTML → PDF rendering via Playwright's Chromium. Used to give
 * AI employees and the resource download menu a real PDF instead of a
 * print-dialog detour. Each call launches and disposes its own browser
 * so a slow render can't pin a long-lived process; volume is low enough
 * that pooling isn't worth the complexity yet.
 *
 * The binary is resolved by `browserProfile.resolveBrowserExecutable()`, the
 * same way the browser tools resolve theirs — the shipped image points that at
 * real Google Chrome, and a dev machine falls through to whatever Chrome or
 * Chromium it has. Rendering is equivalent across all of them for our
 * purposes; this call site shares the resolver so there is only one place that
 * knows where a browser lives.
 *
 * Nothing here needs the anti-blocking profile: this browser never leaves
 * `setContent`, so it faces no site and no bot detection.
 */

let chromiumModule: { launch: (opts: unknown) => Promise<unknown> } | null = null;

async function getChromium(): Promise<{ launch: (opts: unknown) => Promise<unknown> }> {
  if (!chromiumModule) {
    try {
      const mod = await import("playwright-core");
      chromiumModule = mod.chromium as unknown as {
        launch: (opts: unknown) => Promise<unknown>;
      };
    } catch (err) {
      throw new Error(
        `playwright-core is not available: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return chromiumModule;
}

export interface HtmlToPdfOptions {
  /** Page size; defaults to A4. */
  format?: "A4" | "Letter" | "Legal";
  /** Page margin (CSS units). Defaults to 1.5cm on every side. */
  margin?: { top?: string; right?: string; bottom?: string; left?: string };
  /** Whether to render `background-color` / `background-image`. Defaults to true. */
  printBackground?: boolean;
}

export async function htmlToPdf(
  html: string,
  options: HtmlToPdfOptions = {},
): Promise<Buffer> {
  const chromium = await getChromium();
  const executablePath = resolveBrowserExecutable();
  const browser = (await chromium.launch({
    headless: true,
    executablePath,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  })) as {
    newContext: () => Promise<{
      newPage: () => Promise<{
        setContent: (html: string, opts: { waitUntil: string }) => Promise<void>;
        pdf: (opts: unknown) => Promise<Buffer>;
        close: () => Promise<void>;
      }>;
      close: () => Promise<void>;
    }>;
    close: () => Promise<void>;
  };
  try {
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      // `domcontentloaded` is enough for our self-contained HTML — there
      // are no external network resources to wait on (images come in via
      // `data:` URIs at most), and `networkidle` adds a 500ms tail per
      // page that compounds on busy hosts.
      await page.setContent(html, { waitUntil: "domcontentloaded" });
      const pdf = await page.pdf({
        format: options.format ?? "A4",
        margin: {
          top: options.margin?.top ?? "1.5cm",
          right: options.margin?.right ?? "1.5cm",
          bottom: options.margin?.bottom ?? "1.5cm",
          left: options.margin?.left ?? "1.5cm",
        },
        printBackground: options.printBackground ?? true,
        preferCSSPageSize: false,
      });
      return Buffer.isBuffer(pdf) ? pdf : Buffer.from(pdf as Uint8Array);
    } finally {
      await context.close();
    }
  } finally {
    await browser.close();
  }
}

/**
 * Render `html` to a PDF and wrap it as a single email attachment. Returns
 * `undefined` (never throws) when PDF rendering is unavailable — e.g.
 * Chromium is missing on the host — so callers can still send the email
 * without it instead of failing the whole send. `context` only labels the
 * warning log (e.g. "invoice", "estimate").
 */
export async function renderPdfAttachment(
  html: string,
  filename: string,
  context: string,
): Promise<EmailAttachment[] | undefined> {
  try {
    const pdf = await htmlToPdf(html);
    return [{ filename, content: pdf, contentType: "application/pdf" }];
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      `[pdf] ${context} render failed; sending without attachment: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return undefined;
  }
}
