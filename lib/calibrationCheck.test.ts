import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  runVarianceProbe,
  probeCleanupSql,
} from "./calibrationCheck";

const RUN = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

type ScoreRow = {
  run_id: string;
  artifact_type: string;
  score: number | null;
  verdict_status: string;
};

function installFetch(opts: {
  baseScores: ScoreRow[];
  probeScores: ScoreRow[];
}) {
  const mock = vi.fn(async (url: unknown, init?: { method?: string }) => {
    const u = String(url);
    const method = init?.method ?? "GET";

    if (u.includes("/run_quality_scores?") && method === "GET") {
      const isProbe = u.includes("v1-probe1");
      return json(isProbe ? opts.probeScores : opts.baseScores);
    }
    if (u.includes("/run_quality_attempts") && method === "POST") {
      return { status: 201, ok: true, text: async () => "" } as unknown as Response;
    }
    // runRealScore path: run_results + anthropic + scores upsert + attempt PATCH + cost
    if (u.includes("/run_results?")) {
      return json([
        {
          prd: {
            productName: "P",
            oneLiner: "o",
            problem: "p",
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
        },
      ]);
    }
    if (u.includes("api.anthropic.com")) {
      return json({
        stop_reason: "end_turn",
        usage: { input_tokens: 100, output_tokens: 50 },
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
      });
    }
    if (u.includes("/rpc/increment_judge_cost")) {
      return { ok: true, text: async () => "" } as unknown as Response;
    }
    if (u.includes("/run_quality_scores?") && method === "POST") {
      return { ok: true, text: async () => "" } as unknown as Response;
    }
    if (u.includes("/run_quality_attempts") && method === "PATCH") {
      return { ok: true, text: async () => "" } as unknown as Response;
    }
    return {
      ok: false,
      status: 500,
      text: async () => "unexpected " + u,
    } as unknown as Response;
  });
  vi.stubGlobal("fetch", mock);
}

const json = (v: unknown) =>
  ({
    ok: true,
    status: 200,
    json: async () => v,
    text: async () => JSON.stringify(v),
  }) as unknown as Response;

beforeEach(() => {
  vi.unstubAllGlobals();
});
afterEach(() => vi.unstubAllGlobals());

describe("runVarianceProbe", () => {
  it("returns ok:false when runIds is empty", async () => {
    const r = await runVarianceProbe({
      env: { supabaseUrl: "https://x", serviceRoleKey: "k" },
      anthropicApiKey: "a",
      baseVersion: "v1",
      runIds: [],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.detail).toMatch(/no run_ids/);
  });

  it("computes max|Δ| / mean|Δ| in the stable band (~0.033)", async () => {
    // Probe path still calls runRealScore, but comparison uses the second
    // fetchScores response (probeScores) — fixture deltas stay under 0.05.
    const baseScores: ScoreRow[] = [
      { run_id: RUN, artifact_type: "prd", score: 0.91, verdict_status: "scored" },
      { run_id: RUN, artifact_type: "brand", score: 0.96, verdict_status: "scored" },
      { run_id: RUN, artifact_type: "jira", score: 0.94, verdict_status: "scored" },
      { run_id: RUN, artifact_type: "confluence", score: 0.833, verdict_status: "scored" },
      { run_id: RUN, artifact_type: "research", score: 0.925, verdict_status: "scored" },
    ];
    const probeScores: ScoreRow[] = [
      { run_id: RUN, artifact_type: "prd", score: 0.9, verdict_status: "scored" },
      { run_id: RUN, artifact_type: "brand", score: 0.95, verdict_status: "scored" },
      { run_id: RUN, artifact_type: "jira", score: 0.93, verdict_status: "scored" },
      { run_id: RUN, artifact_type: "confluence", score: 0.8, verdict_status: "scored" }, // |Δ|=0.033
      { run_id: RUN, artifact_type: "research", score: 0.92, verdict_status: "scored" },
    ];
    installFetch({ baseScores, probeScores });

    const r = await runVarianceProbe({
      env: { supabaseUrl: "https://x", serviceRoleKey: "k" },
      anthropicApiKey: "a",
      baseVersion: "v1",
      runIds: [RUN],
      probeLabel: "probe1",
    });

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.probeVersion).toBe("v1-probe1");
    expect(r.comparedPairs).toBe(5);
    expect(r.maxAbsDelta).toBe(0.033);
    expect(r.maxAbsDelta).toBeLessThanOrEqual(0.05);
    expect(r.meanAbsDelta).toBeGreaterThan(0);
    expect(r.meanAbsDelta).toBeLessThanOrEqual(0.05);
  });
});

describe("probeCleanupSql", () => {
  it("emits deletes for scores and attempts at the probe version", () => {
    const sql = probeCleanupSql("v1-probe1");
    expect(sql).toContain(
      "delete from public.run_quality_scores where rubric_version = 'v1-probe1'",
    );
    expect(sql).toContain(
      "delete from public.run_quality_attempts where rubric_version = 'v1-probe1'",
    );
  });
});
