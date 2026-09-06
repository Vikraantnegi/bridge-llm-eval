import { afterEach, describe, expect, it, vi } from "vitest";
import type { PackedJudgeInput } from "./packJudgeInput";
import { PRICE_IN_PER_M, PRICE_OUT_PER_M } from "./config";
import { runJudge } from "./runJudge";

const emptyPacked = (): PackedJudgeInput => ({
  artifacts: {
    prd: { present: false, wasTruncated: false, value: null },
    brand: { present: false, wasTruncated: false, value: null },
    research: { present: false, wasTruncated: false, value: null },
    jira: { present: false, wasTruncated: false, value: null },
    confluence: { present: false, wasTruncated: false, value: null },
  },
  totalChars: 0,
  overHardStop: false,
});

const withPrd = (over: Partial<PackedJudgeInput> = {}): PackedJudgeInput => {
  const base = emptyPacked();
  base.artifacts.prd = {
    present: true,
    wasTruncated: false,
    value: { productName: "Murmur", oneLiner: "x", problem: "y", targetUser: "z" },
  };
  base.totalChars = 100;
  return { ...base, ...over, artifacts: { ...base.artifacts, ...(over.artifacts ?? {}) } };
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("runJudge", () => {
  it("no_artifacts → no fetch, zero spend", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const out = await runJudge(emptyPacked(), "key");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(out).toEqual({
      ok: false,
      reason: "no_artifacts",
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
    });
  });

  it("overHardStop → no fetch, zero spend", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const out = await runJudge(
      withPrd({ overHardStop: true, totalChars: 50_000 }),
      "key",
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe("over_hard_stop");
    expect(out.costUsd).toBe(0);
  });

  it("valid JSON → per-artifact verdicts; absent stay null; score clamped", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          stop_reason: "end_turn",
          usage: { input_tokens: 5000, output_tokens: 400 },
          content: [
            {
              type: "text",
              text: JSON.stringify({
                prd: { qualitativeScore: 1.5, flags: [{ element: "voice", detail: "off" }] },
              }),
            },
          ],
        }),
      })),
    );

    const packed = withPrd();
    packed.artifacts.brand = { present: false, wasTruncated: false, value: null };

    const out = await runJudge(packed, "key");
    expect(out.ok).toBe(true);
    if (!out.ok) return;

    expect(out.perArtifact.prd.verdict?.qualitativeScore).toBe(1);
    expect(out.perArtifact.prd.verdict?.flags).toEqual([
      { element: "voice", detail: "off" },
    ]);
    expect(out.perArtifact.brand.verdict).toBeNull();
    expect(out.inputTokens).toBe(5000);
    expect(out.outputTokens).toBe(400);
    expect(out.costUsd).toBeCloseTo(
      (5000 / 1e6) * PRICE_IN_PER_M + (400 / 1e6) * PRICE_OUT_PER_M,
    );
  });

  it("stop_reason max_tokens → judge_error, no salvage, cost still counted", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          stop_reason: "max_tokens",
          usage: { input_tokens: 10000, output_tokens: 2048 },
          content: [{ type: "text", text: '{"prd":{"qualitativeScore":1' }],
        }),
      })),
    );

    const out = await runJudge(withPrd(), "key");
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toBe("max_tokens");
    expect(out.inputTokens).toBe(10000);
    expect(out.outputTokens).toBe(2048);
    expect(out.costUsd).toBeGreaterThan(0);
  });
});
