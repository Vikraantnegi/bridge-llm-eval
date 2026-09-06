// ---------------------------------------------------------------------------
// writeJudgeCost — 3c. Calls the Phase-1 increment_judge_cost RPC so judge
// dollars land in run_costs.judge_usd ONLY (never anthropic_usd, never
// increment_run_cost, never pipeline_runs.cost_usd via finalize).
//
// Mirrors the export's RPC-call pattern: POST {SUPABASE_URL}/rest/v1/rpc/<fn>
// with service-role apikey + Authorization Bearer, bodyParameters as JSON.
// Uses the clean "Authorization" header (no trailing space).
//
// Non-fatal: a cost-write failure must not crash scoring. Returns ok/err; the
// caller logs but proceeds (the score rows are the deliverable; the cost line
// is accounting). Always attempt this even on a wasted call (max_tokens /
// parse_error) so the spend is still recorded against the budget guard.
// ---------------------------------------------------------------------------

export type JudgeCostArgs = {
  supabaseUrl: string;
  serviceRoleKey: string;
  runId: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
};

export async function writeJudgeCost(
  args: JudgeCostArgs,
): Promise<{ ok: boolean; detail?: string }> {
  const { supabaseUrl, serviceRoleKey, runId, inputTokens, outputTokens, costUsd } = args;

  // Nothing to record (e.g. over_hard_stop: no call happened, zero spend).
  if (inputTokens === 0 && outputTokens === 0 && costUsd === 0) {
    return { ok: true, detail: "no-spend-skip" };
  }

  try {
    const res = await fetch(`${supabaseUrl}/rest/v1/rpc/increment_judge_cost`, {
      method: "POST",
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        p_run_id: runId,
        p_input_tokens: inputTokens,
        p_output_tokens: outputTokens,
        p_cost_usd: costUsd,
      }),
    });
    if (!res.ok) {
      return { ok: false, detail: `status ${res.status}` };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, detail: String(e) };
  }
}
