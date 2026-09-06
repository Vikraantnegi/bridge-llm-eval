// ---------------------------------------------------------------------------
// packJudgeInput — 3c. Builds the bounded user payload for the single judge
// call, per the signed-off prompt budget.
//
// Rules (ratified):
//  - Measure UTF-8 chars of JSON.stringify(slice). ~4 chars ~= 1 token.
//  - Per-artifact caps; trim in a fixed order; mark trimmed objects with
//    "_truncated": true so the model (and 3d's backstop) know completeness is
//    unobservable and must not be penalized.
//  - Transcript EXCLUDED in v1.
//  - Total artifact payload <= 40_000 chars; hard-reject the whole call if the
//    packed user message still exceeds 48_000 chars after truncation (caller
//    turns that into judge_error WITHOUT calling Anthropic).
//  - TRUNCATION IS PROMPT-PACKING ONLY. The deterministic tier (3b) always ran
//    on the FULL payload. This module never feeds the deterministic runner.
//
// PRD trim order (amended): drop competitiveLandscape, then could_have/wont_have,
// BEFORE feature rationale. Keep rationale on must_have as long as possible — it
// carries the transcript-grounding the judge relies on now that the transcript
// itself is excluded.
// ---------------------------------------------------------------------------

import type {
  RunResults,
  PrdResult,
  BrandResult,
  CompetitorsResult,
  JiraResult,
  ConfluenceResult,
} from "../types/run-results.mirror";
import type { ArtifactType } from "../rubrics/types";

export const PACK_CAPS: Record<ArtifactType, number> = {
  prd: 12_000,
  brand: 4_000,
  research: 12_000, // competitors
  jira: 8_000,
  confluence: 4_000,
};

export const TOTAL_ARTIFACT_CAP = 40_000;
export const PACKED_HARD_STOP = 48_000;

const size = (v: unknown): number => JSON.stringify(v ?? null).length;

// A packed artifact: the (possibly trimmed) object the model sees, plus whether
// it was truncated (threaded to 3d so completeness llm_flags can be suppressed).
export type PackedArtifact = {
  present: boolean;      // was the source non-null
  wasTruncated: boolean;
  value: unknown;        // null when absent; the trimmed object otherwise
};

export type PackedJudgeInput = {
  artifacts: Record<ArtifactType, PackedArtifact>;
  totalChars: number;
  // If true, caller must NOT call Anthropic — treat as judge_error. Set when the
  // packed payload still exceeds PACKED_HARD_STOP after all truncation.
  overHardStop: boolean;
};

// --- helpers ---------------------------------------------------------------
const clone = <T,>(v: T): T => (v == null ? v : JSON.parse(JSON.stringify(v)));
const mark = (o: Record<string, unknown>, extra?: Record<string, unknown>) => {
  o._truncated = true;
  if (extra) Object.assign(o, extra);
  return o;
};

// Each trimmer mutates a clone toward the cap by applying steps in order, only
// as far as needed. Returns { value, truncated }.
type Trimmed = { value: unknown; truncated: boolean };

function trimToCap(
  original: unknown,
  cap: number,
  steps: ((o: Record<string, unknown>) => void)[],
): Trimmed {
  if (original == null) return { value: null, truncated: false };
  if (size(original) <= cap) return { value: original, truncated: false };
  const o = clone(original) as Record<string, unknown>;
  for (const step of steps) {
    step(o);
    if (size(o) <= cap) break;
  }
  mark(o);
  return { value: o, truncated: true };
}

// --- PRD (amended trim order) ----------------------------------------------
function packPrd(prd: PrdResult): Trimmed {
  return trimToCap(prd, PACK_CAPS.prd, [
    (o) => { delete (o as PrdResult).competitiveLandscape; },           // 1st
    (o) => {                                                             // 2nd
      const f = (o as PrdResult).features;
      if (f) { delete f.could_have; delete f.wont_have; }
    },
    (o) => {                                                             // 3rd: should_have whole
      const f = (o as PrdResult).features;
      if (f) delete f.should_have;
    },
    (o) => {                                                             // 4th: rationale LAST (must_have)
      const f = (o as PrdResult).features;
      if (f?.must_have) for (const feat of f.must_have) delete (feat as Record<string, unknown>).rationale;
    },
  ]);
}

