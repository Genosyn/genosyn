/**
 * Real Chrome coverage for the shorter chat flows, on the real App: arriving
 * at an AI Employee's chat, a Workspace channel or the Ask AI panel puts the
 * cursor in the message box (never on a touch device, never over a dialog or
 * another box being typed in); a running reply stops in one click; Enter
 * completes the New channel and New DM dialogs; channel settings close on
 * save; the emoji picker hands focus back; and with one AI Employee able to
 * answer, Ask AI addresses them without an @. Each flow counts its clicks.
 * Run with `npm run test:clicks-chat`.
 */
import assert from "node:assert/strict";
import type { ConversationMessage, ConversationSummary, Employee } from "../client/lib/api";
import type { AskAiRosterEntry } from "../client/lib/askAi";
import type { WorkspaceChannel, WorkspaceMessage } from "../client/lib/workspace";
import {
  API,
  ME,
  NOW,
  gate,
  hoursAgo,
  noSidewaysScroll,
  sse,
  startApp,
  waitForFocus,
  type ApiRoute,
} from "./appFixture";

const app = await startApp("Fewer clicks — chat, Workspace and Ask AI");

// ───────────────────────────── fixtures ─────────────────────────────

const ALEX: Employee = {
  id: "alex",
  companyId: "company",
  name: "Alex Rivera",
  slug: "alex",
  role: "Account manager",
  avatarKey: null,
  model: { provider: "anthropic", model: "claude-sonnet", status: "connected" },
  modelCount: 1,
};
const SAM: Employee = {
  ...ALEX,
  id: "sam",
  name: "Sam Okafor",
  slug: "sam",
  role: "Engineer",
};

function conversation(id: string, title: string, hoursOld: number): ConversationSummary {
  return {
    id,
    employeeId: ALEX.id,
    title,
    archivedAt: null,
    createdAt: hoursAgo(hoursOld),
    updatedAt: hoursAgo(hoursOld),
    lastMessageAt: hoursAgo(hoursOld),
    lastModelId: "model-1",
  };
}

function chatMessage(
  id: string,
  conversationId: string,
  role: "user" | "assistant",
  content: string,
  status: ConversationMessage["status"] = role === "assistant" ? "ok" : null,
): ConversationMessage {
  return { id, conversationId, role, content, status, createdAt: hoursAgo(1) };
}

/** An employee's chat: two threads, a model, and a reply that can be held open. */
function chatRoutes(options: { held?: ReturnType<typeof gate> } = {}): ApiRoute[] {
  const threads = [
    conversation("thread-renewal", "Acme renewal terms", 1),
    conversation("thread-launch", "Launch checklist", 5),
  ];
  const sent: ConversationMessage[] = [];
  return [
    ["GET", `${API}/employees`, () => [ALEX, SAM]],
    ["GET", `${API}/employees/alex`, () => ALEX],
    ["GET", /^\/api\/companies\/company\/employees\/(alex|sam)\/conversations$/, () => threads],
    [
      "GET",
      /^\/api\/companies\/company\/employees\/alex\/conversations\/([^/]+)$/,
      ({ match }) => {
        const thread = threads.find((t) => t.id === match[1]);
        if (!thread) return { conversation: conversation(match[1], "New", 0), messages: [] };
        return {
          conversation: thread,
          messages: [
            chatMessage(`${thread.id}-q`, thread.id, "user", `About ${thread.title}?`),
            chatMessage(`${thread.id}-a`, thread.id, "assistant", `Here is ${thread.title}.`),
            ...sent.filter((m) => m.conversationId === thread.id),
          ],
        };
      },
    ],
    [
      "GET",
      /^\/api\/companies\/company\/employees\/(alex|sam)\/models$/,
      () => [
        {
          id: "model-1",
          employeeId: "alex",
          provider: "anthropic",
          model: "claude-sonnet",
          authMode: "apikey",
          status: "connected",
          isActive: true,
          connectedAt: hoursAgo(100),
          name: "Claude",
        },
      ],
    ],
    ["GET", /^\/api\/companies\/company\/member-browsers\/for-employee\/[^/]+$/, () => []],
    [
      "POST",
      /^\/api\/companies\/company\/employees\/alex\/conversations\/([^/]+)\/messages$/,
      async ({ match, body }) => {
        const id = match[1];
        const user = chatMessage(`u-${sent.length}`, id, "user", String(body.message ?? ""));
        sent.push(user);
        if (options.held) await options.held.opened;
        const reply = chatMessage(
          `a-${sent.length}`,
          id,
          "assistant",
          options.held ? "I had started on the renewal terms" : "On it.",
          options.held ? "interrupted" : "ok",
        );
        sent.push(reply);
        return sse([
          ["user", user],
          ["assistant", reply],
          ["done", {}],
        ]);
      },
    ],
    [
      "POST",
      /^\/api\/companies\/company\/employees\/alex\/conversations\/([^/]+)\/interrupt$/,
      () => {
        options.held?.open();
        return { interrupted: true };
      },
    ],
  ];
}

