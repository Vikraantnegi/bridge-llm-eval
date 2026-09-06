import { describe, expect, it } from "vitest";
import { makeCheckUrl } from "./checkUrl";

/**
 * Offline SSRF cases: IP-literal hosts skip DNS and hit isBlockedAddress
 * before any fetch. A blocked address returns false without network I/O.
 */
describe("makeCheckUrl SSRF guard (offline)", () => {
  const check = makeCheckUrl({ timeoutMs: 500, concurrency: 2 });

  it.each([
    ["http://127.0.0.1/", "loopback v4"],
    ["http://10.0.0.1/", "RFC1918 10/8"],
    ["http://172.16.5.1/", "RFC1918 172.16/12"],
    ["http://192.168.1.1/", "RFC1918 192.168/16"],
    ["http://169.254.169.254/", "link-local / cloud metadata"],
    ["http://0.0.0.0/", "this-network"],
    ["http://100.64.0.1/", "CGNAT"],
    ["http://[::1]/", "loopback v6"],
    ["ftp://example.com/", "bad scheme"],
    ["not-a-url", "unparseable"],
  ])("blocks %s (%s)", async (url) => {
    expect(await check(url)).toBe(false);
  });
});