function packBrand(brand: BrandResult): Trimmed {
  return trimToCap(brand, PACK_CAPS.brand, [
    (o) => { delete (o as BrandResult).moodboardPrompt; delete (o as BrandResult).logoPrompt; },
    (o) => { delete (o as BrandResult).nameNotes; },
    (o) => { delete (o as BrandResult).logoDirection; delete (o as BrandResult).iconographyStyle; },
  ]);
}

function packCompetitors(comp: CompetitorsResult): Trimmed {
  const originalCount = comp.competitors?.length ?? 0;
  const t = trimToCap(comp, PACK_CAPS.research, [
    (o) => {                                                             // keep first 8 entries
      const c = o as CompetitorsResult;
      if (c.competitors && c.competitors.length > 8) c.competitors = c.competitors.slice(0, 8);
    },
    (o) => {                                                             // trim per-entry arrays
      const c = o as CompetitorsResult;
      for (const e of c.competitors ?? []) {
        delete (e as Record<string, unknown>).keyFeatures;
        delete (e as Record<string, unknown>).strengths;
        delete (e as Record<string, unknown>).weaknesses;
      }
    },
  ]);
  if (t.truncated) {
    const keptCount = (t.value as CompetitorsResult).competitors?.length ?? 0;
    if (keptCount < originalCount) {
      (t.value as Record<string, unknown>)._truncatedCompetitorCount = originalCount - keptCount;
    }
  }
  return t;
}

function packJira(jira: JiraResult): Trimmed {
  return trimToCap(jira, PACK_CAPS.jira, [
    (o) => {                                                             // keep first 40 stories
      const j = o as JiraResult;
      if (j.storiesCreated && j.storiesCreated.length > 40) j.storiesCreated = j.storiesCreated.slice(0, 40);
    },
    (o) => {                                                             // epics -> titles only (drop keys? no: keep keys, drop nothing else meaningful) -> stories to titles
      const j = o as JiraResult;
      if (j.storiesCreated) j.storiesCreated = j.storiesCreated.map((s) => ({ title: s.title, epic: s.epic }));
    },
  ]);
}

function packConfluence(conf: ConfluenceResult): Trimmed {
  return trimToCap(conf, PACK_CAPS.confluence, [
    (o) => {                                                             // keep first 30 pages, titles only
      const c = o as ConfluenceResult;
      if (c.pagesCreated) {
        c.pagesCreated = c.pagesCreated.slice(0, 30).map((p) => ({ title: p.title }));
      }
    },
  ]);
}

export function packJudgeInput(rr: RunResults): PackedJudgeInput {
  const build = (present: boolean, t: Trimmed): PackedArtifact => ({
    present,
    wasTruncated: t.truncated,
    value: present ? t.value : null,
  });

  const artifacts: Record<ArtifactType, PackedArtifact> = {
    prd: rr.prd ? build(true, packPrd(rr.prd)) : build(false, { value: null, truncated: false }),
    brand: rr.brand ? build(true, packBrand(rr.brand)) : build(false, { value: null, truncated: false }),
    research: rr.competitors ? build(true, packCompetitors(rr.competitors)) : build(false, { value: null, truncated: false }),
    jira: rr.jira ? build(true, packJira(rr.jira)) : build(false, { value: null, truncated: false }),
    confluence: rr.confluence ? build(true, packConfluence(rr.confluence)) : build(false, { value: null, truncated: false }),
  };

  const totalChars = (Object.keys(artifacts) as ArtifactType[])
    .reduce((sum, k) => sum + size(artifacts[k].value), 0);

  return { artifacts, totalChars, overHardStop: totalChars > PACKED_HARD_STOP };
}