const composer = (page: import("playwright-core").Page) =>
  page.getByPlaceholder(/^(Message|Add a follow-up for) Alex Rivera…$/);

// ───────────────────────────── Employee chat ─────────────────────────────

await app.check(
  "roster → chat: one click on the card and the cursor is already in the message box",
  async () => {
    const view = await app.open({ path: "/c/acme/employees", routes: chatRoutes() });
    const { page } = view;
    await view.click(page.getByRole("link", { name: /Alex Rivera/ }).first());
    await view.landedOn("/c/acme/employees/alex/chat");
    await waitForFocus(composer(page), "the message box has focus on arrival");
    await page.keyboard.type("Draft the renewal email");
    await page.keyboard.press("Enter");
    await page.getByText("On it.", { exact: true }).waitFor();
    assert.equal(view.clicks(), 1, "one click from the roster to a sent message");
    assert.equal(
      view.writes.filter((w) => w.path.endsWith("/messages")).at(-1)?.body.message,
      "Draft the renewal email",
    );
    await page.close();
  },
);

await app.check("switching threads moves the cursor into the box for the new one", async () => {
  const view = await app.open({ path: "/c/acme/employees/alex/chat", routes: chatRoutes() });
  const { page } = view;
  await waitForFocus(composer(page));
  // Move focus away, as a reader scrolling the transcript would.
  await page
    .getByText("Launch checklist")
    .first()
    .focus()
    .catch(() => undefined);
  await view.click(page.getByRole("button", { name: /Launch checklist/ }).first());
  await page.getByText("Here is Launch checklist.").waitFor();
  await waitForFocus(composer(page), "the box has focus after switching threads");
  await page.close();
});

await app.check("a draft carried back keeps the cursor after its last word", async () => {
  const view = await app.open({ path: "/c/acme/employees/alex/chat", routes: chatRoutes() });
  const { page } = view;
  await waitForFocus(composer(page));
  await page.keyboard.type("Remind me about the renewal");
  // Leave for the roster and come back: the draft is still there, cursor at its end.
  await page.getByRole("link", { name: "All employees", exact: true }).click();
  await view.landedOn("/c/acme/employees");
  await page
    .getByRole("link", { name: /Alex Rivera/ })
    .first()
    .click();
  await waitForFocus(composer(page));
  const caret = await composer(page).evaluate((el) => {
    const box = el as HTMLTextAreaElement;
    return { value: box.value, start: box.selectionStart, end: box.selectionEnd };
  });
  assert.equal(caret.value, "Remind me about the renewal");
  assert.equal(caret.start, caret.value.length);
  assert.equal(caret.end, caret.value.length);
  await page.close();
});

await app.check("on a phone the box is left alone, so no keyboard covers the thread", async () => {
  const view = await app.open({
    path: "/c/acme/employees/alex/chat",
    routes: chatRoutes(),
    touch: true,
  });
  const { page } = view;
  await composer(page).waitFor();
  await page.getByText("Here is Acme renewal terms.").waitFor();
  await page.waitForTimeout(300);
  assert.equal(
    await composer(page).evaluate((el) => el === document.activeElement),
    false,
    "no arrival focus on a touch device",
  );
  await noSidewaysScroll(page, "chat on a phone");
  await page.close();
});

