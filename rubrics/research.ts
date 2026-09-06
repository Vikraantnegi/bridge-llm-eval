// ---------------------------------------------------------------------------
// Research rubric — scores run_results.competitors (research brief = the
// competitors payload, not a separate artifact).
//
// URL reachability is DETERMINISTIC but injected as checkUrl. Phase 3 owns
// timeout, concurrency cap, and SSRF. Zero URLs is expected_field_absent, not
// a penalty. Dead URLs (when present and checked) penalize via unreachable_url.
// Missing checkUrl is "partial / not-checked" and does not penalize.
// ---------------------------------------------------------------------------

import type { CompetitorsResult } from "../types/run-results.mirror";
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

export type UrlChecker = (url: string) => Promise<boolean>;

export async function scoreResearch(
  competitors: CompetitorsResult | null,
  rubricVersion: string,
  llm?: LlmVerdict,
  checkUrl?: UrlChecker,
): Promise<RubricResult> {
  if (competitors === null) return absent("research", rubricVersion);

  const coverage: CoverageItem[] = [];
  const gaps: Gap[] = [];

  const entries = competitors.competitors ?? [];
  coverage.push({
    element: "competitors",
    state: nonEmpty(entries) ? "present" : "absent",
  });
  if (!nonEmpty(entries)) {
    gaps.push({ reason: "missing_required", element: "competitors", penalizes: true });
  }

  const namelessCount = entries.filter((c) => !hasText(c.name)).length;
  coverage.push({
    element: "competitor names",
    state: entries.length === 0 ? "absent" : namelessCount === 0 ? "present" : "partial",
    detail: namelessCount > 0 ? `${namelessCount} of ${entries.length} missing name` : undefined,
  });
  if (namelessCount > 0) {
    gaps.push({
      reason: "malformed_payload",
      element: "competitor names",
      detail: `${namelessCount} competitor(s) missing name`,
      penalizes: true,
    });
  }

  const withUrl = entries.filter((c) => hasText(c.url));
  let unreachable = 0;
  let urlChecked = false;

  if (withUrl.length === 0) {
    coverage.push({
      element: "citation URLs reachable",
      state: "absent",
      detail: "no competitor carried a URL",
    });
    gaps.push({
      reason: "expected_field_absent",
      element: "citation URLs",
      detail: "no competitor entries carried a URL (thin brief, not malformed)",
      penalizes: false,
    });
  } else if (!checkUrl) {
    coverage.push({
      element: "citation URLs reachable",
      state: "partial",
      detail: "no URL checker provided (not verified this run)",
    });
  } else {
    urlChecked = true;
    const results = await Promise.all(
      withUrl.map(async (c) => {
        try {
          return await checkUrl(c.url as string);
        } catch {
          return false;
        }
      }),
    );
    unreachable = results.filter((ok) => !ok).length;
    coverage.push({
      element: "citation URLs reachable",
      state: unreachable === 0 ? "present" : "partial",
      detail: unreachable > 0 ? `${unreachable} of ${withUrl.length} unreachable` : undefined,
    });
    if (unreachable > 0) {
      gaps.push({
        reason: "unreachable_url",
        element: "citation URLs",
        detail: `${unreachable} of ${withUrl.length} URL(s) failed HEAD/GET (invented or dead)`,
        penalizes: true,
      });
    }
  }

  if (llm) {
    for (const f of llm.flags) {
      gaps.push({ reason: "llm_flag", element: f.element, detail: f.detail, penalizes: true });
    }
  }

  const checks: boolean[] = [!nonEmpty(entries), namelessCount > 0];
  if (urlChecked) checks.push(unreachable > 0);
  const detScore = Math.max(0, (checks.length - checks.filter(Boolean).length) / checks.length);

  return {
    artifactType: "research",
    rubricVersion,
    verdict: "scored",
    score: Number(combineScore(detScore, llm).toFixed(3)),
    coverage,
    gaps,
  };
}
