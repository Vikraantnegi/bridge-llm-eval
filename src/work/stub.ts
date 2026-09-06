import type { AttemptsStore } from "../../lib/attempts";
import { RUBRIC_VERSION } from "../../lib/config";

/**
 * 3a stub for 3b–3d: mark attempt scored without writing run_quality_scores.
 * Phase 3d owns the five-row upsert policy.
 */
export const runStubScore = async (
  runId: string,
  store: AttemptsStore,
  rubricVersion: string = RUBRIC_VERSION,
): Promise<void> => {
  console.log(
    JSON.stringify({
      event: "stub_score",
      run_id: runId,
      rubric_version: rubricVersion,
    }),
  );
  await store.updateStatus({
    runId,
    rubricVersion,
    status: "scored",
  });
};
