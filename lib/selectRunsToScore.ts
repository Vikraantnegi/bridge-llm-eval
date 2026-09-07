// ---------------------------------------------------------------------------
// selectRunsToScore — batch path. Returns run_ids of completed runs in the
// window that (1) have a run_results row and (2) do NOT yet have a
// run_quality_attempts row for this rubric_version.
//
// This is the batch idempotency guard at SELECTION time (cheap: skip already-
// claimed runs before doing any work). The per-run insertAttempt PK conflict is
// the SECOND guard against a concurrent double-run. Both together mean a run is
// scored at most once per rubric_version.
//
// Null-check: if this returns [], the batch exits cleanly with no judge call
// and no cost (the "no new run_results -> don't run" behavior). Requiring a
// run_results row avoids claiming done-but-empty pipeline runs as judge_error.
//
// Attempts / results are queried scoped to the candidate done ids
// (run_id=in.(...)) so a large historical table cannot page-truncate and miss.
// ---------------------------------------------------------------------------

import type { SupabaseEnv } from "./persistence";

const headers = (key: string) => ({
  apikey: key,
  Authorization: `Bearer ${key}`,
});

/** PostgREST `in.()` chunk size — keep URLs under practical limits. */
const IN_CHUNK = 100;

async function fetchRunIdsIn(
  env: SupabaseEnv,
  table: "run_quality_attempts" | "run_results",
  rubricVersion: string | null,
  candidateIds: string[],
): Promise<{ ok: true; ids: Set<string> } | { ok: false; detail: string }> {
  const found = new Set<string>();
  for (let i = 0; i < candidateIds.length; i += IN_CHUNK) {
    const chunk = candidateIds.slice(i, i + IN_CHUNK);
    const inList = chunk.map(encodeURIComponent).join(",");
    let url =
      `${env.supabaseUrl}/rest/v1/${table}` +
      `?run_id=in.(${inList})` +
      `&select=run_id`;
    if (table === "run_quality_attempts" && rubricVersion) {
      url += `&rubric_version=eq.${encodeURIComponent(rubricVersion)}`;
    }
    const res = await fetch(url, { headers: headers(env.serviceRoleKey) });
    if (!res.ok) return { ok: false, detail: `${table} status ${res.status}` };
    const rows = (await res.json()) as { run_id: string }[];
    for (const r of rows) found.add(r.run_id);
  }
  return { ok: true, ids: found };
}

export async function selectRunsToScore(
  env: SupabaseEnv,
  rubricVersion: string,
  sinceHours: number,
): Promise<{ ok: true; runIds: string[] } | { ok: false; detail: string }> {
  const sinceIso = new Date(Date.now() - sinceHours * 3600_000).toISOString();

  const doneUrl =
    `${env.supabaseUrl}/rest/v1/pipeline_runs` +
    `?status=eq.done` +
    `&completed_at=gte.${encodeURIComponent(sinceIso)}` +
    `&select=id,completed_at`;

  try {
    const doneRes = await fetch(doneUrl, { headers: headers(env.serviceRoleKey) });
    if (!doneRes.ok) return { ok: false, detail: `pipeline_runs status ${doneRes.status}` };

    const done = (await doneRes.json()) as { id: string; completed_at: string }[];
    if (!Array.isArray(done) || done.length === 0) {
      return { ok: true, runIds: [] };
    }

    const candidateIds = done.map((r) => r.id);

    const withResults = await fetchRunIdsIn(env, "run_results", null, candidateIds);
    if (!withResults.ok) return withResults;

    const claimed = await fetchRunIdsIn(
      env,
      "run_quality_attempts",
      rubricVersion,
      candidateIds,
    );
    if (!claimed.ok) return claimed;

    // Oldest-first so a budget cut-off mid-batch scores the earliest runs.
    const runIds = done
      .filter((r) => withResults.ids.has(r.id) && !claimed.ids.has(r.id))
      .sort((a, b) => a.completed_at.localeCompare(b.completed_at))
      .map((r) => r.id);

    return { ok: true, runIds };
  } catch (e) {
    return { ok: false, detail: String(e) };
  }
}
