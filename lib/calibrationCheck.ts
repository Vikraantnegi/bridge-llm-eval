// ---------------------------------------------------------------------------
// calibrationCheck — 5b. Two validations that must pass BEFORE the dataset is
// trusted to drive any writer-prompt work. Run at N ~= 40, operator-invoked,
// NOT a cron job — this is a deliberate ritual.
//
//   VARIANCE PROBE (this file, automated): re-score N already-scored runs at a
//   distinct probe rubric_version and compare to the originals. Same run ->
//   same-ish score means the instrument is STABLE. Big swings mean it is not,
//   and nothing downstream is trustworthy until fixed.
//
//   VALIDITY CHECK (human, not automatable): the operator reads the actual
//   artifacts behind a sample of scored runs and judges whether scores/gaps
//   match their own assessment. If the judge says 0.83 on a Confluence artifact
//   the operator would call excellent, the JUDGE (or rubric) is wrong — fix
//   that, never the writer. This file only PRINTS the runs+gaps to review; the
//   judgement is the operator's.
//
// Probe isolation: re-scoring collides on the unique (run_id, artifact_type,
// rubric_version) key, so the probe writes at rubric_version = `${base}-probeN`.
// Probe rows are isolated, comparable, and NEVER pollute the real dataset.
// They can be deleted afterward (a helper query is printed).
//
// Probe cost: N runs x ~$0.045 — a few dollars for N=5. Guarded by the same
// QUALITY_JUDGE_MAX_USD budget the batch uses.
// ---------------------------------------------------------------------------

import type { SupabaseEnv } from "./persistence";
import { runRealScore } from "./runRealScore";
import { insertAttempt } from "./persistence";
import { makeCheckUrl } from "./checkUrl";

const headers = (key: string) => ({
  apikey: key,
  Authorization: `Bearer ${key}`,
});

export type VarianceRow = {
  runId: string;
  artifactType: string;
  original: number | null;
  probe: number | null;
  delta: number | null; // probe - original; null if either missing/absent
};

export type CalibrationProbeResult =
  | { ok: false; detail: string }
  | {
      ok: true;
      baseVersion: string;
      probeVersion: string;
      rows: VarianceRow[];
      // summary: max absolute delta across all scored artifact pairs. The
      // headline stability number — small = stable instrument.
      maxAbsDelta: number;
      meanAbsDelta: number;
      comparedPairs: number;
    };

// Pull the per-artifact scores for a set of run_ids at a given rubric_version.
async function fetchScores(
  env: SupabaseEnv,
  runIds: string[],
  rubricVersion: string,
): Promise<Map<string, number | null>> {
  // key = `${run_id}:${artifact_type}`
  const map = new Map<string, number | null>();
  if (runIds.length === 0) return map;
  const inList = runIds.map(encodeURIComponent).join(",");
  const url =
    `${env.supabaseUrl}/rest/v1/run_quality_scores` +
    `?rubric_version=eq.${encodeURIComponent(rubricVersion)}` +
    `&run_id=in.(${inList})` +
    `&select=run_id,artifact_type,score,verdict_status`;
  const res = await fetch(url, { headers: headers(env.serviceRoleKey) });
  if (!res.ok) throw new Error(`fetchScores status ${res.status}`);
  const rows = (await res.json()) as {
    run_id: string;
    artifact_type: string;
    score: number | null;
  }[];
  for (const r of rows) map.set(`${r.run_id}:${r.artifact_type}`, r.score);
  return map;
}

export async function runVarianceProbe(args: {
  env: SupabaseEnv;
  anthropicApiKey: string;
  baseVersion: string;
  runIds: string[]; // the already-scored runs to re-score
  probeLabel?: string; // default 'probe1'
}): Promise<CalibrationProbeResult> {
  const { env, anthropicApiKey, baseVersion, runIds } = args;
  const probeVersion = `${baseVersion}-${args.probeLabel ?? "probe1"}`;

  if (runIds.length === 0) return { ok: false, detail: "no run_ids to probe" };

  const originals = await fetchScores(env, runIds, baseVersion);
  if (originals.size === 0) {
    return { ok: false, detail: `no existing scores at rubric_version=${baseVersion} for those runs` };
  }

  // Re-score each run at the probe version. insertAttempt claims (run_id,
  // probeVersion); runRealScore writes scores at probeVersion.
  const checkUrl = makeCheckUrl({ timeoutMs: 5000, concurrency: 4 });
  for (const runId of runIds) {
    const claim = await insertAttempt(env, runId, probeVersion, "calibration");
    if (!claim.ok) return { ok: false, detail: `probe attempt insert failed: ${claim.detail}` };
    if (!claim.claimed) continue; // already probed at this label; skip
    const res = await runRealScore({
      env,
      anthropicApiKey,
      runId,
      rubricVersion: probeVersion,
      sampleReason: "calibration",
      checkUrl,
    });
    if (res.outcome !== "scored" && res.outcome !== "judge_error") {
      return { ok: false, detail: `probe run ${runId}: ${res.outcome}` };
    }
  }

  const probes = await fetchScores(env, runIds, probeVersion);

  // Build the comparison across every artifact pair that has a numeric score in
  // BOTH runs (absent/error on either side -> no comparable delta).
  const artifactTypes = ["prd", "brand", "jira", "confluence", "research"];
  const rows: VarianceRow[] = [];
  const absDeltas: number[] = [];
  for (const runId of runIds) {
    for (const at of artifactTypes) {
      const o = originals.get(`${runId}:${at}`) ?? null;
      const p = probes.get(`${runId}:${at}`) ?? null;
      const delta = o !== null && p !== null ? Number((p - o).toFixed(3)) : null;
      if (delta !== null) absDeltas.push(Math.abs(delta));
      // only emit rows where at least one side had a score
      if (o !== null || p !== null) {
        rows.push({ runId, artifactType: at, original: o, probe: p, delta });
      }
    }
  }

  const maxAbsDelta = absDeltas.length ? Math.max(...absDeltas) : 0;
  const meanAbsDelta = absDeltas.length
    ? Number((absDeltas.reduce((s, d) => s + d, 0) / absDeltas.length).toFixed(3))
    : 0;

  return {
    ok: true,
    baseVersion,
    probeVersion,
    rows,
    maxAbsDelta,
    meanAbsDelta,
    comparedPairs: absDeltas.length,
  };
}

// Cleanup helper text — printed by the CLI so the operator can remove probe
// rows once the check is recorded. (We don't auto-delete: the operator should
// see the probe result before it disappears.)
export function probeCleanupSql(probeVersion: string): string {
  return [
    `-- remove probe rows after recording the variance result:`,
    `delete from public.run_quality_scores where rubric_version = '${probeVersion}';`,
    `delete from public.run_quality_attempts where rubric_version = '${probeVersion}';`,
  ].join("\n");
}
