#!/usr/bin/env node
// ---------------------------------------------------------------------------
// calibration-check CLI — 5b. Operator-invoked at N ~= 40, BEFORE trusting the
// dataset for any writer-prompt work. NOT scheduled.
//
//   npm run calibrate:check -- --env dev --runs <id1,id2,id3> [--label probe1]
//
// Runs the VARIANCE PROBE: re-scores the given already-scored runs at a probe
// rubric_version and reports how far the scores moved (stability). Then prints
// the runs for the operator to open and eyeball (the VALIDITY check — human,
// not automated). Ends with cleanup SQL to remove the probe rows.
//
// Reads the same _DEV/_PROD env as score-batch. Prod requires the double lock.
// ---------------------------------------------------------------------------

import "dotenv/config";

import { runVarianceProbe, probeCleanupSql } from "../lib/calibrationCheck";
import { RUBRIC_VERSION } from "../lib/config";

function fail(msg: string): never {
  console.error(`calibration-check: ${msg}`);
  process.exit(2);
}

function parseArgs(argv: string[]) {
  let env: string | undefined;
  let runs: string | undefined;
  let label = "probe1";
  let baseVersion: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--env") env = argv[++i];
    else if (argv[i] === "--runs") runs = argv[++i];
    else if (argv[i] === "--label") label = argv[++i];
    else if (argv[i] === "--base-version") baseVersion = argv[++i];
  }
  if (env !== "dev" && env !== "prod") fail(`--env must be dev|prod (got ${env ?? "nothing"})`);
  if (!runs) fail("--runs <comma-separated run_ids> is required");
  const runIds = runs.split(",").map((s) => s.trim()).filter(Boolean);
  if (runIds.length === 0) fail("--runs produced no ids");
  return { env: env as "dev" | "prod", runIds, label, baseVersion };
}

function envVar(name: string, envName: "dev" | "prod", def?: string): string {
  const key = `${name}_${envName.toUpperCase()}`;
  const v = process.env[key] ?? def;
  if (v === undefined || v === "") fail(`missing env ${key}`);
  return v;
}

async function main() {
  const { env, runIds, label, baseVersion } = parseArgs(process.argv.slice(2));

  const anthropicApiKey = process.env.ANTHROPIC_API_KEY;
  if (!anthropicApiKey) fail("missing ANTHROPIC_API_KEY");

  // Prod double-lock: probing prod re-runs the judge against prod data + spends.
  if (env === "prod") {
    const authorized = envVar("QUALITY_JUDGE_CALIBRATION_AUTHORIZED", "prod", "false") === "true";
    if (!authorized) fail("refusing prod probe: QUALITY_JUDGE_CALIBRATION_AUTHORIZED_PROD must be true");
  }

  const base = baseVersion ?? process.env.RUBRIC_VERSION ?? RUBRIC_VERSION;
  const supabaseUrl = envVar("SUPABASE_URL", env);
  const serviceRoleKey = envVar("SUPABASE_SERVICE_ROLE_KEY", env);

  console.log(`calibration-check: env=${env} base=${base} label=${label} runs=${runIds.length}`);

  const r = await runVarianceProbe({
    env: { supabaseUrl, serviceRoleKey },
    anthropicApiKey,
    baseVersion: base,
    runIds,
    probeLabel: label,
  });

  if (!r.ok) fail(r.detail);

  // --- Variance report ------------------------------------------------------
  console.log(`\n=== VARIANCE PROBE: ${base} vs ${r.probeVersion} ===`);
  console.log("run_id".padEnd(38), "artifact".padEnd(12), "orig", "  probe", "  delta");
  for (const row of r.rows) {
    console.log(
      row.runId.slice(0, 36).padEnd(38),
      row.artifactType.padEnd(12),
      (row.original ?? "—").toString().padStart(5),
      (row.probe ?? "—").toString().padStart(6),
      (row.delta ?? "—").toString().padStart(7),
    );
  }
  console.log(
    `\nstability: max|Δ|=${r.maxAbsDelta}  mean|Δ|=${r.meanAbsDelta}  pairs=${r.comparedPairs}`,
  );
  // Interpretation guide — NOT a hard pass/fail (operator decides), but a steer.
  if (r.maxAbsDelta <= 0.05) {
    console.log("  -> STABLE: scores reproduce within 0.05. Instrument is consistent.");
  } else if (r.maxAbsDelta <= 0.1) {
    console.log("  -> MODERATE drift (<=0.10). Usable, but treat small score gaps as noise.");
  } else {
    console.log("  -> UNSTABLE (>0.10). Do NOT trust score comparisons until this is understood.");
  }

  // --- Validity check prompt (human) ---------------------------------------
  console.log(`\n=== VALIDITY CHECK (do this by hand) ===`);
  console.log("Open the artifacts behind these runs and judge whether the scores/gaps");
  console.log("match your own read. If the judge disagrees with you, fix the JUDGE/RUBRIC,");
  console.log("not the writer. Runs probed:");
  for (const id of runIds) console.log(`  - ${id}`);

  // --- Cleanup --------------------------------------------------------------
  console.log(`\n=== CLEANUP (after recording the result) ===`);
  console.log(probeCleanupSql(r.probeVersion));

  process.exit(0);
}

main().catch((e) => {
  console.error("calibration-check: fatal", e);
  process.exit(1);
});