await app.check(
  "a running reply stops in one click from the empty box, keeping what was written",
  async () => {
    const held = gate();
    const view = await app.open({
      path: "/c/acme/employees/alex/chat",
      routes: chatRoutes({ held }),
    });
    const { page } = view;
    await waitForFocus(composer(page));
    await page.keyboard.type("Draft the renewal terms");
    await page.keyboard.press("Enter");
    const stop = page.getByRole("button", { name: "Stop Alex Rivera", exact: true });
    await stop.waitFor();
    // Typing turns the same button back into Queue; clearing brings Stop back.
    await page.keyboard.type("x");
    await page.getByRole("button", { name: "Queue message", exact: true }).waitFor();
    await page.keyboard.press("Backspace");
    await stop.waitFor();
    await view.click(stop);
    await page.getByText("I had started on the renewal terms").waitFor();
    assert.ok(
      view.writes.some((w) => w.path.endsWith("/conversations/thread-renewal/interrupt")),
      "the stop reached the server",
    );
    assert.equal(
      view.writes.filter((w) => w.path.endsWith("/messages")).length,
      1,
      "stopping sends no throwaway message",
    );
    await waitForFocus(composer(page), "the cursor is back in the box for a correction");
    await page.getByRole("button", { name: "Send message", exact: true }).waitFor();
    assert.equal(view.clicks(), 1);
    await page.close();
  },
);

// ───────────────────────────── Workspace ─────────────────────────────

const PRIYA = { id: "priya", name: "Priya Shah", email: "priya@example.test", handle: "priya" };

function channel(
  id: string,
  name: string | null,
  kind: WorkspaceChannel["kind"] = "public",
  members: WorkspaceChannel["members"] = [
    { kind: "user", id: ME.id, name: ME.name, email: ME.email },
    { kind: "user", id: PRIYA.id, name: PRIYA.name, email: PRIYA.email },
  ],
): WorkspaceChannel {
  return {
    id,
    companyId: "company",
    kind,
    name,
    slug: name,
    topic: name === "general" ? "Company-wide updates" : "",
    archivedAt: null,
    createdByUserId: ME.id,
    createdAt: hoursAgo(200),
    lastMessageAt: hoursAgo(2),
    members,
    unreadCount: 0,
    lastReadAt: hoursAgo(2),
  };
}

function workspaceMessage(id: string, channelId: string, content: string): WorkspaceMessage {
  return {
    id,
    channelId,
    authorKind: "user",
    author: { kind: "user", id: PRIYA.id, name: PRIYA.name, email: PRIYA.email },
    content,
    parentMessageId: null,
    editedAt: null,
    deletedAt: null,
    createdAt: hoursAgo(2),
    attachments: [],
    reactions: [],
  };
}

function workspaceRoutes(): ApiRoute[] {
  const channels = [channel("ch-general", "general"), channel("ch-sales", "sales")];
  const messages = new Map<string, WorkspaceMessage[]>([
    ["ch-general", [workspaceMessage("m-1", "ch-general", "Welcome to general.")]],
    ["ch-sales", [workspaceMessage("m-2", "ch-sales", "Pipeline review at 3.")]],
  ]);
  return [
    ["GET", `${API}/workspace/channels`, () => channels],
    [
      "GET",
      `${API}/workspace/directory`,
      () => ({
        members: [{ id: ME.id, name: ME.name, email: ME.email, handle: "morgan" }, PRIYA],
        employees: [
          { id: ALEX.id, name: ALEX.name, slug: ALEX.slug, role: ALEX.role },
          { id: SAM.id, name: SAM.name, slug: SAM.slug, role: SAM.role },
        ],
      }),
    ],
    ["GET", `${API}/workspace/mentionables`, () => []],
    [
      "GET",
      /^\/api\/companies\/company\/workspace\/channels\/([^/]+)\/messages$/,
      ({ match }) => messages.get(match[1]) ?? [],
    ],
    [
      "GET",
      /^\/api\/companies\/company\/workspace\/channels\/([^/]+)\/webhook$/,
      () => ({ enabled: false, url: null }),
    ],
    [
      "GET",
      /^\/api\/companies\/company\/workspace\/channels\/([^/]+)$/,
      ({ match }) => channels.find((c) => c.id === match[1]),
    ],
    ["POST", /^\/api\/companies\/company\/workspace\/channels\/[^/]+\/read$/, () => ({ ok: true })],
    [
      "POST",
      `${API}/workspace/channels`,
      ({ body }) => {
        const created = channel(`ch-${String(body.name)}`, String(body.name));
        created.topic = String(body.topic ?? "");
        channels.unshift(created);
        messages.set(created.id, []);
        return created;
      },
    ],
    [
      "POST",
      `${API}/workspace/dms`,
      ({ body }) => {
        const employee = [ALEX, SAM].find((e) => e.id === body.targetEmployeeId);
        const counterpart: WorkspaceChannel["members"][number] = employee
          ? {
              kind: "ai",
              id: employee.id,
              name: employee.name,
              slug: employee.slug,
              role: employee.role,
            }
          : { kind: "user", id: PRIYA.id, name: PRIYA.name, email: PRIYA.email };
        const dm = channel(`dm-${String(body.targetEmployeeId ?? body.targetUserId)}`, null, "dm", [
          { kind: "user", id: ME.id, name: ME.name, email: ME.email },
          counterpart,
        ]);
        channels.push(dm);
        messages.set(dm.id, []);
        return dm;
      },
    ],
    [
      "PATCH",
      /^\/api\/companies\/company\/workspace\/channels\/([^/]+)$/,
      ({ match, body }) => {
        const row = channels.find((c) => c.id === match[1])!;
        Object.assign(row, { name: body.name, slug: body.name, topic: body.topic });
        return row;
      },
    ],
    [
      "POST",
      /^\/api\/companies\/company\/workspace\/channels\/([^/]+)\/messages$/,
      ({ match, body }) => {
        const sent: WorkspaceMessage = {
          ...workspaceMessage(`m-sent-${match[1]}`, match[1], String(body.content)),
          author: { kind: "user", id: ME.id, name: ME.name, email: ME.email },
        };
        messages.get(match[1])?.push(sent);
        return sent;
      },
    ],
    ["GET", `${API}/employees`, () => [ALEX, SAM]],
  ];
}

