// ---------------------------------------------------------------------------
// deterministicRunner — 3b. Runs the five Phase-2 rubrics DETERMINISTIC-ONLY.
//
// Called on the `proceed` path AFTER the attempt row is inserted and BEFORE the
// Sonnet call (3c). It passes NO LlmVerdict to any rubric, so each returns its
// deterministic coverage/gaps and a deterministic-only score (the rubric's
// score === detScore when llm is undefined — see the Phase-2 formula).
//
// 3b does NOT: call Anthropic, merge an LLM verdict, write run_quality_scores,
// or transition the attempt row. It produces the deterministic half; 3c adds
// the LLM verdict, 3d persists.
//
// Research is async (URL reachability); the other four are sync. The runner is
// async throughout and awaits all five uniformly — no special-casing. Research
// receives the SSRF-guarded checkUrl; if none is supplied the rubric records
// URL coverage as not-checked (non-penalizing), per Phase 2.
// ---------------------------------------------------------------------------

import type { RunResults } from "../types/run-results.mirror";
import type { RubricResult } from "../rubrics/types";
import type { UrlChecker } from "../rubrics/research";
import { scorePrd } from "../rubrics/prd";
import { scoreBrand } from "../rubrics/brand";
import { scoreJira } from "../rubrics/jira";
import { scoreConfluence } from "../rubrics/confluence";
import { scoreResearch } from "../rubrics/research";

export type DeterministicResults = {
  prd: RubricResult;
  brand: RubricResult;
  jira: RubricResult;
  confluence: RubricResult;
  research: RubricResult;
};

// runResults: the row fetched by run_id on the proceed path.
// rubricVersion: RUBRIC_VERSION from lib/config (the idempotency/version key).
// checkUrl: SSRF-guarded checker from makeCheckUrl(); omit only in dry runs.
export async function runDeterministic(
  runResults: RunResults,
  rubricVersion: string,
  checkUrl?: UrlChecker,
): Promise<DeterministicResults> {
  // scorePrd/Brand/Jira/Confluence are synchronous; wrap uniformly so all five
  // resolve the same way and a future async rubric needs no runner change.
  const [prd, brand, jira, confluence, research] = await Promise.all([
    Promise.resolve(scorePrd(runResults.prd, rubricVersion)),
    Promise.resolve(scoreBrand(runResults.brand, rubricVersion)),
    Promise.resolve(scoreJira(runResults.jira, rubricVersion)),
    Promise.resolve(scoreConfluence(runResults.confluence, rubricVersion)),
    scoreResearch(runResults.competitors, rubricVersion, undefined, checkUrl),
  ]);

  return { prd, brand, jira, confluence, research };
}
