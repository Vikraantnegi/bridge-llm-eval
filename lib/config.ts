/** Hardcoded for v1; bump by hand when rubrics change (idempotency key). */
export const RUBRIC_VERSION = "v1";

// Judge Anthropic call — mirrors n8n LLM Call exactly (model, version, price).
export const JUDGE_MODEL = "claude-sonnet-5";
export const ANTHROPIC_VERSION = "2023-06-01";
/** Sonnet-5 price per million input tokens. */
export const PRICE_IN_PER_M = 2;
/** Sonnet-5 price per million output tokens. */
export const PRICE_OUT_PER_M = 10;
/** Signed-off output ceiling; stop_reason max_tokens → judge_error (no salvage). */
export const MAX_TOKENS = 2048;

export type JudgeConfig = {
  calibrationAuthorized: boolean;
  maxUsd: number | null;
  sampleRate: number | null;
  stuckMinutes: number;
  hmacSecret: string;
  supabaseUrl: string;
  supabaseServiceRoleKey: string;
  port: number;
};

const parseNumber = (raw: string | undefined): number | null => {
  if (raw === undefined || raw.trim() === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
};

/**
 * Reads scorer env. Gate fail-closed for MAX_USD / SAMPLE_RATE is decided in
 * lib/gate.ts (null/NaN/out-of-range → not_sampled + misconfigured log).
 */
export const loadConfig = (env: NodeJS.ProcessEnv = process.env): JudgeConfig => {
  const stuck = parseNumber(env.QUALITY_JUDGE_STUCK_MINUTES);
  return {
    calibrationAuthorized: env.QUALITY_JUDGE_CALIBRATION_AUTHORIZED === "true",
    maxUsd: parseNumber(env.QUALITY_JUDGE_MAX_USD),
    sampleRate: parseNumber(env.QUALITY_JUDGE_SAMPLE_RATE),
    stuckMinutes: stuck !== null && stuck > 0 ? stuck : 10,
    hmacSecret: env.MURMUR_HMAC_SECRET ?? "",
    supabaseUrl: env.SUPABASE_URL ?? env.NEXT_PUBLIC_SUPABASE_URL ?? "",
    supabaseServiceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY ?? "",
    port: parseNumber(env.PORT) ?? 8787,
  };
};
