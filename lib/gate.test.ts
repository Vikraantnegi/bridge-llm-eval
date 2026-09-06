import { describe, expect, it } from "vitest";
import type { AttemptRow, AttemptsStore, SampleReason } from "./attempts";
import { runGate } from "./gate";

const RUN = "22222222-2222-2222-2222-222222222222";

const baseConfig = {
  calibrationAuthorized: true,
  maxUsd: 25,
  sampleRate: 1.0,
  stuckMinutes: 10,
};

const makeStore = (opts?: {
  attempt?: AttemptRow | null;
  judgeUsd?: number;
  onInsert?: () => void;
}): AttemptsStore => {
  let attempt = opts?.attempt ?? null;
  return {
    async getAttempt() {
      return attempt;
    },
    async insertStarted({ sampleReason }) {
      opts?.onInsert?.();
      if (attempt) return "conflict";
      attempt = {
        run_id: RUN,
        rubric_version: "v1",
        status: "started",
        sample_reason: sampleReason,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      return "inserted";
    },
    async updateStatus() {},
    async sumJudgeUsd() {
      return opts?.judgeUsd ?? 0;
    },
  };
};

const row = (
  status: AttemptRow["status"],
  createdAt: Date,
  sampleReason: SampleReason = "calibration",
): AttemptRow => ({
  run_id: RUN,
  rubric_version: "v1",
  status,
  sample_reason: sampleReason,
  created_at: createdAt.toISOString(),
  updated_at: createdAt.toISOString(),
});

describe("runGate", () => {
  it("already_complete when scored or judge_error", async () => {
    for (const status of ["scored", "judge_error"] as const) {
      const result = await runGate(RUN, {
        config: baseConfig,
        store: makeStore({ attempt: row(status, new Date()) }),
      });
      expect(result.outcome).toBe("already_complete");
    }
  });

  it("in_flight for fresh started", async () => {
    const result = await runGate(RUN, {
      config: baseConfig,
      store: makeStore({ attempt: row("started", new Date()) }),
      now: () => new Date(),
    });
    expect(result.outcome).toBe("in_flight");
  });

  it("stale_attempt for started older than stuckMinutes", async () => {
    const created = new Date("2026-01-01T00:00:00Z");
    const result = await runGate(RUN, {
      config: baseConfig,
      store: makeStore({ attempt: row("started", created) }),
      now: () => new Date("2026-01-01T00:11:00Z"),
    });
    expect(result.outcome).toBe("stale_attempt");
  });

  it("not_authorized when calibration flag is not true", async () => {
    const result = await runGate(RUN, {
      config: { ...baseConfig, calibrationAuthorized: false },
      store: makeStore(),
    });
    expect(result.outcome).toBe("not_authorized");
  });

  it("not_sampled + misconfigured when MAX_USD bad", async () => {
    const result = await runGate(RUN, {
      config: { ...baseConfig, maxUsd: null },
      store: makeStore(),
    });
    expect(result).toEqual({
      outcome: "not_sampled",
      detail: "misconfigured:QUALITY_JUDGE_MAX_USD",
    });
  });

  it("not_sampled + misconfigured when SAMPLE_RATE out of [0,1]", async () => {
    const result = await runGate(RUN, {
      config: { ...baseConfig, sampleRate: 1.5 },
      store: makeStore(),
    });
    expect(result).toEqual({
      outcome: "not_sampled",
      detail: "misconfigured:QUALITY_JUDGE_SAMPLE_RATE",
    });
  });

  it("over_budget when sum(judge_usd) >= MAX", async () => {
    const result = await runGate(RUN, {
      config: baseConfig,
      store: makeStore({ judgeUsd: 25 }),
    });
    expect(result.outcome).toBe("over_budget");
  });

  it("not_sampled when random() >= rate", async () => {
    const result = await runGate(RUN, {
      config: { ...baseConfig, sampleRate: 0.15 },
      store: makeStore(),
      random: () => 0.9,
    });
    expect(result.outcome).toBe("not_sampled");
  });

  it("proceed with calibration sample_reason when rate >= 1", async () => {
    const result = await runGate(RUN, {
      config: baseConfig,
      store: makeStore(),
      random: () => 0,
    });
    expect(result).toEqual({ outcome: "proceed", sampleReason: "calibration" });
  });

  it("proceed with sample sample_reason when rate < 1", async () => {
    const result = await runGate(RUN, {
      config: { ...baseConfig, sampleRate: 0.15 },
      store: makeStore(),
      random: () => 0.01,
    });
    expect(result).toEqual({ outcome: "proceed", sampleReason: "sample" });
  });
});
