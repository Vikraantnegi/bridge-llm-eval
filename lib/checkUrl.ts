// ---------------------------------------------------------------------------
// checkUrl — SSRF-guarded reachability check for research citation URLs.
//
// The research rubric's UrlChecker: (url: string) => Promise<boolean>. It must
// answer "is this citation real and openable" WITHOUT becoming a server-side
// request forgery hole. The URLs are MODEL-SUPPLIED (competitor.url from the
// competitor agent), so they are untrusted input pointed at by our server.
//
// Threat: a malicious/hallucinated URL like http://169.254.169.254/ (cloud
// metadata), http://localhost:5432 (the DB), or a hostname that RESOLVES to an
// internal IP could make the scorer fetch internal resources. Guard:
//   1. scheme allowlist (http/https only)
//   2. resolve the hostname to IPs FIRST, reject any private/loopback/
//      link-local/reserved/ULA range (checks the resolved address, not the
//      hostname string — catches evil.com -> 10.0.0.1)
//   3. no automatic redirect following (a public URL 302-ing to an internal
//      host is a classic bypass); a 3xx counts as "reachable" and stops there
//   4. hard per-URL timeout (AbortController)
//   5. HEAD first, fall back to GET (some hosts 405 HEAD)
//
// Reachable = final status < 400 (2xx/3xx). Anything else, any thrown error,
// any blocked address, any timeout -> false (the rubric flags unreachable_url).
// Fail-closed: if we cannot PROVE the URL is safe and reachable, it is not.
// ---------------------------------------------------------------------------

import { lookup } from "node:dns/promises";
import net from "node:net";
import type { UrlChecker } from "../rubrics/research";

export type CheckUrlOptions = {
  timeoutMs?: number;   // per-URL hard timeout (default 5000)
  concurrency?: number; // max simultaneous checks (default 4)
};

// --- private / non-routable range detection ---------------------------------
// Checks a RESOLVED ip literal (v4 or v6). Returns true if it must be blocked.
function isBlockedAddress(ip: string): boolean {
  const kind = net.isIP(ip); // 0 not-ip, 4, or 6
  if (kind === 4) return isBlockedV4(ip);
  if (kind === 6) return isBlockedV6(ip);
  return true; // not a valid IP literal -> block (cannot reason about it)
}

function isBlockedV4(ip: string): boolean {
  const parts = ip.split(".").map((n) => Number(n));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return true;
  }
  const [a, b] = parts;
  if (a === 0) return true;                        // 0.0.0.0/8 "this network"
  if (a === 10) return true;                       // 10.0.0.0/8 private
  if (a === 127) return true;                      // 127.0.0.0/8 loopback
  if (a === 169 && b === 254) return true;         // 169.254.0.0/16 link-local (cloud metadata)
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 private
  if (a === 192 && b === 168) return true;         // 192.168.0.0/16 private
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  if (a === 192 && b === 0) return true;           // 192.0.0.0/24 & 192.0.2.0/24 special-use
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 benchmarking
  if (a >= 224) return true;                       // 224.0.0.0/4 multicast + 240/4 reserved
  return false;
}

function isBlockedV6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === "::1" || lower === "::") return true;         // loopback / unspecified
  if (lower.startsWith("fe80")) return true;                  // link-local
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // ULA fc00::/7
  if (lower.startsWith("ff")) return true;                    // multicast
  // IPv4-mapped (::ffff:a.b.c.d) — extract and check the v4 part.
  const mapped = lower.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isBlockedV4(mapped[1]);
  return false;
}

// Resolve every address a hostname maps to; block if ANY is internal. Blocking
// on any (not all) resolved address closes the DNS-rebinding-ish gap where a
// name returns one public and one private A record.
async function hostResolvesToBlocked(hostname: string): Promise<boolean> {
  // A bare IP literal in the URL: check it directly, no DNS.
  if (net.isIP(hostname) !== 0) return isBlockedAddress(hostname);
  try {
    const results = await lookup(hostname, { all: true });
    if (results.length === 0) return true; // no resolution -> cannot prove safe
    return results.some((r) => isBlockedAddress(r.address));
  } catch {
    return true; // resolution failed -> block (fail closed)
  }
}

async function checkOne(rawUrl: string, timeoutMs: number): Promise<boolean> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false; // unparseable
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;

  // Resolve + range-check BEFORE any network fetch.
  if (await hostResolvesToBlocked(url.hostname)) return false;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // redirect:"manual" — do NOT auto-follow. A 3xx is "reachable" and we stop
    // rather than chase a Location that could point at an internal host.
    const common = {
      signal: controller.signal,
      redirect: "manual" as const,
      // No credentials, minimal headers.
      headers: { "user-agent": "bridge-llm-eval-linkcheck/1.0" },
    };
    let res: Response;
    try {
      res = await fetch(url, { method: "HEAD", ...common });
    } catch {
      // Some hosts reject/hang on HEAD; try GET once.
      res = await fetch(url, { method: "GET", ...common });
    }
    // reachable = final status < 400. 3xx counts (we don't follow, but a
    // redirect means the endpoint exists and responded).
    return res.status < 400;
  } catch {
    return false; // timeout/abort/network error -> unreachable
  } finally {
    clearTimeout(timer);
  }
}

// Factory: returns a UrlChecker closure with a shared concurrency limiter, so a
// research payload with many URLs cannot open unbounded sockets. The research
// rubric calls the returned function once per URL; the limiter serializes to
// `concurrency` in flight.
export function makeCheckUrl(opts: CheckUrlOptions = {}): UrlChecker {
  const timeoutMs = opts.timeoutMs ?? 5000;
  const concurrency = Math.max(1, opts.concurrency ?? 4);

  let active = 0;
  const queue: (() => void)[] = [];
  const acquire = (): Promise<void> =>
    new Promise((resolve) => {
      if (active < concurrency) {
        active += 1;
        resolve();
      } else {
        queue.push(() => {
          active += 1;
          resolve();
        });
      }
    });
  const release = () => {
    active -= 1;
    const next = queue.shift();
    if (next) next();
  };

  return async (rawUrl: string): Promise<boolean> => {
    await acquire();
    try {
      return await checkOne(rawUrl, timeoutMs);
    } finally {
      release();
    }
  };
}
