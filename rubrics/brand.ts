// ---------------------------------------------------------------------------
// Brand rubric — scores run_results.brand.
//
// Deterministic: colorPalette present with at least a primary; typography
// present; brandValues non-empty; tagline + brandName present.
// LLM: palette/typography/voice internally consistent; values coherent with the
// PRD's target user (the scorer passes the PRD slice into the LLM call).
//
// nameNotes exists on BrandResult but is deliberately OFF the checklist (no
// scoring reason to require it — it's writer scratch, not a deliverable field).
// ---------------------------------------------------------------------------

import type { BrandResult } from "../types/run-results.mirror";
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

export function scoreBrand(
  brand: BrandResult | null,
  rubricVersion: string,
  llm?: LlmVerdict,
): RubricResult {
  if (brand === null) return absent("brand", rubricVersion);

  const coverage: CoverageItem[] = [];
  const gaps: Gap[] = [];

  for (const key of ["brandName", "tagline"] as const) {
    const present = hasText(brand[key]);
    coverage.push({ element: key, state: present ? "present" : "absent" });
    if (!present) gaps.push({ reason: "missing_required", element: key, penalizes: true });
  }

  const paletteOk = !!brand.colorPalette && hasText(brand.colorPalette.primary);
  coverage.push({
    element: "colorPalette (>= primary)",
    state: paletteOk ? "present" : brand.colorPalette ? "partial" : "absent",
  });
  if (!paletteOk) {
    gaps.push({
      reason: "missing_required",
      element: "colorPalette primary",
      detail: brand.colorPalette ? "palette present but no primary color" : "no palette",
      penalizes: true,
    });
  }

  const typo = brand.typography;
  const typoOk = !!typo && (hasText(typo.heading) || hasText(typo.body) || hasText(typo.mono));
  coverage.push({ element: "typography", state: typoOk ? "present" : "absent" });
  if (!typoOk) {
    gaps.push({ reason: "missing_required", element: "typography", penalizes: true });
  }

  const valuesOk = nonEmpty(brand.brandValues);
  coverage.push({ element: "brandValues", state: valuesOk ? "present" : "absent" });
  if (!valuesOk) {
    gaps.push({ reason: "missing_required", element: "brandValues", penalizes: true });
  }

  if (llm) {
    for (const f of llm.flags) {
      gaps.push({ reason: "llm_flag", element: f.element, detail: f.detail, penalizes: true });
    }
  }

  const detChecks = 5;
  const detFails = [
    !hasText(brand.brandName),
    !hasText(brand.tagline),
    !paletteOk,
    !typoOk,
    !valuesOk,
  ].filter(Boolean).length;
  const detScore = Math.max(0, (detChecks - detFails) / detChecks);

  return {
    artifactType: "brand",
    rubricVersion,
    verdict: "scored",
    score: Number(combineScore(detScore, llm).toFixed(3)),
    coverage,
    gaps,
  };
}
