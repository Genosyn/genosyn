/** Real Chrome regressions for live and saved Run browser recordings.
 * Run `npm run test:browser-recording-live`. HTTP fixtures contain no credentials.
 * Server tests cover recording authorization and the recorder's frame lifecycle.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createCanvas } from "@napi-rs/canvas";
import { chromium, type Page, type Route } from "playwright-core";
import { build, preview } from "vite";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const artifacts = path.resolve(root, "../output/playwright");
async function startFixture() {
  // Follow browserFixture's build-before-preview pattern, but keep this root
  // outside node_modules: a worktree may symlink its dependencies elsewhere,
  // and Vite then realpaths the HTML outside the configured build root.
  const fixtureRoot = await fs.mkdtemp(path.join(root, "scripts/.browser-recording-live-"));
  try {
    await fs.writeFile(
      path.join(fixtureRoot, "index.html"),
      '<html><meta name="viewport" content="width=device-width, initial-scale=1"><div id="root"></div>' +
        '<script type="module" src="../browserRecordingLiveHarness.tsx"></script></html>',
    );
    await build({
      configFile: path.join(root, "vite.config.ts"),
      root: fixtureRoot,
      build: { outDir: path.join(fixtureRoot, "dist"), minify: false, reportCompressedSize: false },
    });
    const fixture = await preview({
      configFile: false,
      root: fixtureRoot,
      build: { outDir: path.join(fixtureRoot, "dist") },
      preview: { host: "127.0.0.1", port: 18496 },
    });
    const address = fixture.httpServer.address();
    if (!address || typeof address === "string") throw new Error("Browser fixture did not start");
    return {
      origin: `http://127.0.0.1:${address.port}`,
      async close() {
        try {
          await new Promise<void>((resolve, reject) => {
            fixture.httpServer.close((error) => (error ? reject(error) : resolve()));
            if ("closeAllConnections" in fixture.httpServer)
              fixture.httpServer.closeAllConnections();
          });
        } finally {
          await fs.rm(fixtureRoot, { recursive: true, force: true });
        }
      },
    };
  } catch (error) {
    await fs.rm(fixtureRoot, { recursive: true, force: true });
    throw error;
  }
}
const server = await startFixture();
const browser = await chromium
  .launch({
    channel: process.env.GENOSYN_TEST_BROWSER ?? "chrome",
    headless: true,
  })
  .catch(async (error) => {
    await server.close();
    throw error;
  });
const context = await browser.newContext({ viewport: { width: 1180, height: 900 } });
await context.addCookies([{ name: "recording-fixture", value: "member", url: server.origin }]);

type FrameColor = "red" | "green" | "blue";
const colors: Record<FrameColor, [number, number, number]> = {
  red: [220, 38, 38],
  green: [22, 163, 74],
  blue: [37, 99, 235],
};
function frame(color: FrameColor, label: string) {
  const canvas = createCanvas(960, 540);
  const paint = canvas.getContext("2d");
  paint.fillStyle = `rgb(${colors[color].join(",")})`;
  paint.fillRect(0, 0, 960, 540);
  paint.fillStyle = "#f8fafc";
  paint.fillRect(12, 12, 936, 516);
  paint.fillStyle = "#e2e8f0";
  paint.fillRect(12, 12, 936, 48);
  paint.fillStyle = "#ffffff";
  paint.fillRect(104, 23, 714, 25);
  paint.fillStyle = "#64748b";
  paint.font = "14px sans-serif";
  paint.fillText("company.example / briefing", 118, 41);
  paint.fillStyle = "#0f172a";
  paint.font = "bold 32px sans-serif";
  paint.fillText("Daily company briefing", 60, 132);
  paint.font = "21px sans-serif";
  paint.fillText(label, 60, 182);
  for (let i = 0; i < 3; i++) {
    paint.fillStyle = "#ffffff";
    paint.fillRect(60, 230 + i * 74, 840, 58);
    paint.fillStyle = "#cbd5e1";
    paint.fillRect(82, 248 + i * 74, 520 - i * 100, 10);
    paint.fillStyle = "#e2e8f0";
    paint.fillRect(82, 267 + i * 74, 720 - i * 120, 7);
  }
  return canvas.toBuffer("image/jpeg", 85);
}
const frames = {
  red: frame("red", "Reading the latest company updates…"),
  green: frame("green", "Preparing the briefing with the latest updates…"),
  blue: frame("blue", "Browser 2 is reviewing the revenue summary…"),
};

type Reply = {
  status: number;
  color?: FrameColor;
  body?: Buffer;
  mimeType?: string;
  networkError?: boolean;
};
type Probe = {
  activeUrls: string[];
  created: number;
  revoked: number;
  pending: number;
  peakPending: number;
  aborted: number;
  requests: Array<{ url: string; credentials: string; cache: string }>;
};
let liveReply: Reply = { status: 204 };
let secondReply: Reply = { status: 200, color: "blue" };
let heldSession: string | null = null;
let heldRoute: Route | null = null;
let requests = 0;
let currentPage: Page | null = null;
const pageErrors: string[] = [];
const unexpectedRequests: string[] = [];
const liveUrls: string[] = [];

// Build a tiny playable saved video with the browser's own codec. This checks
// the real <video> transition without introducing a test-only encoder dependency.
const encoderPage = await context.newPage();
const savedVideo = await encoderPage.evaluate(async () => {
  const mimeType = MediaRecorder.isTypeSupported("video/mp4") ? "video/mp4" : "video/webm";
  const canvas = document.createElement("canvas");
  canvas.width = 320;
  canvas.height = 180;
  const paint = canvas.getContext("2d")!;
  paint.fillStyle = "#0f172a";
  paint.fillRect(0, 0, 320, 180);
  const stream = canvas.captureStream(10);
  const recorder = new MediaRecorder(stream, { mimeType });
  const chunks: Blob[] = [];
  recorder.ondataavailable = (event) => chunks.push(event.data);
  const stopped = new Promise<void>((resolve) => {
    recorder.onstop = () => resolve();
  });
  recorder.start();
  paint.fillStyle = "#22c55e";
  paint.fillRect(30, 30, 260, 120);
  // captureStream emits changes, so animate several frames to give the saved
  // fixture a real duration rather than a zero-length still image.
  let tick = 0;
  const repaint = setInterval(() => {
    paint.fillStyle = tick++ % 2 ? "#22c55e" : "#16a34a";
    paint.fillRect(30, 30, 260, 120);
  }, 100);
  await new Promise((resolve) => setTimeout(resolve, 1_200));
  clearInterval(repaint);
  recorder.stop();
  await stopped;
  for (const track of stream.getTracks()) track.stop();
  return { mimeType, bytes: Array.from(new Uint8Array(await new Blob(chunks).arrayBuffer())) };
});
await encoderPage.close();

async function reply(route: Route, response: Reply) {
  if (response.networkError) return route.abort("connectionreset");
  return route.fulfill({
    status: response.status,
    contentType: response.mimeType ?? (response.status === 200 ? "image/jpeg" : "text/plain"),
    headers: { "Cache-Control": "private, no-store" },
    body: response.body ?? (response.color ? frames[response.color] : Buffer.alloc(0)),
  });
}
await context.route("**/api/**", async (route) => {
  const request = route.request();
  const url = new URL(request.url());
  if (/\/browser-recordings\/session-[ab]\/live$/.test(url.pathname)) {
    requests++;
    liveUrls.push(request.url());
    if (
      url.search ||
      request.method() !== "GET" ||
      !request.headers().cookie?.includes("recording-fixture=member")
    ) {
      unexpectedRequests.push(
        `Uncredentialed or unexpected frame request: ${request.method()} ${url}`,
      );
    }
    const session = url.pathname.split("/").at(-2)!;
    if (heldSession === session) {
      heldSession = null;
      heldRoute = route;
      return;
    }
    return reply(route, session === "session-a" ? liveReply : secondReply);
  }
  if (/\/browser-recordings\/session-[ab]$/.test(url.pathname)) {
    return route.fulfill({
      status: 200,
      contentType: savedVideo.mimeType,
      body: Buffer.from(savedVideo.bytes),
    });
  }
  unexpectedRequests.push(`${request.method()} ${url}`);
  return route.fulfill({ status: 404 });
});

async function open(multiple = false) {
  const page = await context.newPage();
  currentPage = page;
  page.setDefaultTimeout(10_000);
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.addInitScript(() => {
    const activeUrls = new Set<string>();
    const probe = {
      activeUrls: [] as string[],
      created: 0,
      revoked: 0,
      pending: 0,
      peakPending: 0,
      aborted: 0,
      requests: [] as Array<{ url: string; credentials: string; cache: string }>,
    };
    Object.defineProperty(window, "__recordingProbe", { value: probe });
    const create = URL.createObjectURL.bind(URL);
    const revoke = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = (blob) => {
      const url = create(blob);
      activeUrls.add(url);
      probe.created++;
      probe.activeUrls = [...activeUrls];
      return url;
    };
    URL.revokeObjectURL = (url) => {
      activeUrls.delete(url);
      probe.revoked++;
      probe.activeUrls = [...activeUrls];
      revoke(url);
    };
    const nativeFetch = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      if (!String(input).endsWith("/live")) return nativeFetch(input, init);
      probe.requests.push({
        url: String(input),
        credentials: init?.credentials ?? "",
        cache: init?.cache ?? "",
      });
      probe.pending++;
      probe.peakPending = Math.max(probe.peakPending, probe.pending);
      init?.signal?.addEventListener("abort", () => probe.aborted++, { once: true });
      try {
        return await nativeFetch(input, init);
      } finally {
        probe.pending--;
      }
    };
  });
  const params = new URLSearchParams({ videoMime: savedVideo.mimeType });
  if (multiple) params.set("multiple", "true");
  await page.goto(`${server.origin}/?${params}`, { waitUntil: "commit", timeout: 60_000 });
  await page.getByRole("region", { name: "Browser recording", exact: true }).waitFor();
  return page;
}
async function probe(page: Page): Promise<Probe> {
  return page.evaluate(() => (window as unknown as { __recordingProbe: Probe }).__recordingProbe);
}
async function waitForFrame(page: Page, color: FrameColor) {
  await page
    .waitForFunction((expected) => {
      const image = document.querySelector<HTMLImageElement>('img[alt="Live browser recording"]');
      if (!image?.complete || !image.naturalWidth) return false;
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 1;
      const paint = canvas.getContext("2d")!;
      // Sample inside the solid marker: JPEG ringing changes the exact corner.
      paint.drawImage(image, 4, 4, 1, 1, 0, 0, 1, 1);
      return [...paint.getImageData(0, 0, 1, 1).data]
        .slice(0, 3)
        .every((value, index) => Math.abs(value - expected[index]) < 15);
    }, colors[color])
    .catch(async (error) => {
      console.error(
        "Live image diagnostic:",
        await page.evaluate(() => {
          const image = document.querySelector<HTMLImageElement>(
            'img[alt="Live browser recording"]',
          );
          if (!image) return null;
          const canvas = document.createElement("canvas");
          canvas.width = canvas.height = 1;
          const paint = canvas.getContext("2d")!;
          if (image.complete && image.naturalWidth) paint.drawImage(image, 4, 4, 1, 1, 0, 0, 1, 1);
          return {
            complete: image.complete,
            width: image.naturalWidth,
            pixel: [...paint.getImageData(0, 0, 1, 1).data],
          };
        }),
      );
      throw error;
    });
}
async function waitFor(predicate: () => boolean, message: string) {
  const deadline = Date.now() + 10_000;
  for (;;) {
    if (predicate()) return;
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
async function releaseHeld(response: Reply) {
  const route = heldRoute;
  heldRoute = null;
  assert.ok(route, "A delayed browser frame was captured");
  // Chrome may already have cancelled this request on session change/unmount.
  await reply(route, response).catch((error) => {
    if (
      !/Invalid InterceptionId|already handled|Target.*closed|Request.*cancel/i.test(String(error))
    )
      throw error;
  });
}
async function assertNoFrame(page: Page) {
  assert.equal(await page.getByRole("img", { name: "Live browser recording" }).count(), 0);
  assert.deepEqual((await probe(page)).activeUrls, [], "Old frame bytes are released");
}
async function assertMediaFitsPane(page: Page, kind: "live" | "saved" = "live") {
  const media =
    kind === "live"
      ? page.getByRole("img", { name: "Live browser recording" })
      : page.locator("video");
  const bounds = await media.boundingBox();
  const region = page.getByRole("region", { name: "Browser recording", exact: true });
  const pane = await region.boundingBox();
  const header = await region.locator("header").boundingBox();
  assert.ok(
    bounds &&
      pane &&
      header &&
      bounds.x >= pane.x &&
      bounds.y >= header.y + header.height &&
      bounds.x + bounds.width <= pane.x + pane.width &&
      bounds.y + bounds.height <= pane.y + pane.height,
    `The whole browser viewport stays below its header and inside the recording pane: ${JSON.stringify({ bounds, pane, header })}`,
  );
}
async function setHidden(page: Page, hidden: boolean) {
  // Headless tabs stay visible; dispatch the browser visibility contract so
  // polling and cancellation are exercised without a desktop window manager.
  await page.evaluate((value) => {
    Object.defineProperty(document, "hidden", { configurable: true, value });
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: value ? "hidden" : "visible",
    });
    document.dispatchEvent(new Event("visibilitychange"));
  }, hidden);
}
let checks = 0;
async function check(name: string, run: () => Promise<void>) {
  console.log(`RUN ${name}`);
  await run();
  checks++;
  console.log(`PASS ${name}`);
}

try {
  await fs.mkdir(artifacts, { recursive: true });
  await Promise.all([
    fs.rm(path.join(artifacts, "browser-recording-live-failed.png"), { force: true }),
    fs.rm(path.join(artifacts, "browser-recording-live-failed.txt"), { force: true }),
  ]);
  await check(
    "waiting becomes changing live images through serial, credentialed requests",
    async () => {
      liveReply = { status: 204 };
      const page = await open();
      await page.getByText("Waiting for browser activity…", { exact: true }).waitFor();
      await assertNoFrame(page);
      liveReply = { status: 200, color: "red" };
      await waitForFrame(page, "red");
      const first = await page
        .getByRole("img", { name: "Live browser recording" })
        .getAttribute("src");
      liveReply = { status: 200, color: "green" };
      await waitForFrame(page, "green");
      assert.notEqual(
        await page.getByRole("img", { name: "Live browser recording" }).getAttribute("src"),
        first,
      );
      assert.equal(await page.getByRole("link", { name: "Download", exact: true }).count(), 0);
      const observation = await probe(page);
      assert.equal(
        observation.peakPending,
        1,
        "A slow connection cannot accumulate frame requests",
      );
      assert.ok(observation.created >= 2 && observation.revoked >= 1);
      assert.equal(observation.activeUrls.length, 1);
      assert.ok(
        observation.requests.every(
          (request) => request.credentials === "same-origin" && request.cache === "no-store",
        ),
      );
      await assertMediaFitsPane(page);
      await page.screenshot({
        path: path.join(artifacts, "browser-recording-live-desktop.png"),
        fullPage: true,
      });
      await page.close();
    },
  );

  await check("delayed frames cannot replace the newly selected browser session", async () => {
    liveReply = { status: 200, color: "red" };
    secondReply = { status: 204 };
    const page = await open(true);
    await waitForFrame(page, "red");
    heldSession = "session-a";
    await waitFor(() => heldRoute !== null, "No delayed frame request arrived");
    await page.getByRole("button", { name: "Browser recording 2, Live", exact: true }).click();
    await page.getByText("Waiting for browser activity…", { exact: true }).waitFor();
    await assertNoFrame(page);
    secondReply = { status: 200, color: "blue" };
    await waitForFrame(page, "blue");
    await releaseHeld({ status: 200, color: "red" });
    await page.waitForTimeout(400);
    await waitForFrame(page, "blue");
    assert.ok(
      (await probe(page)).aborted >= 1,
      "Switching sessions cancels its outstanding request",
    );
    await page.getByRole("button", { name: "Browser recording 1, Live", exact: true }).click();
    await waitForFrame(page, "red");
    await page.close();
  });

  await check(
    "missing, revoked, failed and corrupt frames clear and recover automatically",
    async () => {
      liveReply = { status: 200, color: "green" };
      const page = await open();
      await waitForFrame(page, "green");
      liveReply = { status: 204 };
      await page.getByText("Waiting for browser activity…", { exact: true }).waitFor();
      await assertNoFrame(page);
      for (const failure of [
        { status: 404 },
        { status: 403 },
        { status: 503 },
        { status: 0, networkError: true },
        { status: 200, mimeType: "text/html", body: Buffer.from("<p>Not a frame</p>") },
        { status: 200, body: Buffer.from("not a valid JPEG") },
      ]) {
        liveReply = { status: 200, color: "green" };
        await waitForFrame(page, "green");
        liveReply = failure;
        await page.getByText("Reconnecting to live view…", { exact: true }).waitFor();
        await assertNoFrame(page);
      }
      liveReply = { status: 200, color: "blue" };
      await waitForFrame(page, "blue");
      await page.close();
    },
  );

  await check("hidden tabs release frames, cancel requests, and resume when visible", async () => {
    liveReply = { status: 200, color: "green" };
    const page = await open();
    await waitForFrame(page, "green");
    heldSession = "session-a";
    await waitFor(() => heldRoute !== null, "No frame request arrived before hiding the tab");
    await setHidden(page, true);
    await assertNoFrame(page);
    await releaseHeld({ status: 200, color: "red" });
    const before = requests;
    await page.waitForTimeout(600);
    assert.equal(requests, before, "Hidden tabs do not poll");
    await assertNoFrame(page);
    liveReply = { status: 200, color: "blue" };
    await setHidden(page, false);
    await waitForFrame(page, "blue");
    await page.close();
  });

  await check(
    "the finished session transitions from live through finalizing into playable video",
    async () => {
      liveReply = { status: 200, color: "green" };
      const page = await open();
      await waitForFrame(page, "green");
      await page.getByRole("button", { name: "Finalize recording", exact: true }).click();
      await page.getByText("Finalizing browser recording…", { exact: true }).waitFor();
      await page
        .getByText("Genosyn is preparing the video for playback.", { exact: true })
        .waitFor();
      await assertNoFrame(page);
      const before = requests;
      await page.waitForTimeout(600);
      assert.equal(requests, before, "Finalizing sessions stop live polling");
      await page.getByRole("button", { name: "Save recording", exact: true }).click();
      await page.waitForFunction(() => (document.querySelector("video")?.readyState ?? 0) >= 1);
      await assertMediaFitsPane(page, "saved");
      const source = page.locator("video source");
      assert.equal(
        await source.getAttribute("src"),
        "/api/companies/company/runs/run/browser-recordings/session-a",
      );
      const download = page.getByRole("link", { name: "Download", exact: true });
      assert.equal(
        await download.getAttribute("href"),
        "/api/companies/company/runs/run/browser-recordings/session-a?disposition=attachment",
      );
      await page.evaluate(async () => {
        const video = document.querySelector("video")!;
        try {
          await video.play();
        } catch (error) {
          // A short fixture may end before a busy host delivers play's promise.
          if (!video.ended || video.currentTime <= 0) throw error;
        }
      });
      await page.waitForFunction(() => (document.querySelector("video")?.currentTime ?? 0) > 0);
      await page.screenshot({
        path: path.join(artifacts, "browser-recording-saved-desktop.png"),
        fullPage: true,
      });
      await page.close();
    },
  );

  await check(
    "the live pane fits a narrow viewport and releases all work when unmounted",
    async () => {
      liveReply = { status: 200, color: "green" };
      secondReply = { status: 200, color: "blue" };
      const page = await open(true);
      await page.setViewportSize({ width: 360, height: 780 });
      await waitForFrame(page, "green");
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        true,
      );
      await assertMediaFitsPane(page);
      await page.screenshot({
        path: path.join(artifacts, "browser-recording-live-mobile.png"),
        fullPage: true,
      });
      heldSession = "session-a";
      await waitFor(() => heldRoute !== null, "No pending frame request arrived before unmount");
      await page.getByRole("button", { name: "Unmount recording", exact: true }).click();
      await assertNoFrame(page);
      await releaseHeld({ status: 200, color: "red" });
      const before = requests;
      await page.waitForTimeout(600);
      assert.equal(requests, before, "Unmounting stops live polling");
      await assertNoFrame(page);
      assert.equal((await probe(page)).pending, 0);
      await page.getByRole("button", { name: "Mount recording", exact: true }).click();
      await waitForFrame(page, "green");
      await page.close();
    },
  );
  assert.ok(liveUrls.length > 10, "Several live frames were fetched");
  assert.deepEqual(unexpectedRequests, []);
  assert.deepEqual(pageErrors, [], "No browser runtime errors");
  console.log(`PASS ${checks} live browser recording regression groups`);
} catch (error) {
  const page = currentPage as Page | null;
  if (page && !page.isClosed()) {
    await page
      .screenshot({
        path: path.join(artifacts, "browser-recording-live-failed.png"),
        fullPage: true,
      })
      .catch(() => undefined);
    await fs.writeFile(
      path.join(artifacts, "browser-recording-live-failed.txt"),
      `${String(error)}\n${await page.locator("body").innerText()}`,
    );
  }
  throw error;
} finally {
  if (heldRoute) await releaseHeld({ status: 204 }).catch(() => undefined);
  await context.close();
  await browser.close();
  await server.close();
}
