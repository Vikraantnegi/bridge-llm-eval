import type { FastifyInstance } from "fastify";
import type { AttemptsStore } from "../../lib/attempts";
import { makeCheckUrl } from "../../lib/checkUrl";
import type { JudgeConfig } from "../../lib/config";
import { RUBRIC_VERSION } from "../../lib/config";
import { runGate } from "../../lib/gate";
import { verifyScoreSignature } from "../../lib/hmac";
import {
  runRealScore,
  type RunScoreArgs,
  type RunScoreResult,
} from "../../lib/runRealScore";

export type ScoreWork = (args: RunScoreArgs) => Promise<RunScoreResult>;

export type ScoreRouteDeps = {
  config: JudgeConfig;
  store: AttemptsStore;
  random?: () => number;
  now?: () => Date;
  /** Defaults to runRealScore; inject in tests to avoid live I/O. */
  scoreWork?: ScoreWork;
};

type ScoreBody = { run_id?: string };

export const registerScoreRoute = (
  app: FastifyInstance,
  deps: ScoreRouteDeps,
): void => {
  app.post<{ Body: ScoreBody }>("/score", async (req, reply) => {
    const runId = typeof req.body?.run_id === "string" ? req.body.run_id.trim() : "";
    if (!runId) {
      return reply.code(401).send({ status: "unauthorized" });
    }

    const signatureHeader = String(req.headers["x-murmur-signature"] ?? "");
    const timestamp = String(req.headers["x-murmur-timestamp"] ?? "");
    const ok = verifyScoreSignature({
      runId,
      timestamp,
      signatureHeader,
      secret: deps.config.hmacSecret,
    });
    if (!ok) {
      return reply.code(401).send({ status: "unauthorized" });
    }

    // 202-then-work: respond before gate / scoring.
    reply.code(202).send({ status: "accepted", run_id: runId });

    setImmediate(() => {
      void (async () => {
        try {
          await processScore(runId, deps);
        } catch (err) {
          console.error(
            JSON.stringify({
              event: "score_async_error",
              run_id: runId,
              error: err instanceof Error ? err.message : String(err),
            }),
          );
        }
      })();
    });
  });
};

export const processScore = async (
  runId: string,
  deps: ScoreRouteDeps,
): Promise<void> => {
  const gate = await runGate(runId, {
    config: deps.config,
    store: deps.store,
    random: deps.random,
    now: deps.now,
  });

  console.log(
    JSON.stringify({
      event: "gate_outcome",
      run_id: runId,
      outcome: gate.outcome,
      detail: "detail" in gate ? gate.detail : undefined,
    }),
  );

  if (gate.outcome !== "proceed") return;

  const insert = await deps.store.insertStarted({
    runId,
    rubricVersion: RUBRIC_VERSION,
    sampleReason: gate.sampleReason,
  });
  if (insert === "conflict") {
    console.log(
      JSON.stringify({
        event: "gate_outcome",
        run_id: runId,
        outcome: "in_flight",
        detail: "insert_conflict",
      }),
    );
    return;
  }

  const scoreWork = deps.scoreWork ?? runRealScore;
  try {
    const result = await scoreWork({
      env: {
        supabaseUrl: deps.config.supabaseUrl,
        serviceRoleKey: deps.config.supabaseServiceRoleKey,
      },
      anthropicApiKey: deps.config.anthropicApiKey,
      runId,
      rubricVersion: RUBRIC_VERSION,
      sampleReason: gate.sampleReason,
      checkUrl: makeCheckUrl(),
    });
    console.log(
      JSON.stringify({
        event: "score_work_outcome",
        run_id: runId,
        outcome: result.outcome,
        detail:
          "detail" in result
            ? result.detail
            : "reason" in result
              ? result.reason
              : undefined,
      }),
    );
  } catch (err) {
    await deps.store.updateStatus({
      runId,
      rubricVersion: RUBRIC_VERSION,
      status: "judge_error",
    });
    throw err;
  }
};
