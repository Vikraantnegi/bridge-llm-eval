// ---------------------------------------------------------------------------
// persistence — 3d + batch. Supabase reads/writes for the scorer, service-role,
// using the same header pattern as the n8n export (apikey + Authorization Bearer,
// clean "Authorization" with no trailing space).
//
//  - fetchRunResults(run_id): the completed row the judge scores.
//  - upsertScores(rows): five run_quality_scores rows, idempotent on
//    (run_id, artifact_type, rubric_version) via ?on_conflict + merge-duplicates.
//  - setAttemptStatus(run_id, rubric_version, status): started -> scored|judge_error.
//  - insertAttempt(...): batch claim; PK conflict => already claimed.
//  - sumJudgeUsd(): budget guard via PostgREST aggregate (fail-closed).
//
// All are service-role (RLS-bypass); these tables are operator-only (zero
// policies). Errors are returned, not thrown, so the orchestrator can decide
// (a score-write failure must not crash the process and orphan the attempt row).
// ---------------------------------------------------------------------------

import type { RunResults } from "../types/run-results.mirror";
import type { RubricResult } from "../rubrics/types";

export type SupabaseEnv = { supabaseUrl: string; serviceRoleKey: string };

const headers = (key: string) => ({
  apikey: key,
  Authorization: `Bearer ${key}`,
  "Content-Type": "application/json",
});

// --- fetch run_results ------------------------------------------------------
export async function fetchRunResults(
  env: SupabaseEnv,
  runId: string,
): Promise<{ ok: true; row: RunResults } | { ok: false; detail: string }> {
  // Live table has no transcript column (v1 pack excludes it anyway). Select
  // only real jsonb columns; fill transcript:null for the mirror RunResults type.
  const url =
    `${env.supabaseUrl}/rest/v1/run_results` +
    `?run_id=eq.${encodeURIComponent(runId)}` +
    `&select=prd,competitors,brand,engineering,jira,confluence`;
  try {
    const res = await fetch(url, { headers: headers(env.serviceRoleKey) });
    if (!res.ok) return { ok: false, detail: `run_results status ${res.status}` };
    const rows = (await res.json()) as Omit<RunResults, "transcript">[];
    if (!Array.isArray(rows) || rows.length === 0) {
      return { ok: false, detail: "run_results row not found" };
    }
    return { ok: true, row: { ...rows[0], transcript: null } };
  } catch (e) {
    return { ok: false, detail: String(e) };
  }
}

// --- upsert five score rows -------------------------------------------------
// Maps RubricResult -> the run_quality_scores column shape. score is null unless
// verdict === 'scored' (the DB CHECK enforces this too). Per-row token/cost stay
// null: the shared judge bill lives once in run_costs.judge_usd (ADR-044 f).
export type ScoreRow = {
  run_id: string;
  artifact_type: string;
  rubric_version: string;
  score: number | null;
  verdict_status: string;
  coverage: unknown;
  gaps: unknown;
  sample_reason: string;
};

export function toScoreRow(
  runId: string,
  r: RubricResult,
  sampleReason: string,
): ScoreRow {
  return {
    run_id: runId,
    artifact_type: r.artifactType,
    rubric_version: r.rubricVersion,
    score: r.score,
    verdict_status: r.verdict,
    coverage: r.coverage,
    gaps: r.gaps,
    sample_reason: sampleReason,
  };
}

export async function upsertScores(
  env: SupabaseEnv,
  rows: ScoreRow[],
): Promise<{ ok: boolean; detail?: string }> {
  const url =
    `${env.supabaseUrl}/rest/v1/run_quality_scores` +
    `?on_conflict=run_id,artifact_type,rubric_version`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        ...headers(env.serviceRoleKey),
        Prefer: "return=minimal,resolution=merge-duplicates",
      },
      body: JSON.stringify(rows),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return { ok: false, detail: `scores upsert status ${res.status} ${body.slice(0, 200)}` };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, detail: String(e) };
  }
}

// --- transition attempt -----------------------------------------------------
export async function setAttemptStatus(
  env: SupabaseEnv,
  runId: string,
  rubricVersion: string,
  status: "scored" | "judge_error",
): Promise<{ ok: boolean; detail?: string }> {
  const url =
    `${env.supabaseUrl}/rest/v1/run_quality_attempts` +
    `?run_id=eq.${encodeURIComponent(runId)}` +
    `&rubric_version=eq.${encodeURIComponent(rubricVersion)}`;
  try {
    const res = await fetch(url, {
      method: "PATCH",
      headers: { ...headers(env.serviceRoleKey), Prefer: "return=minimal" },
      body: JSON.stringify({ status, updated_at: new Date().toISOString() }),
    });
    if (!res.ok) return { ok: false, detail: `attempt patch status ${res.status}` };
    return { ok: true };
  } catch (e) {
    return { ok: false, detail: String(e) };
  }
}

// --- insert attempt (batch path) -------------------------------------------
// Inserts the 'started' row BEFORE scoring. The PK (run_id, rubric_version)
// makes this the idempotency guard: a duplicate insert returns 409 (conflict),
// which the caller treats as "already claimed" and skips — no double Sonnet
// spend even under a concurrent/re-run batch. Returns claimed:false on conflict.
export async function insertAttempt(
  env: SupabaseEnv,
  runId: string,
  rubricVersion: string,
  sampleReason: string,
): Promise<{ ok: true; claimed: boolean } | { ok: false; detail: string }> {
  const url = `${env.supabaseUrl}/rest/v1/run_quality_attempts`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        ...headers(env.serviceRoleKey),
        // Do not upsert: a real conflict means already-claimed. return=minimal.
        Prefer: "return=minimal",
      },
      body: JSON.stringify({
        run_id: runId,
        rubric_version: rubricVersion,
        status: "started",
        sample_reason: sampleReason,
      }),
    });
    if (res.status === 409) return { ok: true, claimed: false }; // PK conflict
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return { ok: false, detail: `attempt insert status ${res.status} ${body.slice(0, 160)}` };
    }
    return { ok: true, claimed: true };
  } catch (e) {
    return { ok: false, detail: String(e) };
  }
}

// --- sum judge spend (budget guard) ----------------------------------------
// Client-side sum with Range pagination. PostgREST on this project rejects
// aggregates (PGRST123), so judge_usd.sum() fails closed forever → over_budget.
// Fail closed only on fetch/parse error (unknown spend → treat as over budget).
const JUDGE_USD_PAGE = 1000;

export async function sumJudgeUsd(env: SupabaseEnv): Promise<number> {
  const base = `${env.supabaseUrl}/rest/v1/run_costs?select=judge_usd`;
  try {
    let sum = 0;
    let from = 0;
    for (;;) {
      const to = from + JUDGE_USD_PAGE - 1;
      const res = await fetch(base, {
        headers: {
          ...headers(env.serviceRoleKey),
          Range: `${from}-${to}`,
          Prefer: "count=exact",
        },
      });
      if (!res.ok) return Number.POSITIVE_INFINITY;
      const rows = (await res.json()) as { judge_usd: number | null }[];
      if (!Array.isArray(rows)) return Number.POSITIVE_INFINITY;
      for (const r of rows) sum += r.judge_usd ?? 0;
      if (rows.length < JUDGE_USD_PAGE) return sum;
      from += JUDGE_USD_PAGE;
    }
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}
