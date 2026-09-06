// ---------------------------------------------------------------------------
// MIRROR — DO NOT EDIT BY HAND EXCEPT TO RE-SYNC.
//
// MIRROR_OF: listener/types/run-results.ts
// MIRROR_SHA: 7f82ddf5bc737de4469096989ac0f0efb44f5728
//
// This is a byte-exact copy of the canonical run_results contract, which lives
// ONLY in the listener repo (a private Next app; nothing is importable as an
// @sprintzero/* package). The scorer runs on the Bridge/pipeline-worker side
// and MUST NOT import from listener (ADR-044: the judge ships no Listener
// coupling). So we mirror.
//
// A mirror does NOT give the cross-repo type-system guarantee we chose TS for:
// if the canonical file renames nonGoals, THIS file still compiles against its
// own stale copy and the rubrics would silently score a field that no longer
// exists. That guarantee is restored OUT OF BAND by scripts/check-run-results-
// mirror.mjs, which fails CI when (1) this body is not byte-identical to
// canonical @ MIRROR_SHA, OR (2) MIRROR_SHA is not the commit that last touched
// canonical (i.e. canonical moved and nobody re-mirrored). Both assertions are
// required; assertion (1) alone only proves a faithful copy of a FROZEN version.
//
// To re-sync: copy the new canonical body verbatim, update MIRROR_SHA to
// git log -1 --format=%H -- types/run-results.ts from the listener clone, and
// let the check pass.
// ---------------------------------------------------------------------------

//
// Shapes of the run_results jsonb columns, mirroring the Bridge's real Parse-node
// output (verified against a live SoloBox run). Field names are the real agent
// output — do not transform. All fields optional: a column is absent until its
// stage completes (ADR-021), and an agent can produce a partial/empty payload.

export type PrdFeature = {
  title?: string;
  description?: string;
  rationale?: string;
};

export type PrdSuccessMetric = { metric?: string; target?: string };

export type PrdResult = {
  productName?: string;
  oneLiner?: string;
  problem?: string;
  targetUser?: string;
  features?: {
    must_have?: PrdFeature[];
    should_have?: PrdFeature[];
    could_have?: PrdFeature[];
    wont_have?: PrdFeature[];
  };
  successMetrics?: PrdSuccessMetric[];
  openQuestions?: string[];
  nonGoals?: string[];
  risks?: string[];
  competitiveLandscape?: {
    competitor?: string;
    positioningDelta?: string;
  }[];
};

export type CompetitorEntry = {
  name?: string;
  url?: string;
  positioning?: string;
  keyFeatures?: string[];
  pricingModel?: string;
  strengths?: string[];
  weaknesses?: string[];
  /** Agents sometimes emit a numeric score instead of High/Medium/Low copy. */
  directOverlap?: string | number;
};

export type CompetitorsResult = {
  competitors?: CompetitorEntry[];
  marketSummary?: string;
  ourPositioning?: string;
  tableStakes?: string[];
  differentiationOpportunities?: string[];
};

export type BrandColorPalette = {
  primary?: string;
  secondary?: string;
  accent?: string;
  neutral?: string;
  semantic?: Record<string, string>;
};

export type BrandTypography = {
  heading?: string;
  body?: string;
  mono?: string;
};

export type BrandLogoDirection = {
  form?: string;
  style?: string;
  symbolConcept?: string;
  avoidances?: string[];
};

export type BrandResult = {
  brandName?: string;
  nameNotes?: string[];
  tagline?: string;
  brandValues?: string[];
  colorPalette?: BrandColorPalette;
  typography?: BrandTypography;
  logoDirection?: BrandLogoDirection;
  logoPrompt?: string;
  iconographyStyle?: string;
  moodboardPrompt?: string;
};

export type EngineeringComponent = { name?: string; responsibility?: string };

export type EngineeringTask = { title?: string; description?: string };

export type EngineeringResult = {
  hld?: {
    overview?: string;
    dataFlow?: string;
    components?: EngineeringComponent[];
  };
  dataModels?: unknown[];
  schemaSql?: string;
  schemaTypescript?: string;
  techStack?: Record<string, string>;
  engineeringTasks?: EngineeringTask[];
  openEngineeringQuestions?: string[];
};

export type JiraResult = {
  success?: boolean;
  siteUrl?: string;
  projectKey?: string;
  projectName?: string;
  epicsCreated?: { key?: string; title?: string }[];
  storiesCreated?: {
    key?: string;
    epic?: string;
    title?: string;
    phase?: string;
  }[];
};

export type ConfluencePage = { title?: string; id?: string };

export type ConfluenceResult = {
  success?: boolean;
  spaceKey?: string;
  homepageId?: string;
  pagesCreated?: ConfluencePage[];
  spaceUrl?: string;
};

export type RunResults = {
  transcript: string | null;
  prd: PrdResult | null;
  competitors: CompetitorsResult | null;
  brand: BrandResult | null;
  engineering: EngineeringResult | null;
  jira: JiraResult | null;
  confluence: ConfluenceResult | null;
};
