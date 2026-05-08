import fs from "node:fs";

/**
 * One-shot HTML → PDF rendering via Playwright's Chromium. Used to give
 * AI employees and the resource download menu a real PDF instead of a
 * print-dialog detour. Each call launches and disposes its own browser
 * so a slow render can't pin a long-lived process; volume is low enough
 * that pooling isn't worth the complexity yet.
 *
 * The Chromium binary path follows the same `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`
 * env var the MCP browser feature uses (set by App's Dockerfile to
 * `/usr/bin/chromium-browser`). For local dev on macOS we fall through
 * to the system Google Chrome — pdf rendering is identical to Chromium
 * for our purposes.
 */

const MACOS_CHROME_PATH = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

function resolveChromiumPath(): string | undefined {
  const env = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  if (env) return env;
  if (process.platform === "darwin" && fs.existsSync(MACOS_CHROME_PATH)) {
    return MACOS_CHROME_PATH;
  }
  return undefined;
}

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
  const executablePath = resolveChromiumPath();
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
