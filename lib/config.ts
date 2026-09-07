/** Hardcoded for v1; bump by hand when rubrics change (idempotency key). */
export const RUBRIC_VERSION = "v1";

// Judge Anthropic call — model, version, price for runJudge + writeJudgeCost.
export const JUDGE_MODEL = "claude-sonnet-5";
export const ANTHROPIC_VERSION = "2023-06-01";
/** Sonnet-5 price per million input tokens. */
export const PRICE_IN_PER_M = 2;
/** Sonnet-5 price per million output tokens. */
export const PRICE_OUT_PER_M = 10;
/**
 * Output ceiling. Prod burn-in: successful verdicts were ~1.3–1.7k out; one run
 * hit the old 2048 wall → judge_error. 4096 (2×) is the new floor.
 * stop_reason max_tokens → judge_error (no salvage).
 */
export const MAX_TOKENS = 4096;
