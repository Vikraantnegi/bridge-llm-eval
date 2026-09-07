import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { runRealScore } from "./runRealScore";

type Recorded = {
  runResultsFetches: number;
  costCalls: number;
  scoresBody: unknown[] | null;
  attemptBody: { status?: string } | null;
  anthropicCalls: number;
};

const RR_ROW = {
  transcript: "t",
  prd: {
    productName: "P",
    oneLiner: "o",
    problem: "pr",
    targetUser: "u",
    features: { must_have: [{ title: "m", description: "d" }] },
  },
  competitors: { competitors: [{ name: "A" }] },
  brand: null,
  engineering: null,
  jira: {
    success: true,
    epicsCreated: [{ key: "E1" }],
    storiesCreated: [{ key: "S1", epic: "E1" }],
  },
  confluence: null,
};

function installFetch(opts: {
  anthropic: () => { ok: boolean; status?: number; json: () => Promise<unknown> };
  rec: Recorded;
  runResultsEmpty?: boolean;
}) {
  const { rec } = opts;
  const mock = vi.fn(async (url: unknown, init?: { body?: string }) => {
    const u = String(url);
    if (u.includes("/run_results?")) {
      rec.runResultsFetches++;
      return {
        ok: true,
        json: async () => (opts.runResultsEmpty ? [] : [RR_ROW]),
      } as unknown as Response;
    }
    if (u.includes("/rpc/increment_judge_cost")) {
      rec.costCalls++;
      return { ok: true, text: async () => "" } as unknown as Response;
    }
    if (u.includes("/run_quality_scores?")) {
      rec.scoresBody = JSON.parse(init!.body!);
      return { ok: true, text: async () => "" } as unknown as Response;
    }
    if (u.includes("/run_quality_attempts?")) {
      rec.attemptBody = JSON.parse(init!.body!);
      return { ok: true, text: async () => "" } as unknown as Response;
    }
    if (u.includes("api.anthropic.com")) {
      rec.anthropicCalls++;
      return opts.anthropic() as unknown as Response;
    }
    return {
      ok: false,
      status: 500,
      text: async () => "unexpected",
    } as unknown as Response;
  });
  vi.stubGlobal("fetch", mock);
}

const baseArgs = {
  env: { supabaseUrl: "https://db", serviceRoleKey: "k" },
  anthropicApiKey: "a",
  runId: "RID",
  rubricVersion: "v1",
  sampleReason: "calibration",
};

