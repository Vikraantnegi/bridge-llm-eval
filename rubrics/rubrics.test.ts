import { describe, expect, it } from "vitest";
import { combineScore } from "./types";
import { scorePrd } from "./prd";
import { scoreJira } from "./jira";
import { scoreResearch } from "./research";

const PERFECT: { qualitativeScore: number; flags: never[] } = {
  qualitativeScore: 1,
  flags: [],
};

describe("combineScore", () => {
  it("does not let the LLM raise score above detScore", () => {
    expect(combineScore(0, PERFECT)).toBe(0);
    expect(combineScore(1, { qualitativeScore: 1.2, flags: [] })).toBe(1);
    expect(combineScore(1, { qualitativeScore: 0, flags: [] })).toBe(0.5);
    expect(combineScore(0.8)).toBe(0.8);
  });
});

describe("scorePrd", () => {
  it("empty PRD + perfect judge stays 0 (LLM cannot rescue)", () => {
    const result = scorePrd({}, "v1", PERFECT);
    expect(result.verdict).toBe("scored");
    expect(result.score).toBe(0);
  });

  it("null column is artifact_absent with null score, not 0", () => {
    const result = scorePrd(null, "v1", PERFECT);
    expect(result.verdict).toBe("artifact_absent");
    expect(result.score).toBeNull();
  });
});

describe("scoreJira", () => {
  it("treats a title-matched story as an orphan (join is on epic key)", () => {
    const result = scoreJira(
      {
        success: true,
        epicsCreated: [{ key: "AUTH-1", title: "Auth" }],
        storiesCreated: [
          { key: "AUTH-2", epic: "Auth", title: "Login" },
        ],
      },
      "v1",
    );
    expect(result.verdict).toBe("scored");
    expect(result.gaps.some((g) => g.reason === "malformed_payload" && g.element === "orphan stories")).toBe(
      true,
    );
    expect(result.score).toBe(0.75);
  });

  it("does not orphan a story whose epic equals an epicsCreated key", () => {
    const result = scoreJira(
      {
        success: true,
        epicsCreated: [{ key: "AUTH-1", title: "Auth" }],
        storiesCreated: [
          { key: "AUTH-2", epic: "AUTH-1", title: "Login" },
        ],
      },
      "v1",
    );
    expect(result.gaps.some((g) => g.element === "orphan stories")).toBe(false);
    expect(result.score).toBe(1);
  });
});

describe("scoreResearch", () => {
  it("no URLs → full marks (expected_field_absent, not a penalty)", async () => {
    const result = await scoreResearch(
      { competitors: [{ name: "Linear" }, { name: "Height" }] },
      "v1",
    );
    expect(result.score).toBe(1);
    const urlGap = result.gaps.find((g) => g.element === "citation URLs");
    expect(urlGap?.reason).toBe("expected_field_absent");
    expect(urlGap?.penalizes).toBe(false);
  });

  it("dead URL is penalized when a checker is provided", async () => {
    const result = await scoreResearch(
      { competitors: [{ name: "Linear", url: "https://example.invalid/gone" }] },
      "v1",
      undefined,
      async () => false,
    );
    expect(result.gaps.some((g) => g.reason === "unreachable_url" && g.penalizes)).toBe(true);
    expect(result.score).toBe(0.667);
  });
});
