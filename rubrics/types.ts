// ---------------------------------------------------------------------------
// Scoring types shared by all five artifact rubrics.
//
// These shapes map onto the run_quality_scores table (ADR-044 / KAN-83):
//   score          -> RubricResult.score        (null unless verdict='scored')
//   verdict_status  -> RubricResult.verdict
//   coverage        -> RubricResult.coverage     (jsonb)
//   gaps            -> RubricResult.gaps          (jsonb)
// Per-row token/cost columns are populated by the scorer (Phase 3), not here —
// the shared one LLM call's cost is billed once to run_costs.judge_usd, NOT
// split across rows (ADR-044 clause f).
//
// A rubric NEVER decides sampling, NEVER writes the DB, NEVER calls finalize.
// It is a pure function: (payload slice, optional LLM verdict) -> RubricResult.
// The scorer owns: sampling gate, the single LLM call, persistence, cost. And
// the "no prod writes until calibration is authorized" invariant lives in the
// scorer (Phase 3), never in these files.
// ---------------------------------------------------------------------------

export type ArtifactType = "prd" | "brand" | "jira" | "confluence" | "research";

// Mirrors run_quality_scores.verdict_status CHECK exactly.
export type VerdictStatus = "scored" | "artifact_absent" | "judge_error";

// Every coverage line is one expected element and whether the payload has it.
// "partial" = present but incomplete (e.g. a feature with a title but no
// description). Deterministic checks set this; the LLM tier never overrides a
// deterministic "absent" to "present".
export type CoverageState = "present" | "absent" | "partial";

export type CoverageItem = {
  element: string; // human-readable expected element, e.g. "must_have features"
  state: CoverageState;
  detail?: string; // e.g. "3 of 5 features missing description"
};

// Reason codes are a CLOSED enum so the dataset is queryable. Adding a reason is
// a deliberate rubric change (rubric_version bump), not an ad-hoc string.
//
//  expected_under_ceiling   Shortfall that is the KNOWN consequence of the 64K
//                           Breakdown max_tokens ceiling on large ideas
//                           (ADR-041 / ADR-033 note). A FLAG, never a score
//                           penalty (ADR-044 clause d). e.g. fewer epics than
//                           PRD features on a big transcript.
//  expected_field_absent    A field that legitimately may not exist because the
//                           run predates the field (pre-ADR-030 runs lack
//                           successMetrics/openQuestions/nonGoals/risks). A
//                           flag, not a penalty.
//  unrepresented_in_payload A rubric concept the CLAIMED-WRITE payload simply
//                           cannot express, so it is NOT scored — recorded so
//                           the omission is visible, not silently dropped.
//                           e.g. PRD "constraints" (no field); Confluence page
//                           "hierarchy" (ConfluenceResult is a flat {title,id}[]
//                           with no parent graph — scoring it would need a
//                           tenant crawl, which is out of scope, ADR-044 b).
//  malformed_payload        The payload violates its own contract, e.g. a story
//                           whose `epic` matches no epicsCreated[].key (orphan),
//                           or an epic with no key. This IS a quality signal and
//                           DOES affect score.
//  missing_required         A required element is absent on a run where it
//                           should exist (distinct from expected_field_absent).
//  unreachable_url          A research citation URL failed HEAD/GET (invented or
//                           dead). Affects score — "citations real and openable".
//  llm_flag                 A qualitative issue the LLM tier raised (incoherence,
//                           off-voice, title/PRD mismatch). Affects score.
export type GapReason =
  | "expected_under_ceiling"
  | "expected_field_absent"
  | "unrepresented_in_payload"
  | "malformed_payload"
  | "missing_required"
  | "unreachable_url"
  | "llm_flag";

export type Gap = {
  reason: GapReason;
  element: string; // what the gap is about
  detail?: string;
  // penalizes: does this gap reduce score? expected_* and unrepresented_* are
  // ALWAYS false (flags, not penalties). The rubric sets this explicitly so the
  // score math is auditable from the persisted row.
  penalizes: boolean;
};

export type RubricResult = {
  artifactType: ArtifactType;
  rubricVersion: string; // git tag of the rubric files; e.g. "v1"
  verdict: VerdictStatus;
  // score is null unless verdict === "scored" (run_quality_scores CHECK enforces
  // this at the DB too). 0 means judged-and-failed; null means not judged.
  score: number | null;
  coverage: CoverageItem[];
  gaps: Gap[];
};

// The optional LLM verdict a rubric may consume for its qualitative tier. The
// scorer produces this from the single shared judge call and hands the relevant
// slice to each rubric. A rubric with no LLM input still returns a valid
// deterministic-only result (LLM tier simply contributes no gaps).
export type LlmVerdict = {
  // 0..1 qualitative quality for this artifact, or null if the judge abstained.
  qualitativeScore: number | null;
  // structured issues the judge raised; become llm_flag gaps.
  flags: { element: string; detail?: string }[];
};

// v1 scoring (KAN-83): the LLM tier MUST NOT raise score above the
// deterministic result — it can only scale WITHIN what determinism allows.
// A malformed payload (detScore low) cannot be rescued by good prose.
//   no LLM / abstain -> score = detScore
//   q in [0,1]       -> score = detScore * (0.5 + 0.5 * q)
// Perfect det + terrible judge -> 0.5*det; perfect det + perfect judge -> det;
// empty artifact stays 0. q is clamped so a model emitting 1.2 cannot push
// score above detScore.
export const combineScore = (detScore: number, llm?: LlmVerdict): number => {
  if (!llm || llm.qualitativeScore === null) return detScore;
  const q = Math.min(1, Math.max(0, llm.qualitativeScore));
  return detScore * (0.5 + 0.5 * q);
};

export const absent = (
  artifactType: ArtifactType,
  rubricVersion: string,
  coverage: CoverageItem[] = [],
): RubricResult => ({
  artifactType,
  rubricVersion,
  verdict: "artifact_absent",
  score: null,
  coverage,
  gaps: [],
});

export const errored = (
  artifactType: ArtifactType,
  rubricVersion: string,
): RubricResult => ({
  artifactType,
  rubricVersion,
  verdict: "judge_error",
  score: null,
  coverage: [],
  gaps: [],
});
