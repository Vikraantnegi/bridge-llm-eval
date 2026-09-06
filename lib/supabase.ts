import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { AttemptRow, AttemptsStore, SampleReason } from "./attempts";

export const createServiceClient = (
  url: string,
  serviceRoleKey: string,
): SupabaseClient =>
  createClient(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

export const createSupabaseAttemptsStore = (
  client: SupabaseClient,
): AttemptsStore => ({
  async getAttempt(runId, rubricVersion) {
    const { data, error } = await client
      .from("run_quality_attempts")
      .select("*")
      .eq("run_id", runId)
      .eq("rubric_version", rubricVersion)
      .maybeSingle();
    if (error) throw error;
    return (data as AttemptRow | null) ?? null;
  },

  async insertStarted({ runId, rubricVersion, sampleReason }) {
    const { error } = await client.from("run_quality_attempts").insert({
      run_id: runId,
      rubric_version: rubricVersion,
      status: "started",
      sample_reason: sampleReason,
    });
    if (error) {
      if (error.code === "23505") return "conflict";
      throw error;
    }
    return "inserted";
  },

  async updateStatus({ runId, rubricVersion, status }) {
    const { error } = await client
      .from("run_quality_attempts")
      .update({ status, updated_at: new Date().toISOString() })
      .eq("run_id", runId)
      .eq("rubric_version", rubricVersion);
    if (error) throw error;
  },

  async sumJudgeUsd() {
    const { data, error } = await client.from("run_costs").select("judge_usd");
    if (error) throw error;
    return (data ?? []).reduce(
      (sum, row) => sum + Number((row as { judge_usd?: number }).judge_usd ?? 0),
      0,
    );
  },
});

export type { SampleReason };
