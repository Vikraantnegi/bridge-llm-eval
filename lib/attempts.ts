export type AttemptStatus = "started" | "scored" | "judge_error";
export type SampleReason = "calibration" | "sample";

export type AttemptRow = {
  run_id: string;
  rubric_version: string;
  status: AttemptStatus;
  sample_reason: SampleReason;
  created_at: string;
  updated_at: string;
};

export type AttemptsStore = {
  getAttempt: (
    runId: string,
    rubricVersion: string,
  ) => Promise<AttemptRow | null>;
  insertStarted: (params: {
    runId: string;
    rubricVersion: string;
    sampleReason: SampleReason;
  }) => Promise<"inserted" | "conflict">;
  updateStatus: (params: {
    runId: string;
    rubricVersion: string;
    status: "scored" | "judge_error";
  }) => Promise<void>;
  sumJudgeUsd: () => Promise<number>;
};
