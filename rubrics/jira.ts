// ---------------------------------------------------------------------------
// Jira rubric — scores run_results.jira.
//
// Orphan rule (LOCKED): storiesCreated[].epic holds the epic KEY. A story is an
// orphan iff `epic` is missing OR equals no epicsCreated[].key.
// This matches Listener's production join (stories.filter(s => s.epic ===
// epic.key)). A title match is a malformed payload, NOT a second join strategy.
// The judge scores the CLAIMED-WRITE payload (JiraResult), never a board crawl
// (ADR-044 clause b).
//
// success === false on a non-null jira column is SCORED, not artifact_absent.
// Absent = the whole jira column is null.
//
// Fewer epics than PRD features is the known 64K Breakdown-ceiling consequence
// on large ideas -> expected_under_ceiling, not a score penalty (ADR-044 d).
// ---------------------------------------------------------------------------

import type { JiraResult } from "../types/run-results.mirror";
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

export function scoreJira(
  jira: JiraResult | null,
  rubricVersion: string,
  llm?: LlmVerdict,
): RubricResult {
  if (jira === null) return absent("jira", rubricVersion);

  const coverage: CoverageItem[] = [];
  const gaps: Gap[] = [];

  const succeeded = jira.success === true;
  coverage.push({
    element: "success flag",
    state: "present",
    detail: succeeded ? undefined : "success is not true",
  });
  if (!succeeded) {
    gaps.push({
      reason: "missing_required",
      element: "success flag",
      detail: "jira.success is not true on a non-null payload",
      penalizes: true,
    });
  }

  const epics = jira.epicsCreated ?? [];
  const stories = jira.storiesCreated ?? [];

  coverage.push({
    element: "epicsCreated",
    state: nonEmpty(epics) ? "present" : "absent",
  });
  if (!nonEmpty(epics)) {
    gaps.push({ reason: "missing_required", element: "epicsCreated", penalizes: true });
  }

  coverage.push({
    element: "storiesCreated",
    state: nonEmpty(stories) ? "present" : "absent",
  });
  if (!nonEmpty(stories)) {
    gaps.push({ reason: "missing_required", element: "storiesCreated", penalizes: true });
  }

  const epicKeys = new Set(epics.map((e) => e.key).filter(hasText));
  const orphans = stories.filter((s) => !hasText(s.epic) || !epicKeys.has(s.epic as string));
  coverage.push({
    element: "story->epic integrity",
    state: orphans.length === 0 ? "present" : "partial",
    detail: orphans.length > 0 ? `${orphans.length} of ${stories.length} stories orphaned` : undefined,
  });
  if (orphans.length > 0) {
    gaps.push({
      reason: "malformed_payload",
      element: "orphan stories",
      detail: `${orphans.length} story(ies) reference an epic key not in epicsCreated`,
      penalizes: true,
    });
  }

  const keylessEpics = epics.filter((e) => !hasText(e.key)).length;
  if (keylessEpics > 0) {
    gaps.push({
      reason: "malformed_payload",
      element: "epics without key",
      detail: `${keylessEpics} epic(s) missing key`,
      penalizes: true,
    });
  }

  if (llm) {
    for (const f of llm.flags) {
      const isCeiling = /ceiling/i.test(f.element) || /ceiling/i.test(f.detail ?? "");
      gaps.push(
        isCeiling
          ? {
              reason: "expected_under_ceiling",
              element: f.element,
              detail: f.detail,
              penalizes: false,
            }
          : { reason: "llm_flag", element: f.element, detail: f.detail, penalizes: true },
      );
    }
  }

  const detChecks = 4;
  const detFails = [
    !succeeded,
    !nonEmpty(epics),
    !nonEmpty(stories),
    orphans.length > 0 || keylessEpics > 0,
  ].filter(Boolean).length;
  const detScore = Math.max(0, (detChecks - detFails) / detChecks);

  return {
    artifactType: "jira",
    rubricVersion,
    verdict: "scored",
    score: Number(combineScore(detScore, llm).toFixed(3)),
    coverage,
    gaps,
  };
}
