import { describe, expect, it } from "vitest";
import {
  buildScoreSigningBase,
  hmacSha256Hex,
  signScoreRequest,
  verifyScoreSignature,
} from "./hmac";

const SECRET = "test-secret";

describe("verifyScoreSignature", () => {
  it("accepts a fresh valid signature over v1:score:{run_id}:{ts}", () => {
    const runId = "11111111-1111-1111-1111-111111111111";
    const now = 1_700_000_000;
    const { signatureHeader, timestamp, signingBase } = signScoreRequest(
      runId,
      SECRET,
      now,
    );
    expect(signingBase).toBe(buildScoreSigningBase(runId, now));
    expect(signatureHeader).toBe(`v1=${hmacSha256Hex(signingBase, SECRET)}`);
    expect(
      verifyScoreSignature({
        runId,
        timestamp,
        signatureHeader,
        secret: SECRET,
        nowSeconds: now,
      }),
    ).toBe(true);
  });

  it("rejects replay outside the 300s window", () => {
    const runId = "11111111-1111-1111-1111-111111111111";
    const ts = 1_700_000_000;
    const { signatureHeader } = signScoreRequest(runId, SECRET, ts);
    expect(
      verifyScoreSignature({
        runId,
        timestamp: ts,
        signatureHeader,
        secret: SECRET,
        nowSeconds: ts + 301,
      }),
    ).toBe(false);
  });

  it("rejects a wrong secret or mutated header", () => {
    const runId = "11111111-1111-1111-1111-111111111111";
    const ts = 1_700_000_000;
    const { signatureHeader } = signScoreRequest(runId, SECRET, ts);
    expect(
      verifyScoreSignature({
        runId,
        timestamp: ts,
        signatureHeader,
        secret: "other",
        nowSeconds: ts,
      }),
    ).toBe(false);
    expect(
      verifyScoreSignature({
        runId,
        timestamp: ts,
        signatureHeader: signatureHeader.replace(/.$/, "0"),
        secret: SECRET,
        nowSeconds: ts,
      }),
    ).toBe(false);
  });
});
