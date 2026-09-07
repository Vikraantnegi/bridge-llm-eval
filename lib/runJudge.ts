// ---------------------------------------------------------------------------
// runJudge — 3c. The single Sonnet-5 call: one structured verdict for all five
// artifacts. Mirrors the n8n LLM Call node exactly (model, version, price) but
// lives IN the scorer and writes increment_judge_cost (never increment_run_cost).
//
// Contract:
//  - Input: PackedJudgeInput (already truncated + budgeted by packJudgeInput).
//  - If overHardStop -> do NOT call Anthropic; return judgeError (caller writes
//    judge_error rows in 3d).
//  - One POST to api.anthropic.com/v1/messages, model claude-sonnet-5,
//    anthropic-version 2023-06-01, max_tokens from config.MAX_TOKENS.
//  - stop_reason "max_tokens" -> judge_error (NO salvage of clipped JSON).
//  - Parse strict JSON: { prd|brand|jira|confluence|research: {qualitativeScore, flags[]} }.
//    Absent artifacts (present:false) are NOT sent to the model and get a null
//    verdict here so 3d writes them as artifact_absent, never scored.
//  - qualitativeScore agrees with flags: clamped to [0,1]; if the model returns
//    a score but no permission to exceed the deterministic ceiling, 3d's
//    combineScore enforces the ceiling. Here we only clamp + shape.
//  - ceiling shortfalls: the model is instructed to tag jira shortfalls it
//    believes are ceiling-driven via a flag whose element starts "ceiling:".
//    3c does NOT regex prose — the jira rubric already maps element~/ceiling/i
//    to expected_under_ceiling in 3d's merge. We keep the model's structured
//    flag; the mapping is structural, not prose-scraping.
//  - Returns per-artifact { verdict, wasTruncated } + token usage for cost.
// ---------------------------------------------------------------------------

import type { ArtifactType, LlmVerdict } from "../rubrics/types";
import type { PackedJudgeInput } from "./packJudgeInput";
import { MAX_TOKENS, JUDGE_MODEL, ANTHROPIC_VERSION, PRICE_IN_PER_M, PRICE_OUT_PER_M } from "./config";

export type PerArtifactJudge = {
  verdict: LlmVerdict | null; // null => artifact absent (not sent to model)
  wasTruncated: boolean;
};

export type JudgeOutcome =
  | {
      ok: true;
      perArtifact: Record<ArtifactType, PerArtifactJudge>;
      inputTokens: number;
      outputTokens: number;
      costUsd: number;
    }
  | {
      ok: false;
      reason: "over_hard_stop" | "max_tokens" | "parse_error" | "http_error" | "no_artifacts";
      detail?: string;
      // On http/parse error we may still have usage (for cost accounting of a
      // wasted call); on over_hard_stop there was no call so tokens are 0.
      inputTokens: number;
      outputTokens: number;
      costUsd: number;
    };

const ARTIFACT_KEYS: ArtifactType[] = ["prd", "brand", "jira", "confluence", "research"];

const costOf = (inTok: number, outTok: number): number =>
  (inTok / 1_000_000) * PRICE_IN_PER_M + (outTok / 1_000_000) * PRICE_OUT_PER_M;

const clamp01 = (n: unknown): number | null => {
  if (typeof n !== "number" || Number.isNaN(n)) return null;
  return Math.max(0, Math.min(1, n));
};

function buildSystemPrompt(): string {
  return [
    "You are a quality judge for AI-generated product artifacts. You score five artifact types against internal consistency and cross-artifact coherence.",
    "Output ONLY a single JSON object. No preamble, no markdown fences, no text after the JSON.",
    "",
    "For each artifact present in the input, emit: { \"qualitativeScore\": number 0..1, \"flags\": [{\"element\": string, \"detail\": string}] }.",
    "qualitativeScore: 1 = fully coherent/consistent; 0 = incoherent. Base it ONLY on what you can see.",
    "flags: specific qualitative issues (incoherence, off-voice, titles that do not relate to the PRD). Each flag names the element and a one-line detail.",
    "",
    "CRITICAL honesty rules:",
    "- If an object contains \"_truncated\": true, it was clipped to fit a budget. DO NOT flag missing or incomplete fields you cannot see. Judge ONLY the content present. Truncation is never a quality flag.",
    "- Do not reward or penalize length. A concise complete artifact scores as well as a verbose one.",
    "- qualitativeScore must agree with flags: many serious flags cannot coexist with a near-1 score.",
    "- For the jira artifact, if you believe fewer epics/stories than the PRD implies is a consequence of an output-size ceiling (not a quality defect), record a flag whose \"element\" begins with \"ceiling:\". Do not lower qualitativeScore for ceiling-driven shortfall.",
    "",
    "Only include keys for artifacts actually present in the input object. Do not invent artifacts.",
  ].join("\n");
}