const channelBox = (page: import("playwright-core").Page, label: string) =>
  page.getByPlaceholder(`Message ${label}`, { exact: true });

await app.check(
  "Workspace: opening a channel from the list puts the cursor in its box — one click to a sent message",
  async () => {
    const view = await app.open({ path: "/c/acme/workspace", routes: workspaceRoutes() });
    const { page } = view;
    await view.landedOn("/c/acme/workspace/ch-general");
    await waitForFocus(channelBox(page, "#general"), "the first channel's box on arrival");
    await view.click(page.getByRole("button", { name: "sales", exact: true }));
    await view.landedOn("/c/acme/workspace/ch-sales");
    await page.getByText("Pipeline review at 3.").waitFor();
    await waitForFocus(channelBox(page, "#sales"), "the box after switching channels");
    await page.keyboard.type("Numbers are in");
    await page.keyboard.press("Enter");
    await page.getByText("Numbers are in", { exact: true }).waitFor();
    assert.equal(view.clicks(), 1);
    assert.equal(
      view.writes.find((w) => w.path.endsWith("/channels/ch-sales/messages"))?.body.content,
      "Numbers are in",
    );
    await page.close();
  },
);

await app.check(
  "Workspace: New channel completes on Enter and lands in it, ready to type",
  async () => {
    const view = await app.open({
      path: "/c/acme/workspace/ch-general",
      routes: workspaceRoutes(),
    });
    const { page } = view;
    await waitForFocus(channelBox(page, "#general"));
    await view.click(page.getByRole("button", { name: "Create channel", exact: true }));
    const dialog = page.getByRole("dialog", { name: "Create a channel" });
    await waitForFocus(dialog.getByLabel("Name", { exact: true }), "Name is ready to type");
    await page.keyboard.type("launch");
    await page.keyboard.press("Enter");
    await dialog.waitFor({ state: "detached" });
    await view.landedOn("/c/acme/workspace/ch-launch");
    await waitForFocus(channelBox(page, "#launch"), "the new channel's box has focus");
    assert.equal(view.clicks(), 1, "one click and Enter, no Create button");
    assert.deepEqual(view.writes.find((w) => w.path === `${API}/workspace/channels`)?.body, {
      name: "launch",
      topic: "",
      kind: "public",
      memberUserIds: [],
      employeeIds: [],
    });
    await page.close();
  },
);

await app.check(
  "Workspace: New DM opens the only match on Enter; an ambiguous search waits",
  async () => {
    const view = await app.open({
      path: "/c/acme/workspace/ch-general",
      routes: workspaceRoutes(),
    });
    const { page } = view;
    await view.click(page.getByRole("button", { name: "New DM", exact: true }));
    const dialog = page.getByRole("dialog", { name: "Start a direct message" });
    const search = dialog.getByRole("textbox", { name: "Search teammates or AI employees" });
    await waitForFocus(search);
    // "a" matches several people: Enter must not guess.
    await page.keyboard.type("a");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(250);
    assert.equal(view.writes.filter((w) => w.path.endsWith("/workspace/dms")).length, 0);
    assert.equal(await dialog.getByText(/^Press Enter to message/).count(), 0);
    await search.fill("sam");
    await dialog.getByText("Press Enter to message Sam Okafor.", { exact: true }).waitFor();
    await page.keyboard.press("Enter");
    await dialog.waitFor({ state: "detached" });
    await view.landedOn("/c/acme/workspace/dm-sam");
    await waitForFocus(channelBox(page, "your recipient"), "the DM's box has focus");
    assert.deepEqual(
      view.writes.filter((w) => w.path.endsWith("/workspace/dms")).map((w) => w.body),
      [{ targetEmployeeId: "sam" }],
    );
    assert.equal(view.clicks(), 1);
    await page.close();
  },
);

