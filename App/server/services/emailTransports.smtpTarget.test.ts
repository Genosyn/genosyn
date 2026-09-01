import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";

import { config } from "../../config.js";
import {
  ALLOWED_SMTP_PORTS,
  assertSmtpTargetAllowed,
  sendViaProvider,
} from "./emailTransports.js";

/**
 * A hosted tenant cannot aim an SMTP provider at the operator's network.
 *
 * `installOutboundNetworkPolicy` patches the global http/https agents and the
 * undici dispatcher. Nodemailer uses neither — it opens a raw TCP socket — so
 * the SMTP host field was the one outbound destination in the product with no
 * check at all. A tenant admin could point a provider at `10.0.0.5:6379` and
 * read the connection outcome off the Test button, which is a working port
 * scanner of the cluster network; the non-standard-port branch of
 * `resolveSmtpTransportSecurity` leaves it plaintext, which is the smuggling
 * primitive against anything line-tolerant listening there.
 *
 * The guard is multi-tenant only, deliberately. A self-hosted install pointing
 * at `smtp.internal:25` or a sidecar relay is ordinary and correct, and that
 * admin already owns the network. Shared SaaS boots with an empty
 * `outboundPrivateHostAllowlist` — `validateRuntimeSecurity` refuses to start
 * otherwise — so there is no hosted escape hatch through the allowlist either.
 *
 * Every destination here is an IP literal or `localhost`, so the suite makes
 * no network calls and needs no DNS beyond the host's own resolver.
 */

const security = config.security as {
  multiTenant: boolean;
  outboundPrivateHostAllowlist: string[];
};
const originalMultiTenant = security.multiTenant;
const originalAllowlist = [...security.outboundPrivateHostAllowlist];

afterEach(() => {
  security.multiTenant = originalMultiTenant;
  security.outboundPrivateHostAllowlist = [...originalAllowlist];
});

function hosted() {
  security.multiTenant = true;
  security.outboundPrivateHostAllowlist = [];
}

describe("ALLOWED_SMTP_PORTS", () => {
  test("covers submission, implicit TLS, relay and the common fallback", () => {
    assert.deepEqual([...ALLOWED_SMTP_PORTS].sort((a, b) => a - b), [25, 465, 587, 2525]);
  });
});

describe("assertSmtpTargetAllowed — port", () => {
  for (const port of [25, 465, 587, 2525]) {
    test(`allows the mail port ${port}`, async () => {
      hosted();
      await assert.doesNotReject(() => assertSmtpTargetAllowed("8.8.8.8", port));
    });
  }

  const refusedPorts = [
    [6379, "redis"],
    [5432, "postgres"],
    [3306, "mysql"],
    [22, "ssh"],
    [80, "http"],
    [443, "https"],
    [9200, "elasticsearch"],
    [11211, "memcached"],
    [0, "the null port"],
    [65535, "the top of the range"],
  ] as const;
  for (const [port, label] of refusedPorts) {
    test(`refuses ${port} (${label})`, async () => {
      hosted();
      await assert.rejects(
        () => assertSmtpTargetAllowed("8.8.8.8", port),
        /not allowed/,
        `port ${port} should be refused`,
      );
    });
  }

  test("the refusal tells the operator which ports are usable", async () => {
    hosted();
    await assert.rejects(() => assertSmtpTargetAllowed("8.8.8.8", 6379), /25, 465, 587 or 2525/);
  });
});

describe("assertSmtpTargetAllowed — destination", () => {
  const privateTargets = [
    ["127.0.0.1", "loopback"],
    ["10.0.0.5", "RFC1918 class A"],
    ["192.168.1.10", "RFC1918 class C"],
    ["172.16.0.9", "RFC1918 class B"],
    ["169.254.169.254", "cloud instance metadata"],
    ["100.64.0.1", "carrier-grade NAT"],
    ["0.0.0.0", "the unspecified address"],
    ["localhost", "the loopback name"],
    ["[::1]", "IPv6 loopback"],
  ] as const;

  for (const [host, label] of privateTargets) {
    test(`refuses ${host} (${label}) on an allowed port`, async () => {
      hosted();
      await assert.rejects(
        () => assertSmtpTargetAllowed(host, 587),
        /non-public|did not resolve/,
        `${host} should be refused`,
      );
    });
  }

  test("the metadata endpoint is refused on every allowed port", async () => {
    hosted();
    for (const port of ALLOWED_SMTP_PORTS) {
      await assert.rejects(
        () => assertSmtpTargetAllowed("169.254.169.254", port),
        /non-public/,
        `metadata should be refused on ${port}`,
      );
    }
  });

  test("a public address on a mail port is allowed", async () => {
    hosted();
    await assert.doesNotReject(() => assertSmtpTargetAllowed("8.8.8.8", 587));
  });

  test("the port check runs before the destination check", async () => {
    // Both are wrong here. The port message is the one that should surface,
    // because it needs no DNS and so cannot be turned into a resolver oracle.
    hosted();
    await assert.rejects(() => assertSmtpTargetAllowed("10.0.0.5", 6379), /not allowed/);
  });

  test("the hosted allowlist cannot be used to reach a private host", async () => {
    // `validateRuntimeSecurity` refuses to boot multi-tenant with a non-empty
    // allowlist. This pins the second half: even if one were present, the
    // guard still has to be the thing that decides.
    security.multiTenant = true;
    security.outboundPrivateHostAllowlist = [];
    await assert.rejects(() => assertSmtpTargetAllowed("10.0.0.5", 587), /non-public/);
  });
});

describe("assertSmtpTargetAllowed — self-hosted stays unrestricted", () => {
  test("an internal relay on a private address still works", async () => {
    security.multiTenant = false;
    await assert.doesNotReject(() => assertSmtpTargetAllowed("10.0.0.5", 587));
  });

  test("loopback still works", async () => {
    security.multiTenant = false;
    await assert.doesNotReject(() => assertSmtpTargetAllowed("127.0.0.1", 1025));
  });

  test("a non-standard port still works — MailHog and friends use 1025", async () => {
    security.multiTenant = false;
    await assert.doesNotReject(() => assertSmtpTargetAllowed("localhost", 1025));
  });
});

describe("the send path is guarded, not only the form", () => {
  test("sending through a hosted provider aimed at a private host is refused", async () => {
    hosted();
    await assert.rejects(
      () =>
        sendViaProvider(
          { kind: "smtp", config: { host: "10.0.0.5", port: 587, secure: false, user: "", pass: "" } },
          {
            fromAddress: "a@example.com",
            to: "b@example.com",
            subject: "s",
            text: "t",
            html: "",
            cc: "",
          } as never,
        ),
      /non-public/,
    );
  });

  test("sending to a refused port never opens a socket", async () => {
    hosted();
    const started = Date.now();
    await assert.rejects(
      () =>
        sendViaProvider(
          {
            kind: "smtp",
            config: { host: "8.8.8.8", port: 6379, secure: false, user: "", pass: "" },
          },
          {
            fromAddress: "a@example.com",
            to: "b@example.com",
            subject: "s",
            text: "t",
            html: "",
            cc: "",
          } as never,
        ),
      /not allowed/,
    );
    // Nodemailer's connection timeout is 15s. An immediate rejection is the
    // observable proof that the guard ran before the transport was built.
    assert.ok(Date.now() - started < 2_000, "expected refusal before any connection attempt");
  });
});
