// ---------------------------------------------------------------------------
// filterTruncatedFlags — 3d. The code backstop for ratified amendment (2).
//
// When an artifact was truncated for the judge prompt (_truncated marking in
// 3c), the model is INSTRUCTED not to flag missing completeness it cannot see.
// This is the belt-and-suspenders CODE enforcement of that instruction: even if
// the model flags completeness anyway, we drop those flags BEFORE they reach the
// rubric, so the rubric never turns a truncation artifact into a penalizing
// llm_flag gap.
//
// Applied only when wasTruncated === true. The filtered LlmVerdict is then passed
// into the Phase-2 rubric (scorePrd/…), which does its own flag->gap conversion
// and calls combineScore internally. Filtering upstream of the rubric is what
// makes the suppression real — the rubric only ever sees surviving flags.
//
// Heuristic: a flag is a "completeness" flag if its element or detail signals
// missing / incomplete / truncated / "not enough" content. We keep genuine
// QUALITY flags (incoherence, off-voice, titles-don't-relate) untouched — those
// are judgeable on a clipped payload; completeness is not.
// ---------------------------------------------------------------------------

import type { LlmVerdict } from "../rubrics/types";

// Words that indicate the flag is about MISSING/INCOMPLETE content rather than a
// quality defect in the content that IS present.
const COMPLETENESS_PATTERNS: RegExp[] = [
  /\bmissing\b/i,
  /\bincomplete\b/i,
  /\btruncat/i,
  /\bcut off\b/i,
  /\bnot enough\b/i,
  /\btoo few\b/i,
  /\bfewer than\b/i,
  /\bonly \d+ (of|out of)\b/i,
  /\blacks?\b/i,
  /\bomitted\b/i,
  /\babsent\b/i,
  /\bshould (have|include) more\b/i,
  /\bexpected (more|additional)\b/i,
];

const looksLikeCompleteness = (f: { element: string; detail?: string }): boolean => {
  const hay = `${f.element} ${f.detail ?? ""}`;
  return COMPLETENESS_PATTERNS.some((re) => re.test(hay));
};

// Returns a verdict whose flags have completeness-style entries removed, but ONLY
// when the artifact was truncated. Never mutates the input. When not truncated,
// returns the verdict unchanged (quality flags always pass through).
export function filterTruncatedFlags(
  llm: LlmVerdict | null,
  wasTruncated: boolean,
): LlmVerdict | null {
  if (llm === null) return null;
  if (!wasTruncated) return llm;
  return {
    qualitativeScore: llm.qualitativeScore,
    flags: llm.flags.filter((f) => !looksLikeCompleteness(f)),
  };
}