await app.check(
  "Workspace: channel settings save on Enter and close themselves; ⌘Enter saves from the topic",
  async () => {
    const view = await app.open({
      path: "/c/acme/workspace/ch-sales",
      routes: workspaceRoutes(),
    });
    const { page } = view;
    await view.click(page.getByRole("button", { name: /Settings/ }).first());
    const dialog = page.getByRole("dialog", { name: "Channel settings" });
    const name = dialog.getByLabel("Name", { exact: true });
    await name.fill("sales-emea");
    await name.press("Enter");
    await dialog.waitFor({ state: "detached" });
    await page.locator("header").getByText("sales-emea", { exact: true }).waitFor();
    assert.equal(view.clicks(), 1, "Settings, type, Enter: no Save or Close clicks");
    await view.click(page.getByRole("button", { name: /Settings/ }).first());
    const again = page.getByRole("dialog", { name: "Channel settings" });
    const topic = again.getByLabel("Topic", { exact: true });
    await topic.fill("EMEA pipeline");
    await topic.press("ControlOrMeta+Enter");
    await again.waitFor({ state: "detached" });
    assert.deepEqual(
      view.writes.filter((w) => w.method === "PATCH").map((w) => w.body),
      [
        { name: "sales-emea", topic: "" },
        { name: "sales-emea", topic: "EMEA pipeline" },
      ],
    );
    await page.close();
  },
);

await app.check("Workspace: the emoji picker hands focus back to the message", async () => {
  const view = await app.open({
    path: "/c/acme/workspace/ch-general",
    routes: workspaceRoutes(),
  });
  const { page } = view;
  const box = channelBox(page, "#general");
  await waitForFocus(box);
  await page.keyboard.type("Ship it ");
  await view.click(page.getByRole("button", { name: "Emoji", exact: true }));
  await view.click(page.getByRole("button", { name: "🚀", exact: true }));
  await waitForFocus(box, "typing carries on after picking an emoji");
  await page.keyboard.type("!");
  assert.equal(await box.inputValue(), "Ship it 🚀!");
  await page.getByRole("button", { name: "Emoji", exact: true }).click();
  const filter = page.getByRole("textbox", { name: "Filter emoji by category" });
  await waitForFocus(filter);
  await page.keyboard.press("Escape");
  await filter.waitFor({ state: "detached" });
  await waitForFocus(box, "Esc closes the picker and returns to the message");
  await page.close();
});

// ───────────────────────────── Ask AI ─────────────────────────────

function rosterEntry(employee: Employee, hasModel = true): AskAiRosterEntry {
  return {
    id: employee.id,
    name: employee.name,
    slug: employee.slug,
    role: employee.role,
    avatarKey: null,
    hasModel,
    models: hasModel
      ? [{ id: `${employee.id}-model`, provider: "anthropic", model: "claude", isActive: true }]
      : [],
  };
}

