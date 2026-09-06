// ---------------------------------------------------------------------------
// PRD rubric — scores run_results.prd.
//
// Ticket-language map (ADR-044 clause e; the ticket asks for
// "goals/non-goals/constraints/open-questions"):
//   goals        -> NO dedicated field. Approximated by oneLiner + problem +
//                   feature intent; scored via LLM coherence, NOT a checklist
//                   line. Recorded as unrepresented_in_payload so the absence of
//                   a first-class "goals" field is visible.
//   non-goals    -> nonGoals[]            (real field)
//   constraints  -> NO field. unrepresented_in_payload (never invented).
//   open-questions -> openQuestions[]     (real field)
//
// successMetrics/openQuestions/nonGoals/risks are post-ADR-030 fields: a
// pre-ADR-030 run legitimately lacks them -> expected_field_absent (flag, not
// penalty). competitiveLandscape is NOT scored here — it is the research
// artifact's concern.
// ---------------------------------------------------------------------------

import type { PrdResult } from "../types/run-results.mirror";
import {
  absent,
  combineScore,
  type CoverageItem,
  type Gap,
  type LlmVerdict,
  type RubricResult,
} from "./types";

const hasText = (v: unknown): boolean => typeof v === "string" && v.trim().length > 0;
const nonEmpty = <T,>(v: T[] | undefined | null): v is T[] => Array.isArray(v) && v.length > 0;

const CORE = ["productName", "oneLiner", "problem", "targetUser"] as const;

const ENRICHMENT: { key: keyof PrdResult; label: string }[] = [
  { key: "successMetrics", label: "success metrics" },
  { key: "openQuestions", label: "open questions" },
  { key: "nonGoals", label: "non-goals" },
  { key: "risks", label: "risks" },
];

export function scorePrd(
  prd: PrdResult | null,
  rubricVersion: string,
  llm?: LlmVerdict,
): RubricResult {
  if (prd === null) return absent("prd", rubricVersion);

  const coverage: CoverageItem[] = [];
  const gaps: Gap[] = [];

  for (const key of CORE) {
    const present = hasText((prd as Record<string, unknown>)[key]);
    coverage.push({ element: key, state: present ? "present" : "absent" });
    if (!present) {
      gaps.push({ reason: "missing_required", element: key, penalizes: true });
    }
  }

  const must = prd.features?.must_have;
  if (nonEmpty(must)) {
    const incomplete = must.filter((f) => !hasText(f.title) || !hasText(f.description)).length;
    coverage.push({
      element: "must_have features",
      state: incomplete === 0 ? "present" : "partial",
      detail:
        incomplete > 0 ? `${incomplete} of ${must.length} missing title/description` : undefined,
    });
    if (incomplete > 0) {
      gaps.push({
        reason: "malformed_payload",
        element: "must_have features",
        detail: `${incomplete} feature(s) missing title or description`,
        penalizes: true,
      });
    }
  } else {
    coverage.push({ element: "must_have features", state: "absent" });
    gaps.push({ reason: "missing_required", element: "must_have features", penalizes: true });
  }

  for (const { key, label } of ENRICHMENT) {
    const present = nonEmpty((prd as Record<string, unknown>)[key] as unknown[] | undefined);
    coverage.push({ element: label, state: present ? "present" : "absent" });
    if (!present) {
      gaps.push({ reason: "expected_field_absent", element: label, penalizes: false });
    }
  }

  gaps.push({
    reason: "unrepresented_in_payload",
    element: "goals (no dedicated PRD field; judged via oneLiner/problem coherence)",
    penalizes: false,
  });
  gaps.push({
    reason: "unrepresented_in_payload",
    element: "constraints (no PRD field)",
    penalizes: false,
  });

  if (llm) {
    for (const f of llm.flags) {
      gaps.push({ reason: "llm_flag", element: f.element, detail: f.detail, penalizes: true });
    }
  }

  const penalizingGaps = gaps.filter((g) => g.penalizes);
  const detChecks = CORE.length + 1;
  const detFails = penalizingGaps.filter((g) => g.reason !== "llm_flag").length;
  const detScore = Math.max(0, (detChecks - detFails) / detChecks);

  return {
    artifactType: "prd",
    rubricVersion,
    verdict: "scored",
    score: Number(combineScore(detScore, llm).toFixed(3)),
    coverage,
    gaps,
  };
}