let rec: Recorded;
beforeEach(() => {
  rec = {
    runResultsFetches: 0,
    costCalls: 0,
    scoresBody: null,
    attemptBody: null,
    anthropicCalls: 0,
  };
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("runRealScore — success path", () => {
  it("scores, writes five rows, transitions attempt to scored", async () => {
    installFetch({
      rec,
      anthropic: () => ({
        ok: true,
        json: async () => ({
          stop_reason: "end_turn",
          usage: { input_tokens: 4000, output_tokens: 300 },
          content: [
            {
              type: "text",
              text: JSON.stringify({
                prd: { qualitativeScore: 0.9, flags: [] },
                jira: { qualitativeScore: 1, flags: [] },
                research: { qualitativeScore: 0.8, flags: [] },
              }),
            },
          ],
        }),
      }),
    });

    const r = await runRealScore(baseArgs);
    expect(r.outcome).toBe("scored");
    expect(rec.runResultsFetches).toBe(1);
    expect(rec.costCalls).toBe(1);
    expect(rec.anthropicCalls).toBe(1);
    expect(rec.scoresBody).toHaveLength(5);

    const byType = Object.fromEntries(
      (
        rec.scoresBody as {
          artifact_type: string;
          verdict_status: string;
          sample_reason: string;
        }[]
      ).map((x) => [x.artifact_type, x]),
    );
    expect(byType.brand.verdict_status).toBe("artifact_absent");
    expect(byType.confluence.verdict_status).toBe("artifact_absent");
    expect(byType.prd.verdict_status).toBe("scored");
    expect(byType.jira.verdict_status).toBe("scored");
    expect(byType.research.verdict_status).toBe("scored");
    expect(byType.prd.sample_reason).toBe("calibration");
    expect(rec.attemptBody?.status).toBe("scored");
  });
});

describe("runRealScore — judge failure (max_tokens)", () => {
  it("writes five judge_error rows and transitions attempt to judge_error", async () => {
    installFetch({
      rec,
      anthropic: () => ({
        ok: true,
        json: async () => ({
          stop_reason: "max_tokens",
          usage: { input_tokens: 4000, output_tokens: 2048 },
          content: [{ type: "text", text: '{"prd":{' }],
        }),
      }),
    });

    const r = await runRealScore({ ...baseArgs, sampleReason: "sample" });
    expect(r.outcome).toBe("judge_error");
    expect((r as { reason: string }).reason).toBe("max_tokens");
    expect(rec.costCalls).toBe(1);
    expect(rec.scoresBody).toHaveLength(5);
    expect(
      (rec.scoresBody as { verdict_status: string }[]).every(
        (x) => x.verdict_status === "judge_error",
      ),
    ).toBe(true);
    expect(
      (rec.scoresBody as { score: number | null }[]).every((x) => x.score === null),
    ).toBe(true);
    expect(rec.attemptBody?.status).toBe("judge_error");
  });
});

describe("runRealScore — fetch failure", () => {
  it("marks attempt judge_error and writes no score rows when run_results is missing", async () => {
    installFetch({
      rec,
      runResultsEmpty: true,
      anthropic: () => ({ ok: true, json: async () => ({}) }),
    });

    const r = await runRealScore(baseArgs);
    expect(r.outcome).toBe("fetch_failed");
    expect(rec.anthropicCalls).toBe(0);
    expect(rec.scoresBody).toBeNull();
    expect(rec.attemptBody?.status).toBe("judge_error");
  });
});

describe("runRealScore — truncation backstop end to end", () => {
  it("suppresses a completeness flag on a truncated artifact so it is not a penalizing gap", async () => {
    const bigDesc = "x".repeat(600);
    const feat = (t: string) => ({
      title: t,
      description: bigDesc,
      rationale: "R " + bigDesc,
    });
    const hugePrdRow = {
      ...RR_ROW,
      prd: {
        productName: "P",
        oneLiner: "o",
        problem: "pr",
        targetUser: "u",
        features: {
          must_have: [feat("m1"), feat("m2"), feat("m3")],
          should_have: [feat("s1"), feat("s2")],
          could_have: [feat("c1"), feat("c2")],
          wont_have: [feat("w1"), feat("w2")],
        },
        competitiveLandscape: [{ competitor: "A", positioningDelta: bigDesc }],
      },
    };
    const mock = vi.fn(async (url: unknown, init?: { body?: string }) => {
      const u = String(url);
      if (u.includes("/run_results?")) {
        return { ok: true, json: async () => [hugePrdRow] } as unknown as Response;
      }
      if (u.includes("/rpc/increment_judge_cost")) {
        return { ok: true, text: async () => "" } as unknown as Response;
      }
      if (u.includes("/run_quality_scores?")) {
        rec.scoresBody = JSON.parse(init!.body!);
        return { ok: true, text: async () => "" } as unknown as Response;
      }
      if (u.includes("/run_quality_attempts?")) {
        rec.attemptBody = JSON.parse(init!.body!);
        return { ok: true, text: async () => "" } as unknown as Response;
      }
      if (u.includes("api.anthropic.com")) {
        return {
          ok: true,
          json: async () => ({
            stop_reason: "end_turn",
            usage: { input_tokens: 6000, output_tokens: 200 },
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  prd: {
                    qualitativeScore: 0.9,
                    flags: [
                      {
                        element: "completeness",
                        detail: "missing several features",
                      },
                    ],
                  },
                }),
              },
            ],
          }),
        } as unknown as Response;
      }
      return { ok: false, status: 500, text: async () => "" } as unknown as Response;
    });
    vi.stubGlobal("fetch", mock);

    const r = await runRealScore(baseArgs);
    expect(r.outcome).toBe("scored");
    const prdRow = (
      rec.scoresBody as {
        artifact_type: string;
        gaps: { reason: string }[];
      }[]
    ).find((x) => x.artifact_type === "prd")!;
    const llmFlagGaps = prdRow.gaps.filter((g) => g.reason === "llm_flag");
    expect(llmFlagGaps).toHaveLength(0);
  });
});