function buildUserContent(packed: PackedJudgeInput): string {
  // Only present artifacts are sent. Map internal key 'research' stays 'research'
  // in the object; its value is the competitors payload.
  const payload: Record<string, unknown> = {};
  for (const k of ARTIFACT_KEYS) {
    const a = packed.artifacts[k];
    if (a.present) payload[k] = a.value;
  }
  return [
    "Score the following artifacts. Return one JSON object keyed by the artifact names present below.",
    "",
    JSON.stringify(payload),
  ].join("\n");
}

export async function runJudge(
  packed: PackedJudgeInput,
  apiKey: string,
): Promise<JudgeOutcome> {
  // Absent-everything guard: if no artifact is present, there is nothing to judge.
  const presentKeys = ARTIFACT_KEYS.filter((k) => packed.artifacts[k].present);
  if (presentKeys.length === 0) {
    return { ok: false, reason: "no_artifacts", inputTokens: 0, outputTokens: 0, costUsd: 0 };
  }

  if (packed.overHardStop) {
    return { ok: false, reason: "over_hard_stop", detail: `packed ${packed.totalChars} chars`, inputTokens: 0, outputTokens: 0, costUsd: 0 };
  }

  let res: Response;
  try {
    res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: JUDGE_MODEL,
        max_tokens: MAX_TOKENS,
        system: buildSystemPrompt(),
        messages: [{ role: "user", content: buildUserContent(packed) }],
      }),
    });
  } catch (e) {
    return { ok: false, reason: "http_error", detail: String(e), inputTokens: 0, outputTokens: 0, costUsd: 0 };
  }

  if (!res.ok) {
    return { ok: false, reason: "http_error", detail: `status ${res.status}`, inputTokens: 0, outputTokens: 0, costUsd: 0 };
  }

  const body = (await res.json()) as {
    content?: { type: string; text?: string }[];
    usage?: { input_tokens?: number; output_tokens?: number };
    stop_reason?: string;
  };

  const inputTokens = body.usage?.input_tokens ?? 0;
  const outputTokens = body.usage?.output_tokens ?? 0;
  const costUsd = costOf(inputTokens, outputTokens);

  // max_tokens stop => clipped output. Do NOT attempt to parse. judge_error.
  if (body.stop_reason === "max_tokens") {
    return { ok: false, reason: "max_tokens", inputTokens, outputTokens, costUsd };
  }

  const text = body.content?.find((b) => b.type === "text")?.text ?? "";
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text.replace(/```json|```/g, "").trim());
  } catch {
    return { ok: false, reason: "parse_error", detail: text.slice(0, 200), inputTokens, outputTokens, costUsd };
  }

  const perArtifact = {} as Record<ArtifactType, PerArtifactJudge>;
  for (const k of ARTIFACT_KEYS) {
    const a = packed.artifacts[k];
    if (!a.present) {
      perArtifact[k] = { verdict: null, wasTruncated: false };
      continue;
    }
    const raw = parsed[k] as { qualitativeScore?: unknown; flags?: unknown } | undefined;
    if (!raw || typeof raw !== "object") {
      // Model omitted a present artifact -> abstain (null score, no flags) so 3d
      // scores it deterministic-only rather than inventing an LLM verdict.
      perArtifact[k] = { verdict: { qualitativeScore: null, flags: [] }, wasTruncated: a.wasTruncated };
      continue;
    }
    const flags = Array.isArray(raw.flags)
      ? raw.flags
          .filter((f): f is { element?: unknown; detail?: unknown } => !!f && typeof f === "object")
          .map((f) => ({
            element: typeof f.element === "string" ? f.element : "unspecified",
            detail: typeof f.detail === "string" ? f.detail : undefined,
          }))
      : [];
    perArtifact[k] = {
      verdict: { qualitativeScore: clamp01(raw.qualitativeScore), flags },
      wasTruncated: a.wasTruncated,
    };
  }

  return { ok: true, perArtifact, inputTokens, outputTokens, costUsd };
}
