import { describe, expect, it } from "vitest";
import type { RunResults } from "../types/run-results.mirror";
import { runDeterministic } from "./deterministicRunner";

const fullPrd = {
  productName: "Murmur",
  oneLiner: "Voice to board",
  problem: "Ideas die in chat",
  targetUser: "Founders",
  features: {
    must_have: [{ title: "Capture", description: "Record and transcribe" }],
  },
  successMetrics: [{ metric: "activation", target: "40%" }],
  openQuestions: ["Pricing?"],
  nonGoals: ["Mobile v1"],
  risks: ["Mic permissions"],
};

const fullBrand = {
  brandName: "Murmur",
  tagline: "Speak it into being",
  brandValues: ["clarity"],
  colorPalette: { primary: "#111" },
  typography: { heading: "Serif", body: "Sans" },
};

const fullJira = {
  success: true,
  epicsCreated: [{ key: "AUTH-1", title: "Auth" }],
  storiesCreated: [{ key: "AUTH-2", epic: "AUTH-1", title: "Login" }],
};

const fixture = (over: Partial<RunResults> = {}): RunResults => ({
  transcript: "hello",
  prd: fullPrd,
  competitors: { competitors: [{ name: "Linear" }, { name: "Height" }] },
  brand: fullBrand,
  engineering: null,
  jira: fullJira,
  confluence: null,
  ...over,
});

describe("runDeterministic", () => {
  it("returns five results; confluence null is artifact_absent with null score", async () => {
    const results = await runDeterministic(fixture(), "v1", async () => true);

    expect(Object.keys(results).sort()).toEqual([
      "brand",
      "confluence",
      "jira",
      "prd",
      "research",
    ]);

    expect(results.prd.verdict).toBe("scored");
    expect(results.prd.score).toBe(1);
    expect(results.brand.verdict).toBe("scored");
    expect(results.brand.score).toBe(1);
    expect(results.jira.verdict).toBe("scored");
    expect(results.jira.score).toBe(1);

    expect(results.confluence.verdict).toBe("artifact_absent");
    expect(results.confluence.score).toBeNull();

    expect(results.research.verdict).toBe("scored");
    expect(results.research.score).toBe(1);
    const urlGap = results.research.gaps.find((g) => g.element === "citation URLs");
    expect(urlGap?.reason).toBe("expected_field_absent");
    expect(urlGap?.penalizes).toBe(false);
  });

  it("injects checkUrl into research (dead URL penalizes)", async () => {
    const results = await runDeterministic(
      fixture({
        competitors: {
          competitors: [{ name: "Linear", url: "https://example.invalid/gone" }],
        },
      }),
      "v1",
      async () => false,
    );

    expect(results.research.verdict).toBe("scored");
    expect(results.research.gaps.some((g) => g.reason === "unreachable_url" && g.penalizes)).toBe(
      true,
    );
    expect(results.research.score).toBe(0.667);
  });

  it("passes no LlmVerdict (deterministic-only)", async () => {
    const results = await runDeterministic(
      fixture({ prd: { ...fullPrd, productName: undefined } }),
      "v1",
    );
    expect(results.prd.gaps.every((g) => g.reason !== "llm_flag")).toBe(true);
    expect(results.prd.score).toBeLessThan(1);
  });
});
