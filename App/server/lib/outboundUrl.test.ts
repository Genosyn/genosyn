import assert from "node:assert/strict";
import test from "node:test";
import { assertSafeOutboundUrl, isPublicIp } from "./outboundUrl.js";

test("classifies non-public IPv4 and IPv6 ranges", () => {
  for (const address of [
    "0.0.0.0",
    "10.0.0.1",
    "100.64.0.1",
    "127.0.0.1",
    "169.254.169.254",
    "172.16.0.1",
    "192.168.1.1",
    "224.0.0.1",
    "::",
    "::1",
    "fc00::1",
    "fe80::1",
    "ff02::1",
    "2001:db8::1",
  ]) {
    assert.equal(isPublicIp(address), false, address);
  }
  assert.equal(isPublicIp("8.8.8.8"), true);
  assert.equal(isPublicIp("2606:4700:4700::1111"), true);
});

test("rejects loopback URLs and embedded credentials", async () => {
  await assert.rejects(assertSafeOutboundUrl("http://127.0.0.1/admin"), /non-public/);
  await assert.rejects(assertSafeOutboundUrl("http://user:pass@example.com"), /credentials/);
});

test("accepts a literal public address without DNS", async () => {
  const url = await assertSafeOutboundUrl("https://8.8.8.8/example");
  assert.equal(url.hostname, "8.8.8.8");
});
