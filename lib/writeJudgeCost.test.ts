import { afterEach, describe, expect, it, vi } from "vitest";
import { writeJudgeCost } from "./writeJudgeCost";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("writeJudgeCost", () => {
  it("skips RPC when there is no spend", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const out = await writeJudgeCost({
      supabaseUrl: "https://example.supabase.co",
      serviceRoleKey: "service",
      runId: "11111111-1111-1111-1111-111111111111",
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
    });
    expect(out).toEqual({ ok: true, detail: "no-spend-skip" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("POSTs increment_judge_cost with p_run_id and token/cost params", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    const out = await writeJudgeCost({
      supabaseUrl: "https://example.supabase.co",
      serviceRoleKey: "service-role-key",
      runId: "22222222-2222-2222-2222-222222222222",
      inputTokens: 100,
      outputTokens: 50,
      costUsd: 0.001,
    });

    expect(out.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(call[0]).toBe(
      "https://example.supabase.co/rest/v1/rpc/increment_judge_cost",
    );
    expect(call[1].method).toBe("POST");
    const headers = call[1].headers as Record<string, string>;
    expect(headers.apikey).toBe("service-role-key");
    expect(headers.Authorization).toBe("Bearer service-role-key");
    expect(JSON.parse(String(call[1].body))).toEqual({
      p_run_id: "22222222-2222-2222-2222-222222222222",
      p_input_tokens: 100,
      p_output_tokens: 50,
      p_cost_usd: 0.001,
    });
  });
});
