import type { AttemptRow, AttemptsStore, SampleReason } from "./attempts";
import type { JudgeConfig } from "./config";
import { RUBRIC_VERSION } from "./config";

export type GateOutcome =
  | "already_complete"
  | "in_flight"
  | "stale_attempt"
  | "not_authorized"
  | "not_sampled"
  | "over_budget"
  | "proceed";

export type GateResult =
  | { outcome: Exclude<GateOutcome, "proceed">; detail?: string }
  | { outcome: "proceed"; sampleReason: SampleReason };

export type GateDeps = {
  config: Pick<
    JudgeConfig,
    "calibrationAuthorized" | "maxUsd" | "sampleRate" | "stuckMinutes"
  >;
  store: AttemptsStore;
  now?: () => Date;
  random?: () => number;
  rubricVersion?: string;
};

const isTerminal = (status: AttemptRow["status"]): boolean =>
  status === "scored" || status === "judge_error";

/**
 * Gate order (fixed). First match wins. Non-proceed writes zero score/attempt rows
 * (except idempotency stops that already have a row).
 */
export const runGate = async (
  runId: string,
  deps: GateDeps,
): Promise<GateResult> => {
  const {
    config,
    store,
    now = () => new Date(),
    random = Math.random,
    rubricVersion = RUBRIC_VERSION,
  } = deps;

  // 1. Idempotency
  const existing = await store.getAttempt(runId, rubricVersion);
  if (existing) {
    if (isTerminal(existing.status)) {
      return { outcome: "already_complete" };
    }
    const ageMs = now().getTime() - new Date(existing.created_at).getTime();
    const stuckMs = config.stuckMinutes * 60_000;
    if (ageMs <= stuckMs) {
      return { outcome: "in_flight" };
    }
    return { outcome: "stale_attempt" };
  }

  // 2. Prod-write / calibration guard
  if (!config.calibrationAuthorized) {
    return { outcome: "not_authorized" };
  }

  // 3. Config sanity — fail closed
  const maxUsd = config.maxUsd;
  const sampleRate = config.sampleRate;
  if (maxUsd === null || maxUsd < 0) {
    return {
      outcome: "not_sampled",
      detail: "misconfigured:QUALITY_JUDGE_MAX_USD",
    };
  }
  if (sampleRate === null || sampleRate < 0 || sampleRate > 1) {
    return {
      outcome: "not_sampled",
      detail: "misconfigured:QUALITY_JUDGE_SAMPLE_RATE",
    };
  }

  // 4. Budget
  const spent = await store.sumJudgeUsd();
  if (spent >= maxUsd) {
    return { outcome: "over_budget" };
  }

  // 5. Sample
  if (!(random() < sampleRate)) {
    return { outcome: "not_sampled" };
  }

  const sampleReason: SampleReason =
    sampleRate >= 1.0 ? "calibration" : "sample";
  return { outcome: "proceed", sampleReason };
};
