import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import type { AttemptRow, AttemptsStore } from "../../lib/attempts";
import type { JudgeConfig } from "../../lib/config";
import { signScoreRequest } from "../../lib/hmac";
import { processScore, registerScoreRoute } from "./score";

const SECRET = "route-secret";
const RUN = "33333333-3333-3333-3333-333333333333";

const config = (over: Partial<JudgeConfig> = {}): JudgeConfig => ({
  calibrationAuthorized: true,
  maxUsd: 25,
  sampleRate: 1,
  stuckMinutes: 10,
  hmacSecret: SECRET,
  supabaseUrl: "http://example.invalid",
  supabaseServiceRoleKey: "service",
  anthropicApiKey: "anthropic-test-key",
  port: 8787,
  ...over,
});

const memoryStore = (): AttemptsStore & { rows: Map<string, AttemptRow> } => {
  const rows = new Map<string, AttemptRow>();
  return {
    rows,
    async getAttempt(runId, rubricVersion) {
      return rows.get(`${runId}:${rubricVersion}`) ?? null;
    },
    async insertStarted({ runId, rubricVersion, sampleReason }) {
      const key = `${runId}:${rubricVersion}`;
      if (rows.has(key)) return "conflict";
      const now = new Date().toISOString();
      rows.set(key, {
        run_id: runId,
        rubric_version: rubricVersion,
        status: "started",
        sample_reason: sampleReason,
        created_at: now,
        updated_at: now,
      });
      return "inserted";
    },
    async updateStatus({ runId, rubricVersion, status }) {
      const key = `${runId}:${rubricVersion}`;
      const row = rows.get(key);
      if (!row) return;
      rows.set(key, {
        ...row,
        status,
        updated_at: new Date().toISOString(),
      });
    },
    async sumJudgeUsd() {
      return 0;
    },
  };
};

describe("POST /score", () => {
  const apps: { close: () => Promise<void> }[] = [];
  afterEach(async () => {
    while (apps.length) {
      await apps.pop()!.close();
    }
  });

  it("returns 401 when HMAC fails and writes nothing", async () => {
    const store = memoryStore();
    const app = Fastify();
    registerScoreRoute(app, { config: config(), store });
    apps.push(app);
    const res = await app.inject({
      method: "POST",
      url: "/score",
      headers: {
        "x-murmur-signature": "v1=deadbeef",
        "x-murmur-timestamp": String(Math.floor(Date.now() / 1000)),
      },
      payload: { run_id: RUN },
    });
    expect(res.statusCode).toBe(401);
    expect(store.rows.size).toBe(0);
  });

  it("returns 202 then runs scoreWork on proceed", async () => {
    const store = memoryStore();
    const app = Fastify();
    registerScoreRoute(app, {
      config: config(),
      store,
      random: () => 0,
      scoreWork: async ({ runId, rubricVersion }) => {
        await store.updateStatus({
          runId,
          rubricVersion,
          status: "scored",
        });
        return { outcome: "scored" };
      },
    });
    apps.push(app);
    const { signatureHeader, timestamp } = signScoreRequest(RUN, SECRET);
    const res = await app.inject({
      method: "POST",
      url: "/score",
      headers: {
        "x-murmur-signature": signatureHeader,
        "x-murmur-timestamp": String(timestamp),
      },
      payload: { run_id: RUN },
    });
    expect(res.statusCode).toBe(202);

    await new Promise((r) => setTimeout(r, 20));
    const row = store.rows.get(`${RUN}:v1`);
    expect(row?.status).toBe("scored");
    expect(row?.sample_reason).toBe("calibration");
  });
});

describe("processScore skips", () => {
  it("not_authorized writes zero rows", async () => {
    const store = memoryStore();
    await processScore(RUN, {
      config: config({ calibrationAuthorized: false }),
      store,
      scoreWork: async () => {
        throw new Error("scoreWork must not run");
      },
    });
    expect(store.rows.size).toBe(0);
  });
});
