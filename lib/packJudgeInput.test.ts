import { describe, expect, it } from "vitest";
import type { RunResults } from "../types/run-results.mirror";
import {
  PACK_CAPS,
  PACKED_HARD_STOP,
  packJudgeInput,
} from "./packJudgeInput";

const big = (n: number, ch = "x"): string => ch.repeat(n);

describe("packJudgeInput", () => {
  it("PRD trim: competitiveLandscape/could/wont before must_have rationale", () => {
    const prd = {
      productName: "Murmur",
      oneLiner: "Voice to board",
      problem: "Ideas die in chat",
      targetUser: "Founders",
      features: {
        must_have: [
          {
            title: "Capture",
            description: "Record",
            rationale: "GROUNDED_IN_TRANSCRIPT_" + big(500),
          },
        ],
        should_have: [{ title: "S", description: big(2000) }],
        could_have: [{ title: "C", description: big(3000) }],
        wont_have: [{ title: "W", description: big(3000) }],
      },
      competitiveLandscape: Array.from({ length: 40 }, (_, i) => ({
        competitor: `Comp${i}`,
        positioningDelta: big(200),
      })),
      openQuestions: [big(2000)],
      nonGoals: [big(2000)],
      risks: [big(2000)],
      successMetrics: [{ metric: big(500), target: big(500) }],
    };

    const rawSize = JSON.stringify(prd).length;
    expect(rawSize).toBeGreaterThan(PACK_CAPS.prd);

    const packed = packJudgeInput({
      transcript: null,
      prd,
      brand: null,
      competitors: null,
      engineering: null,
      jira: null,
      confluence: null,
    });

    expect(packed.artifacts.prd.present).toBe(true);
    expect(packed.artifacts.prd.wasTruncated).toBe(true);
    const v = packed.artifacts.prd.value as Record<string, unknown>;
    expect(v._truncated).toBe(true);
    expect(v.competitiveLandscape).toBeUndefined();
    const features = v.features as {
      could_have?: unknown;
      wont_have?: unknown;
      must_have?: { rationale?: string }[];
    };
    expect(features.could_have).toBeUndefined();
    expect(features.wont_have).toBeUndefined();
    expect(features.must_have?.[0]?.rationale).toContain("GROUNDED_IN_TRANSCRIPT_");
  });

  it("competitors: 200 entries → ≤8 kept + _truncatedCompetitorCount", () => {
    const competitors = {
      competitors: Array.from({ length: 200 }, (_, i) => ({
        name: `C${i}`,
        url: `https://example.com/${i}`,
        positioning: big(50),
        keyFeatures: [big(100)],
        strengths: [big(100)],
        weaknesses: [big(100)],
      })),
    };
    const packed = packJudgeInput({
      transcript: null,
      prd: null,
      brand: null,
      competitors,
      engineering: null,
      jira: null,
      confluence: null,
    });

    expect(packed.artifacts.research.wasTruncated).toBe(true);
    const v = packed.artifacts.research.value as {
      competitors: unknown[];
      _truncatedCompetitorCount?: number;
    };
    expect(v.competitors.length).toBeLessThanOrEqual(8);
    expect(v._truncatedCompetitorCount).toBe(200 - v.competitors.length);
  });

  it("absent slices are present:false and contribute null size", () => {
    const packed = packJudgeInput({
      transcript: "ignored",
      prd: null,
      brand: null,
      competitors: null,
      engineering: null,
      jira: null,
      confluence: null,
    } as RunResults);

    for (const k of ["prd", "brand", "research", "jira", "confluence"] as const) {
      expect(packed.artifacts[k].present).toBe(false);
      expect(packed.artifacts[k].value).toBeNull();
      expect(packed.artifacts[k].wasTruncated).toBe(false);
    }
    expect(packed.totalChars).toBe(JSON.stringify(null).length * 5);
    expect(packed.overHardStop).toBe(false);
  });

  it("overHardStop when trimmed payload still exceeds PACKED_HARD_STOP", () => {
    // Trim steps never delete must_have title/description — a huge description
    // survives packing and trips the hard stop (no Anthropic call).
    const packed = packJudgeInput({
      transcript: null,
      prd: {
        productName: "P",
        oneLiner: "L",
        problem: "R",
        targetUser: "U",
        features: {
          must_have: [{ title: "T", description: big(PACKED_HARD_STOP + 1000) }],
        },
      },
      brand: null,
      competitors: null,
      engineering: null,
      jira: null,
      confluence: null,
    });

    expect(packed.artifacts.prd.wasTruncated).toBe(true);
    expect(packed.totalChars).toBeGreaterThan(PACKED_HARD_STOP);
    expect(packed.overHardStop).toBe(true);
  });
});
