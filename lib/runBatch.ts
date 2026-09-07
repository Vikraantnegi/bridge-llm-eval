// ---------------------------------------------------------------------------
// runBatch — the batch entry the CLI calls. Owns the GATE that used to live in
// the 3a /score handler, now that the webhook path is gone:
//   - prod-write guard: --env prod requires CALIBRATION_AUTHORIZED === 'true'
//     (double lock: the flag selects env, this permits the write)
//   - budget guard: refuse once sum(judge_usd) >= QUALITY_JUDGE_MAX_USD
//   - sample gate: score at effectiveRate (1.0 calibration -> 0.15 sample)
//   - idempotency: selector skips already-attempted runs; insertAttempt PK
//     conflict skips a concurrent double-claim
// Then loops runRealScore over the claimed runs.
//
// Null-check: no eligible runs -> clean exit, zero judge calls, zero cost.
// ---------------------------------------------------------------------------

import type { SupabaseEnv } from "./persistence";
import { insertAttempt, sumJudgeUsd } from "./persistence";
import { selectRunsToScore } from "./selectRunsToScore";
import { runRealScore } from "./runRealScore";
import { makeCheckUrl } from "./checkUrl";

export type BatchConfig = {
  env: SupabaseEnv;
  envName: "dev" | "prod";
  anthropicApiKey: string;
  rubricVersion: string;
  sinceHours: number;
  // gate config (already parsed + validated by the CLI, fail-closed)
  calibrationAuthorized: boolean;
  sampleRate: number; // [0,1]
  maxUsd: number;
};

export type BatchSummary = {
  eligible: number;
  scored: number;
  judgeError: number;
  skippedSample: number;
  skippedClaimed: number;
  stoppedOverBudget: boolean;
  errors: { runId: string; detail: string }[];
};

export async function runBatch(cfg: BatchConfig): Promise<
  { ok: false; detail: string } | { ok: true; summary: BatchSummary }
> {
  // --- Prod double-lock. --env prod alone is not enough. -------------------
  if (cfg.envName === "prod" && !cfg.calibrationAuthorized) {
    return {
      ok: false,
      detail:
        "refusing to score prod: --env prod requires QUALITY_JUDGE_CALIBRATION_AUTHORIZED=true. " +
        "Set it deliberately in the prod env config to authorize prod scoring.",
    };
  }

  const sel = await selectRunsToScore(cfg.env, cfg.rubricVersion, cfg.sinceHours);
  if (!sel.ok) return { ok: false, detail: `selection failed: ${sel.detail}` };

  const summary: BatchSummary = {
    eligible: sel.runIds.length,
    scored: 0,
    judgeError: 0,
    skippedSample: 0,
    skippedClaimed: 0,
    stoppedOverBudget: false,
    errors: [],
  };

  // Null-check: nothing to do.
  if (sel.runIds.length === 0) return { ok: true, summary };

  const sampleReason = cfg.sampleRate >= 1.0 ? "calibration" : "sample";
  const checkUrl = makeCheckUrl({ timeoutMs: 5000, concurrency: 4 });

  for (const runId of sel.runIds) {
    // Budget guard BEFORE any spend for this run.
    const spent = await sumJudgeUsd(cfg.env);
    if (spent >= cfg.maxUsd) {
      summary.stoppedOverBudget = true;
      break; // stop the whole batch; remaining runs stay unscored for next time
    }

    // Sample gate.
    if (!(Math.random() < cfg.sampleRate)) {
      summary.skippedSample += 1;
      continue;
    }

    // Claim via attempt insert (PK conflict => already claimed => skip).
    const claim = await insertAttempt(cfg.env, runId, cfg.rubricVersion, sampleReason);
    if (!claim.ok) {
      summary.errors.push({ runId, detail: `attempt insert: ${claim.detail}` });
      continue;
    }
    if (!claim.claimed) {
      summary.skippedClaimed += 1;
      continue;
    }

    // Score (deterministic + one Sonnet call + persist + attempt transition).
    const res = await runRealScore({
      env: cfg.env,
      anthropicApiKey: cfg.anthropicApiKey,
      runId,
      rubricVersion: cfg.rubricVersion,
      sampleReason,
      checkUrl,
    });

    switch (res.outcome) {
      case "scored":
        summary.scored += 1;
        break;
      case "judge_error":
        summary.judgeError += 1;
        break;
      case "fetch_failed":
      case "persist_failed":
        summary.errors.push({ runId, detail: `${res.outcome}: ${res.detail}` });
        break;
    }
  }

  return { ok: true, summary };
}
