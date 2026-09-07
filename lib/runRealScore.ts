// ---------------------------------------------------------------------------
// runRealScore — 3d. The real scoring path, replacing runStubScore.
//
// Runs ONLY on the `proceed` path, AFTER the attempt row was inserted as
// 'started' (3a). It owns everything from run_results fetch to the terminal
// attempt transition. On any judge-level failure it writes five judge_error
// rows (no deterministic salvage — ADR-044) and sets attempt 'judge_error'. On
// success it re-runs each rubric WITH the filtered LlmVerdict (so the Phase-2
// rubric does flag->gap + combineScore internally), upserts five rows, and sets
// attempt 'scored'.
//
// wasTruncated backstop (amendment 2): filterTruncatedFlags strips completeness
// flags on truncated artifacts BEFORE the verdict reaches the rubric.
//
// Crash visibility (3a): the attempt transition is the LAST step. A crash before
// it leaves the row 'started' — the intended stuck-judge signal. This function
// never marks 'scored' unless the rows are actually written.
// ---------------------------------------------------------------------------

import type { ArtifactType, RubricResult } from "../rubrics/types";
import { errored } from "../rubrics/types";
import type { RunResults } from "../types/run-results.mirror";
import { scorePrd } from "../rubrics/prd";
import { scoreBrand } from "../rubrics/brand";
import { scoreJira } from "../rubrics/jira";
import { scoreConfluence } from "../rubrics/confluence";
import { scoreResearch, type UrlChecker } from "../rubrics/research";
import { packJudgeInput } from "./packJudgeInput";
import { runJudge } from "./runJudge";
import { writeJudgeCost } from "./writeJudgeCost";
import { filterTruncatedFlags } from "./filterTruncatedFlags";
import {
  fetchRunResults,
  upsertScores,
  setAttemptStatus,
  toScoreRow,
  type SupabaseEnv,
} from "./persistence";

const ARTIFACT_KEYS: ArtifactType[] = ["prd", "brand", "jira", "confluence", "research"];

export type RunScoreArgs = {
  env: SupabaseEnv;
  anthropicApiKey: string;
  runId: string;
  rubricVersion: string;
  sampleReason: string; // 'calibration' | 'sample' (from the gate)
  checkUrl?: UrlChecker;
};

export type RunScoreResult =
  | { outcome: "scored" }
  | { outcome: "judge_error"; reason: string }
  | { outcome: "fetch_failed"; detail: string }
  | { outcome: "persist_failed"; detail: string };

// Re-run a single rubric WITH the (truncation-filtered) verdict, so the rubric
// performs its own flag->gap conversion and combineScore internally.
async function rescore(
  key: ArtifactType,
  rr: RunResults,
  rubricVersion: string,
  verdict: ReturnType<typeof filterTruncatedFlags>,
  checkUrl?: UrlChecker,
): Promise<RubricResult> {
  const llm = verdict ?? undefined;
  switch (key) {
    case "prd": return scorePrd(rr.prd, rubricVersion, llm);
    case "brand": return scoreBrand(rr.brand, rubricVersion, llm);
    case "jira": return scoreJira(rr.jira, rubricVersion, llm);
    case "confluence": return scoreConfluence(rr.confluence, rubricVersion, llm);
    case "research": return scoreResearch(rr.competitors, rubricVersion, llm, checkUrl);
  }
}

export async function runRealScore(args: RunScoreArgs): Promise<RunScoreResult> {
  const { env, anthropicApiKey, runId, rubricVersion, sampleReason, checkUrl } = args;

  // 1. Fetch run_results.
  const fetched = await fetchRunResults(env, runId);
  if (!fetched.ok) {
    // Cannot score without the row. Mark attempt judge_error (a dispatched run we
    // could not complete) so it is not left dangling 'started' forever.
    await setAttemptStatus(env, runId, rubricVersion, "judge_error").catch(() => {});
    return { outcome: "fetch_failed", detail: fetched.detail };
  }
  const rr = fetched.row;

  // 2. Pack + judge (one Sonnet call). Always record spend when > 0.
  const packed = packJudgeInput(rr);
  const judge = await runJudge(packed, anthropicApiKey);
  await writeJudgeCost({
    supabaseUrl: env.supabaseUrl,
    serviceRoleKey: env.serviceRoleKey,
    runId,
    inputTokens: judge.inputTokens,
    outputTokens: judge.outputTokens,
    costUsd: judge.costUsd,
  }).catch(() => {}); // cost write is accounting; never fatal

  // 3. Judge-level failure -> five judge_error rows, no deterministic salvage.
  if (!judge.ok) {
    const rows = ARTIFACT_KEYS.map((k) =>
      toScoreRow(runId, errored(k, rubricVersion), sampleReason),
    );
    const up = await upsertScores(env, rows);
    if (!up.ok) {
      // Rows didn't land; leave attempt 'started' rather than lie 'judge_error'
      // with no rows. (Crash-visibility parity: no terminal state without rows.)
      return { outcome: "persist_failed", detail: up.detail ?? "judge_error upsert failed" };
    }
    await setAttemptStatus(env, runId, rubricVersion, "judge_error").catch(() => {});
    return { outcome: "judge_error", reason: judge.reason };
  }

  // 4. Success -> per artifact, filter completeness flags on truncated artifacts,
  //    then re-run the rubric WITH the filtered verdict.
  const results: RubricResult[] = [];
  for (const key of ARTIFACT_KEYS) {
    const pa = judge.perArtifact[key];
    const filtered = filterTruncatedFlags(pa.verdict, pa.wasTruncated);
    results.push(await rescore(key, rr, rubricVersion, filtered, checkUrl));
  }

  // 5. Upsert five rows (idempotent). 6. Transition attempt LAST.
  const rows = results.map((r) => toScoreRow(runId, r, sampleReason));
  const up = await upsertScores(env, rows);
  if (!up.ok) {
    return { outcome: "persist_failed", detail: up.detail ?? "scores upsert failed" };
  }
  await setAttemptStatus(env, runId, rubricVersion, "scored").catch(() => {});
  return { outcome: "scored" };
}