function askAiRoutes(roster: AskAiRosterEntry[]): ApiRoute[] {
  const conversations = [
    { id: "ask-1", title: "Pricing questions", lastMessageAt: hoursAgo(1), createdAt: hoursAgo(3) },
    { id: "ask-2", title: "Hiring plan", lastMessageAt: hoursAgo(5), createdAt: hoursAgo(6) },
  ];
  return [
    ["GET", `${API}/ask-ai`, () => ({ conversations, roster })],
    [
      "GET",
      /^\/api\/companies\/company\/ask-ai\/conversations\/([^/]+)$/,
      ({ match }) => ({
        conversation: conversations.find((c) => c.id === match[1]) ?? {
          id: match[1],
          title: null,
          lastMessageAt: NOW.toISOString(),
          createdAt: NOW.toISOString(),
        },
        messages: [],
        roster,
        modelId: null,
      }),
    ],
    [
      "POST",
      `${API}/ask-ai/conversations`,
      () => {
        const created = {
          id: `ask-new-${conversations.length}`,
          title: null,
          lastMessageAt: NOW.toISOString(),
          createdAt: NOW.toISOString(),
        };
        conversations.unshift(created);
        return { conversation: created };
      },
    ],
    ["POST", `${API}/ask-ai/context`, () => ({ items: [], defaultEmployeeIds: [], withheld: {} })],
    [
      "POST",
      /^\/api\/companies\/company\/ask-ai\/conversations\/([^/]+)\/messages$/,
      ({ match, body }) => {
        const base = {
          conversationId: match[1],
          modelId: null,
          actions: [],
          suggestions: [],
          attachments: [],
          context: null,
          createdAt: NOW.toISOString(),
        };
        const user = {
          ...base,
          id: "ask-u1",
          role: "user",
          turnId: null,
          employeeId: null,
          status: null,
          content: body.message,
        };
        const reply = {
          ...base,
          id: "ask-a1",
          role: "assistant",
          turnId: "ask-u1",
          employeeId: roster[0].id,
          status: "ok",
          content: "Here is what I found.",
        };
        return sse([
          ["user", user],
          ["assistant", reply],
          ["done", {}],
        ]);
      },
    ],
    ["GET", `${API}/employees`, () => [ALEX, SAM]],
  ];
}

const askPanel = (page: import("playwright-core").Page) =>
  page.getByRole("complementary", { name: "Ask AI" });
const askBox = (page: import("playwright-core").Page) => askPanel(page).locator("textarea").last();

await app.check(
  "Ask AI: ⌘J opens it ready to type; New conversation and picking one keep the cursor in the box",
  async () => {
    const view = await app.open({
      path: "/c/acme/workspace/ch-general",
      routes: [...askAiRoutes([rosterEntry(ALEX), rosterEntry(SAM)]), ...workspaceRoutes()],
    });
    const { page } = view;
    // Even from the channel's own box: opening Ask AI is a request to type there.
    await waitForFocus(channelBox(page, "#general"));
    await page.keyboard.press("ControlOrMeta+j");
    await askPanel(page).waitFor();
    await waitForFocus(askBox(page), "⌘J lands in the Ask AI box");
    await view.click(askPanel(page).getByRole("button", { name: "New conversation", exact: true }));
    await waitForFocus(askBox(page), "a new conversation is ready to type");
    await view.click(askPanel(page).getByRole("button", { name: /^Ask AI/ }));
    await view.click(page.getByRole("menuitem", { name: /Hiring plan/ }));
    await waitForFocus(askBox(page), "a picked conversation is ready to type");
    await page.close();
  },
);

await app.check("Ask AI: a reload with the panel open leaves the page's focus alone", async () => {
  const view = await app.open({
    path: "/c/acme/employees",
    routes: askAiRoutes([rosterEntry(ALEX), rosterEntry(SAM)]),
    storage: { "genosyn.askAi.open": "1" },
  });
  const { page } = view;
  await askBox(page).waitFor();
  await page.waitForTimeout(400);
  assert.equal(
    await askBox(page).evaluate((el) => el === document.activeElement),
    false,
    "reopening on its own does not grab focus",
  );
  await page.close();
});

await app.check(
  "Ask AI: with one AI Employee able to answer, the question goes to them without an @",
  async () => {
    const view = await app.open({
      path: "/c/acme/employees",
      routes: askAiRoutes([rosterEntry(ALEX), rosterEntry(SAM, false)]),
    });
    const { page } = view;
    await view.click(page.getByRole("button", { name: "Ask AI", exact: true }).first());
    await waitForFocus(askBox(page));
    const recipients = askPanel(page).getByRole("group", { name: "Recipients" });
    await recipients.getByText("Alex Rivera").waitFor();
    assert.equal(await recipients.getByText("nobody yet — tag someone with @").count(), 0);
    assert.equal(
      await askPanel(page).getByRole("button", { name: "Remove Alex Rivera", exact: true }).count(),
      0,
      "nobody to swap the only answerer for",
    );
    await page.keyboard.type("What did we promise Acme?");
    await page.keyboard.press("Enter");
    await askPanel(page).getByText("Here is what I found.").waitFor();
    const sent = view.writes.find((w) => w.path.endsWith("/messages"));
    assert.deepEqual(sent?.body.employeeIds, ["alex"], "the send names the one who can answer");
    assert.equal(view.clicks(), 1);
    await page.close();
  },
);

await app.finish();
