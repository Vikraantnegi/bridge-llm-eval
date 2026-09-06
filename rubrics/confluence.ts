// ---------------------------------------------------------------------------
// Confluence rubric — scores run_results.confluence when non-null.
//
// Coverage is by KIND via regex on pagesCreated[].title, NOT a frozen
// "01 - PRD" title list. Mirrors Listener's KIND_RULES
// (lib/ideas/confluence-pages.ts). Numbering is incidental.
//
// Hierarchy is unrepresented_in_payload: ConfluenceResult is a flat
// {title,id}[] with no parent graph. Scoring hierarchy would need a tenant
// crawl (out of scope, ADR-044 clause b).
//
// confluence: null -> artifact_absent. success === false is SCORED, not absent.
// ---------------------------------------------------------------------------

import type { ConfluenceResult } from "../types/run-results.mirror";
import {
  absent,
  combineScore,
  type CoverageItem,
  type Gap,
  type LlmVerdict,
  type RubricResult,
} from "./types";

const nonEmpty = <T,>(v: T[] | undefined | null): v is T[] => Array.isArray(v) && v.length > 0;
const hasText = (v: unknown): boolean => typeof v === "string" && v.trim().length > 0;

const KIND_RULES: { kind: string; match: RegExp; required: boolean }[] = [
  { kind: "PRD", match: /\bprd\b|product\s*requirements|^product\b/i, required: true },
  { kind: "Brand", match: /\bbrand\b|identity/i, required: true },
  { kind: "Engineering", match: /\bengineering\b|brief\b/i, required: true },
  { kind: "Competitors", match: /\bcompetitor/i, required: true },
  { kind: "Roadmap", match: /\broadmap\b|phased\s+delivery/i, required: true },
  { kind: "Overview", match: /\boverview\b|home\b/i, required: false },
  { kind: "Notes", match: /\bresearch\b|notes\b/i, required: false },
];

export function scoreConfluence(
  confluence: ConfluenceResult | null,
  rubricVersion: string,
  llm?: LlmVerdict,
): RubricResult {
  if (confluence === null) return absent("confluence", rubricVersion);

  const coverage: CoverageItem[] = [];
  const gaps: Gap[] = [];

  const succeeded = confluence.success === true;
  coverage.push({
    element: "success flag",
    state: "present",
    detail: succeeded ? undefined : "success is not true",
  });
  if (!succeeded) {
    gaps.push({
      reason: "missing_required",
      element: "success flag",
      detail: "confluence.success is not true on a non-null payload",
      penalizes: true,
    });
  }

  coverage.push({
    element: "spaceKey",
    state: hasText(confluence.spaceKey) ? "present" : "absent",
  });
  if (!hasText(confluence.spaceKey)) {
    gaps.push({ reason: "missing_required", element: "spaceKey", penalizes: true });
  }

  const pages = confluence.pagesCreated ?? [];
  coverage.push({
    element: "pagesCreated",
    state: nonEmpty(pages) ? "present" : "absent",
  });
  if (!nonEmpty(pages)) {
    gaps.push({ reason: "missing_required", element: "pagesCreated", penalizes: true });
  }

  const titles = pages.map((p) => p.title ?? "");
  const requiredKinds = KIND_RULES.filter((k) => k.required);
  let requiredHit = 0;
  for (const rule of KIND_RULES) {
    const present = titles.some((t) => rule.match.test(t));
    coverage.push({ element: `${rule.kind} page`, state: present ? "present" : "absent" });
    if (rule.required) {
      if (present) requiredHit += 1;
      else {
        gaps.push({
          reason: "missing_required",
          element: `${rule.kind} page`,
          detail: "no pagesCreated title matched this kind",
          penalizes: true,
        });
      }
    }
  }

  gaps.push({
    reason: "unrepresented_in_payload",
    element: "page hierarchy mirrors PRD (needs tenant crawl; out of scope)",
    penalizes: false,
  });

  if (llm) {
    for (const f of llm.flags) {
      gaps.push({ reason: "llm_flag", element: f.element, detail: f.detail, penalizes: true });
    }
  }

  const baseChecks = 3;
  const baseFails = [!succeeded, !hasText(confluence.spaceKey), !nonEmpty(pages)].filter(
    Boolean,
  ).length;
  const baseScore = (baseChecks - baseFails) / baseChecks;
  const kindScore = requiredKinds.length > 0 ? requiredHit / requiredKinds.length : 1;
  const detScore = Math.max(0, 0.5 * baseScore + 0.5 * kindScore);

  return {
    artifactType: "confluence",
    rubricVersion,
    verdict: "scored",
    score: Number(combineScore(detScore, llm).toFixed(3)),
    coverage,
    gaps,
  };
}
