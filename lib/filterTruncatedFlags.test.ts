import { describe, it, expect } from "vitest";
import { filterTruncatedFlags } from "./filterTruncatedFlags";
import type { LlmVerdict } from "../rubrics/types";

const verdict = (flags: LlmVerdict["flags"]): LlmVerdict => ({
  qualitativeScore: 0.8,
  flags,
});

describe("filterTruncatedFlags", () => {
  it("returns null unchanged", () => {
    expect(filterTruncatedFlags(null, true)).toBeNull();
    expect(filterTruncatedFlags(null, false)).toBeNull();
  });

  it("keeps ALL flags when not truncated (quality + completeness)", () => {
    const v = verdict([
      { element: "coherence", detail: "features contradict problem" },
      { element: "completeness", detail: "missing several features" },
    ]);
    const out = filterTruncatedFlags(v, false);
    expect(out?.flags).toHaveLength(2);
    expect(out).toBe(v);
  });

  it("drops completeness flags but keeps quality flags when truncated", () => {
    const v = verdict([
      { element: "coherence", detail: "features contradict the stated problem" },
      { element: "completeness", detail: "missing several features" },
      { element: "brand voice", detail: "off-tone vs target user" },
      { element: "only 3 of 10 competitors shown" },
    ]);
    const out = filterTruncatedFlags(v, true);
    expect(out?.flags.map((f) => f.element)).toEqual(["coherence", "brand voice"]);
  });

  it("matches a range of completeness phrasings", () => {
    const phrasings = [
      "missing fields",
      "the list is incomplete",
      "payload appears truncated",
      "content was cut off",
      "not enough detail provided",
      "too few stories",
      "fewer than expected epics",
      "only 2 of 8 entries",
      "lacks acceptance criteria",
      "several items omitted",
      "this section is absent",
      "should include more competitors",
      "expected additional detail",
    ];
    for (const p of phrasings) {
      const out = filterTruncatedFlags(verdict([{ element: p }]), true);
      expect(out?.flags, `should drop: "${p}"`).toHaveLength(0);
    }
  });

  it("does NOT drop genuine quality flags that happen to mention artifacts", () => {
    const keep = [
      "brand voice is inconsistent",
      "titles do not relate to the PRD",
      "positioning contradicts the market summary",
      "tone is off for the target user",
    ];
    for (const k of keep) {
      const out = filterTruncatedFlags(verdict([{ element: k }]), true);
      expect(out?.flags, `should keep: "${k}"`).toHaveLength(1);
    }
  });

  it("preserves qualitativeScore untouched", () => {
    const v = verdict([{ element: "missing stuff" }]);
    expect(filterTruncatedFlags(v, true)?.qualitativeScore).toBe(0.8);
  });
});
