import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  API_KEY_PLACEHOLDER,
  companyMcpUrl,
  MCP_CLIENTS,
  MCP_SERVER_NAME,
  mcpClientSetup,
  type McpClientId,
} from "./mcpSetup";

const ID = "3f2b7c1e-8a4d-4c6b-9e1f-0a2b3c4d5e6f";
const URL_ = `https://genosyn.example/api/companies/${ID}/mcp`;
const TOKEN = `gen_${"A".repeat(43)}`;

describe("the endpoint", () => {
  test("is the company's base URL followed by /mcp", () => {
    assert.equal(companyMcpUrl("https://genosyn.example", ID), URL_);
    assert.equal(
      companyMcpUrl("http://192.168.1.20:8471/", ID),
      `http://192.168.1.20:8471/api/companies/${ID}/mcp`,
    );
    assert.equal(
      companyMcpUrl("https://x.example", "a/b"),
      "https://x.example/api/companies/a%2Fb/mcp",
    );
  });
});

describe("the clients", () => {
  test("are Claude Desktop, Claude Code, Cursor, and everything else, in that order", () => {
    assert.deepEqual(
      MCP_CLIENTS.map((client) => client.id),
      ["claude-desktop", "claude-code", "cursor", "http"],
    );
    assert.equal(new Set(MCP_CLIENTS.map((client) => client.label)).size, MCP_CLIENTS.length);
  });

  test("every setup names the real endpoint and the key as a Bearer token", () => {
    for (const { id } of MCP_CLIENTS) {
      const setup = mcpClientSetup(id, { url: URL_, token: TOKEN });
      assert.ok(setup.snippet.includes(URL_), id);
      assert.ok(setup.snippet.includes(`Bearer ${TOKEN}`), id);
      assert.ok(!setup.snippet.includes(API_KEY_PLACEHOLDER), id);
      assert.ok(setup.where.length > 3, id);
      assert.ok(setup.note.endsWith("."), id);
    }
  });

  test("without a key, a placeholder stands in for it — never an empty token", () => {
    for (const { id } of MCP_CLIENTS) {
      for (const token of [undefined, null, "", "   "]) {
        const setup = mcpClientSetup(id, { url: URL_, token });
        assert.ok(
          setup.snippet.includes(`Bearer ${API_KEY_PLACEHOLDER}`),
          `${id} ${String(token)}`,
        );
      }
    }
  });
});

describe("each client's setup, exactly", () => {
  test("Claude Desktop bridges through mcp-remote, the header in an env var where its space survives", () => {
    const setup = mcpClientSetup("claude-desktop", { url: URL_, token: TOKEN });
    assert.equal(setup.language, "json");
    assert.equal(setup.where, "claude_desktop_config.json");
    assert.deepEqual(JSON.parse(setup.snippet), {
      mcpServers: {
        [MCP_SERVER_NAME]: {
          command: "npx",
          args: ["-y", "mcp-remote", URL_, "--header", "Authorization:${GENOSYN_AUTH}"],
          env: { GENOSYN_AUTH: `Bearer ${TOKEN}` },
        },
      },
    });
    assert.match(setup.note, /Settings → Developer → Edit Config/);
    assert.match(setup.note, /Node\.js/);
  });

  test("Claude Code takes one command over Streamable HTTP", () => {
    const setup = mcpClientSetup("claude-code", { url: URL_, token: TOKEN });
    assert.equal(setup.language, "bash");
    assert.equal(
      setup.snippet,
      `claude mcp add --transport http genosyn ${URL_} \\\n  --header "Authorization: Bearer ${TOKEN}"`,
    );
    assert.match(setup.note, /--scope user/);
  });

  test("Cursor takes the URL and the header in mcp.json", () => {
    const setup = mcpClientSetup("cursor", { url: URL_, token: TOKEN });
    assert.equal(setup.where, "~/.cursor/mcp.json");
    assert.deepEqual(JSON.parse(setup.snippet), {
      mcpServers: { genosyn: { url: URL_, headers: { Authorization: `Bearer ${TOKEN}` } } },
    });
  });

  test("any other client: a POST of JSON-RPC, accepting JSON and event streams", () => {
    const setup = mcpClientSetup("http", { url: URL_, token: TOKEN });
    assert.equal(setup.language, "bash");
    assert.equal(
      setup.snippet,
      [
        `curl -X POST ${URL_} \\`,
        `  -H "Authorization: Bearer ${TOKEN}" \\`,
        '  -H "Content-Type: application/json" \\',
        '  -H "Accept: application/json, text/event-stream" \\',
        `  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'`,
      ].join("\n"),
    );
    const body = /-d '(.+)'$/.exec(setup.snippet)?.[1] ?? "";
    assert.deepEqual(JSON.parse(body), { jsonrpc: "2.0", id: 1, method: "tools/list" });
    assert.match(setup.note, /stateless/);
  });

  test("a URL with a port and an IP survives in every format", () => {
    const url = `http://10.0.0.5:8471/api/companies/${ID}/mcp`;
    for (const id of ["claude-desktop", "cursor"] as McpClientId[]) {
      assert.ok(JSON.stringify(JSON.parse(mcpClientSetup(id, { url }).snippet)).includes(url), id);
    }
  });
});
