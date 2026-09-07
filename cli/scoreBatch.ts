#!/usr/bin/env node
// ---------------------------------------------------------------------------
// score-batch CLI — the local/Cursor entry point for batch scoring.
//
//   npm run score:batch:dev            # score dev's last 24h of done runs
//   npm run score:batch:prod           # prod (requires the double-lock)
//   tsx cli/scoreBatch.ts --env dev --since 24
//
// Reads env from a local .env (gitignored) via dotenv. Fail-closed on bad
// config: a missing/NaN/out-of-range value exits non-zero WITHOUT calling Anthropic.
//
// Env vars (per environment, suffixed _DEV / _PROD):
//   SUPABASE_URL_DEV / SUPABASE_URL_PROD
//   SUPABASE_SERVICE_ROLE_KEY_DEV / _PROD
//   QUALITY_JUDGE_CALIBRATION_AUTHORIZED_DEV / _PROD   ('true' to permit writes)
//   QUALITY_JUDGE_SAMPLE_RATE_DEV / _PROD              (0..1)
//   QUALITY_JUDGE_MAX_USD_DEV / _PROD
// Shared:
//   ANTHROPIC_API_KEY
//   RUBRIC_VERSION  (falls back to config.RUBRIC_VERSION)
// ---------------------------------------------------------------------------

import "dotenv/config";

import { runBatch } from "../lib/runBatch";
import { RUBRIC_VERSION } from "../lib/config";

type Args = { env: "dev" | "prod"; sinceHours: number };

function parseArgs(argv: string[]): Args {
  let env: string | undefined;
  let since = "24";
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--env") env = argv[++i];
    else if (argv[i] === "--since") since = argv[++i];
  }
  if (env !== "dev" && env !== "prod") {
    fail(`--env must be 'dev' or 'prod' (got ${env ?? "nothing"})`);
  }
  const sinceHours = Number(since);
  if (!Number.isFinite(sinceHours) || sinceHours <= 0) {
    fail(`--since must be a positive number of hours (got ${since})`);
  }
  return { env: env as "dev" | "prod", sinceHours };
}

function fail(msg: string): never {
  console.error(`score-batch: ${msg}`);
  process.exit(2);
}

// Read a per-env var (SUFFIX _DEV/_PROD), required unless a default is given.
function envVar(name: string, envName: "dev" | "prod", def?: string): string {
  const key = `${name}_${envName.toUpperCase()}`;
  const v = process.env[key] ?? def;
  if (v === undefined || v === "") fail(`missing env ${key}`);
  return v;
}

// Parse a number env fail-closed: unset/NaN/out-of-range -> exit, no scoring.
function numEnv(raw: string, name: string, min: number, max: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min || n > max) {
    fail(`${name} must be a number in [${min}, ${max}] (got ${raw}) — refusing to run`);
  }
  return n;
}

async function main() {
  const { env, sinceHours } = parseArgs(process.argv.slice(2));

  const anthropicApiKey = process.env.ANTHROPIC_API_KEY;
  if (!anthropicApiKey) fail("missing ANTHROPIC_API_KEY");

  const rubricVersion = process.env.RUBRIC_VERSION ?? RUBRIC_VERSION;

  const supabaseUrl = envVar("SUPABASE_URL", env);
  const serviceRoleKey = envVar("SUPABASE_SERVICE_ROLE_KEY", env);
  const calibrationAuthorized =
    envVar("QUALITY_JUDGE_CALIBRATION_AUTHORIZED", env, "false") === "true";
  const sampleRate = numEnv(
    envVar("QUALITY_JUDGE_SAMPLE_RATE", env, ""),
    "QUALITY_JUDGE_SAMPLE_RATE",
    0,
    1,
  );
  const maxUsd = numEnv(
    envVar("QUALITY_JUDGE_MAX_USD", env, ""),
    "QUALITY_JUDGE_MAX_USD",
    0,
    1_000_000,
  );

  console.log(
    `score-batch: env=${env} rubric=${rubricVersion} since=${sinceHours}h ` +
      `rate=${sampleRate} maxUsd=${maxUsd} authorized=${calibrationAuthorized}`,
  );

  const result = await runBatch({
    env: { supabaseUrl, serviceRoleKey },
    envName: env,
    anthropicApiKey,
    rubricVersion,
    sinceHours,
    calibrationAuthorized,
    sampleRate,
    maxUsd,
  });

  if (!result.ok) {
    console.error(`score-batch: ${result.detail}`);
    process.exit(1);
  }

  const s = result.summary;
  console.log(
    `score-batch: done — eligible=${s.eligible} scored=${s.scored} ` +
      `judge_error=${s.judgeError} skipped_sample=${s.skippedSample} ` +
      `skipped_claimed=${s.skippedClaimed} over_budget=${s.stoppedOverBudget} ` +
      `errors=${s.errors.length}`,
  );
  for (const e of s.errors) console.error(`  ! ${e.runId}: ${e.detail}`);

  if (s.eligible === 0) console.log("score-batch: no new run_results to score — clean exit.");
  // Non-zero exit if any hard errors, so a scheduled task surfaces failure.
  process.exit(s.errors.length > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("score-batch: fatal", e);
  process.exit(1);
});
