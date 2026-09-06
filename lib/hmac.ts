import { createHmac, timingSafeEqual } from "node:crypto";

const SCHEME = "v1";

export const unixTimestamp = (): number => Math.floor(Date.now() / 1000);

/** Signing base for POST /score: v1:score:{run_id}:{ts} */
export const buildScoreSigningBase = (
  runId: string,
  timestamp: number | string,
): string => `${SCHEME}:score:${runId}:${timestamp}`;

export const hmacSha256Hex = (signingBase: string, secret: string): string =>
  createHmac("sha256", secret).update(signingBase, "utf8").digest("hex");

export const signScoreRequest = (
  runId: string,
  secret: string,
  timestamp: number = unixTimestamp(),
): { timestamp: number; signatureHeader: string; signingBase: string } => {
  const signingBase = buildScoreSigningBase(runId, timestamp);
  const hex = hmacSha256Hex(signingBase, secret);
  return {
    timestamp,
    signingBase,
    signatureHeader: `${SCHEME}=${hex}`,
  };
};

/**
 * Verify inbound score HMAC. Constant-time compare + 300s replay window
 * (mirrors Listener broker verify; different signing base).
 */
export const verifyScoreSignature = (params: {
  runId: string;
  timestamp: number | string;
  signatureHeader: string;
  secret: string;
  windowSeconds?: number;
  nowSeconds?: number;
}): boolean => {
  const { runId, timestamp, signatureHeader, secret } = params;
  const windowSeconds = params.windowSeconds ?? 300;
  const now = params.nowSeconds ?? unixTimestamp();

  if (!secret) return false;

  const ts = typeof timestamp === "string" ? parseInt(timestamp, 10) : timestamp;
  if (!Number.isFinite(ts)) return false;
  if (Math.abs(now - ts) > windowSeconds) return false;

  const expected = `${SCHEME}=${hmacSha256Hex(buildScoreSigningBase(runId, ts), secret)}`;
  const a = Buffer.from(signatureHeader);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
};
