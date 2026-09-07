import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { runBatch, type BatchConfig } from "./runBatch";

// Routed fetch mock covering: pipeline_runs select, run_quality_attempts select
// + insert, run_costs judge_usd.sum, run_results, increment_judge_cost,
// run_quality_scores upsert, attempt PATCH, Anthropic.
type Ctl = {
  doneIds: string[];
  attemptRunIds: string[]; // already-claimed
  judgeUsdSum: number; // aggregate sum(judge_usd)
  insertConflict: boolean; // force 409 on attempt insert
  anthropicText: string;
  inserted: string[];
};

function install(ctl: Ctl) {
  const mock = vi.fn(async (url: unknown, init?: { method?: string; body?: string }) => {
    const u = String(url);
    const method = init?.method ?? "GET";
    if (u.includes("/pipeline_runs?")) {
      return json(
        ctl.doneIds.map((id, i) => ({
          id,
          completed_at: `2026-01-0${(i % 9) + 1}T00:00:00Z`,
        })),
      );
    }
    if (u.includes("/run_quality_attempts?") && method === "GET") {
      return json(ctl.attemptRunIds.map((run_id) => ({ run_id })));
    }
    if (u.includes("/run_quality_attempts") && method === "POST") {
      if (ctl.insertConflict) {
        return { status: 409, ok: false, text: async () => "conflict" } as unknown as Response;
      }
      const b = JSON.parse(init!.body!);
      ctl.inserted.push(b.run_id);
      return { status: 201, ok: true, text: async () => "" } as unknown as Response;
    }
    if (u.includes("/run_quality_attempts") && method === "PATCH") {
      return { ok: true, text: async () => "" } as unknown as Response;
    }
    if (u.includes("/run_costs?select=judge_usd")) {
      return json([{ judge_usd: ctl.judgeUsdSum }]);
    }
    if (u.includes("/rpc/increment_judge_cost")) {
      return { ok: true, text: async () => "" } as unknown as Response;
    }
    if (u.includes("/run_results?") && u.includes("select=run_id")) {
      // Selection: which done ids have a results row (all, in these tests).
      return json(ctl.doneIds.map((run_id) => ({ run_id })));
    }
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
    if (u.includes("/run_quality_scores?")) {
      return { ok: true, text: async () => "" } as unknown as Response;
    }
    if (u.includes("api.anthropic.com")) {
      return json({
        stop_reason: "end_turn",
        usage: { input_tokens: 4000, output_tokens: 300 },
        content: [{ type: "text", text: ctl.anthropicText }],
      });
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

const baseCfg = (over: Partial<BatchConfig> = {}): BatchConfig => ({
  env: { supabaseUrl: "https://dev", serviceRoleKey: "k" },
  envName: "dev",
  anthropicApiKey: "a",
  rubricVersion: "v1",
  sinceHours: 24,
  calibrationAuthorized: true,
  sampleRate: 1.0,
  maxUsd: 25,
  ...over,
});

const goodVerdict = JSON.stringify({
  prd: { qualitativeScore: 0.9, flags: [] },
  jira: { qualitativeScore: 1, flags: [] },
  research: { qualitativeScore: 0.8, flags: [] },
});

let ctl: Ctl;
beforeEach(() => {
  ctl = {
    doneIds: [],
    attemptRunIds: [],
    judgeUsdSum: 0,
    insertConflict: false,
    anthropicText: goodVerdict,
    inserted: [],
  };
});
afterEach(() => vi.unstubAllGlobals());

describe("runBatch — prod double lock", () => {
  it("refuses prod without calibration authorized, even with --env prod", async () => {
    install(ctl);
    const r = await runBatch(baseCfg({ envName: "prod", calibrationAuthorized: false }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.detail).toMatch(/CALIBRATION_AUTHORIZED/);
  });
  it("allows prod when authorized", async () => {
    ctl.doneIds = [];
    install(ctl);
    const r = await runBatch(baseCfg({ envName: "prod", calibrationAuthorized: true }));
    expect(r.ok).toBe(true);
  });
});

describe("runBatch — null check", () => {
  it("clean exit with zero eligible runs, no anthropic call", async () => {
    ctl.doneIds = [];
    install(ctl);
    const r = await runBatch(baseCfg());
    expect(r.ok && r.summary.eligible).toBe(0);
    expect(r.ok && r.summary.scored).toBe(0);
  });
  it("skips already-attempted runs (selection idempotency)", async () => {
    ctl.doneIds = ["r1", "r2"];
    ctl.attemptRunIds = ["r1"]; // r1 already claimed
    install(ctl);
    const r = await runBatch(baseCfg());
    expect(r.ok && r.summary.eligible).toBe(1); // only r2
    expect(ctl.inserted).toEqual(["r2"]);
  });
});

describe("runBatch — success", () => {
  it("scores eligible runs and inserts an attempt each", async () => {
    ctl.doneIds = ["r1", "r2"];
    install(ctl);
    const r = await runBatch(baseCfg());
    expect(r.ok && r.summary.scored).toBe(2);
    expect(ctl.inserted.sort()).toEqual(["r1", "r2"]);
  });
});

describe("runBatch — budget guard", () => {
  it("stops the batch once sum(judge_usd) >= maxUsd", async () => {
    ctl.doneIds = ["r1", "r2"];
    ctl.judgeUsdSum = 30; // already over the $25 cap
    install(ctl);
    const r = await runBatch(baseCfg({ maxUsd: 25 }));
    expect(r.ok && r.summary.stoppedOverBudget).toBe(true);
    expect(r.ok && r.summary.scored).toBe(0);
  });
});

describe("runBatch — sample gate", () => {
  it("skips runs below the sample rate", async () => {
    ctl.doneIds = ["r1", "r2", "r3", "r4"];
    install(ctl);
    const spy = vi.spyOn(Math, "random").mockReturnValue(0.99); // always above 0.15
    const r = await runBatch(baseCfg({ sampleRate: 0.15 }));
    spy.mockRestore();
    expect(r.ok && r.summary.skippedSample).toBe(4);
    expect(r.ok && r.summary.scored).toBe(0);
  });
});

describe("runBatch — claim conflict", () => {
  it("skips a run whose attempt insert 409s (concurrent claim)", async () => {
    ctl.doneIds = ["r1"];
    ctl.insertConflict = true;
    install(ctl);
    const r = await runBatch(baseCfg());
    expect(r.ok && r.summary.skippedClaimed).toBe(1);
    expect(r.ok && r.summary.scored).toBe(0);
  });
});
