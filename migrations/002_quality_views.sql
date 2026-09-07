-- ===========================================================================
-- migrations/002_quality_views.sql  (KAN-83 Phase 5a)
--
-- Four operator-only views. Views are canonical (ADR-035): anything displaying
-- quality data reads a view, never the raw tables. These sit over
-- run_quality_scores / run_quality_attempts / run_costs — all RLS-zero-policy,
-- three-role-revoked tables — so the views are reachable only via service-role
-- (operator). No Listener coupling; no user-facing surface.
--
-- Apply dev-first (ylqmqjiftgtsurziouep), verify, then prod on authorization.
--
-- A NOTE on view privileges: a view runs with its OWNER's rights by default
-- (security_invoker = off), so a service-role/postgres-owned view over these
-- tables is reachable by whoever can SELECT the view. We REVOKE from
-- public/anon/authenticated on each view to match the tables' posture — the
-- operator reads via service-role (which bypasses) or as postgres. This keeps
-- the "operator-only" guarantee intact rather than leaking through the view.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. quality_scores_summary — one row per scored run. The quality analog of the
--    cost summary. Pivots the five artifact scores into columns, plus verdict
--    mix, sample_reason, rubric_version, and the run's judge_usd from run_costs.
-- ---------------------------------------------------------------------------
create or replace view public.quality_scores_summary as
select
  s.run_id,
  s.rubric_version,
  max(s.sample_reason)                                              as sample_reason,
  min(s.created_at)                                                 as scored_at,
  max(score) filter (where s.artifact_type = 'prd')                as prd_score,
  max(score) filter (where s.artifact_type = 'brand')              as brand_score,
  max(score) filter (where s.artifact_type = 'jira')               as jira_score,
  max(score) filter (where s.artifact_type = 'confluence')         as confluence_score,
  max(score) filter (where s.artifact_type = 'research')           as research_score,
  count(*) filter (where s.verdict_status = 'scored')              as n_scored,
  count(*) filter (where s.verdict_status = 'artifact_absent')     as n_absent,
  count(*) filter (where s.verdict_status = 'judge_error')         as n_error,
  -- mean of the artifacts that were actually scored (nulls ignored by avg).
  round(avg(s.score), 3)                                           as mean_scored,
  c.judge_usd,
  c.judge_input_tokens,
  c.judge_output_tokens
from public.run_quality_scores s
left join public.run_costs c on c.run_id = s.run_id
group by s.run_id, s.rubric_version, c.judge_usd, c.judge_input_tokens, c.judge_output_tokens;

-- ---------------------------------------------------------------------------
-- 2. quality_gap_aggregate — THE harness view. Unnests gaps across all scored
--    runs, keeps ONLY actionable reasons (writer weaknesses), and ranks by
--    frequency per artifact_type + reason. v1 groups by (artifact_type, reason)
--    only — NOT by element — because llm_flag.element is free text from the
--    judge and grouping on it now fragments the ranking into phrasing noise.
--
--    EXCLUDED reasons (rubric limitations, not writer faults):
--      unrepresented_in_payload  (e.g. Confluence hierarchy — unscorable)
--      expected_field_absent     (pre-ADR-030 fields legitimately missing)
--      expected_under_ceiling    (64k Breakdown ceiling shortfall)
--    Only penalizing, fixable patterns remain: llm_flag, malformed_payload,
--    missing_required, unreachable_url.
-- ---------------------------------------------------------------------------
create or replace view public.quality_gap_aggregate as
select
  s.artifact_type,
  s.rubric_version,
  g.reason,
  count(*)                                    as gap_count,
  count(distinct s.run_id)                    as runs_affected,
  -- a few sample elements so the operator can see WHAT the bucket contains
  -- without committing to element-level grouping (that's the post-calibration
  -- refinement). Cap at 5 distinct to keep it readable.
  (array_agg(distinct g.element))[1:5]        as sample_elements
from public.run_quality_scores s
cross join lateral jsonb_to_recordset(s.gaps)
  as g(reason text, element text, detail text, penalizes boolean)
where s.verdict_status = 'scored'
  and g.penalizes is true
  and g.reason not in (
    'unrepresented_in_payload',
    'expected_field_absent',
    'expected_under_ceiling'
  )
group by s.artifact_type, s.rubric_version, g.reason
order by gap_count desc;

-- ---------------------------------------------------------------------------
-- 3. quality_score_distribution — per (artifact_type, rubric_version): count,
--    mean, min, max, stddev of scores. Two jobs: before/after comparison when a
--    writer prompt is changed and re-scored at a bumped rubric_version, and
--    making the Confluence structural floor explicit so it is not misread as a
--    writer defect. Only 'scored' rows (absent/error have null score).
-- ---------------------------------------------------------------------------
create or replace view public.quality_score_distribution as
select
  artifact_type,
  rubric_version,
  count(*)                          as n,
  round(avg(score), 3)             as mean_score,
  round(min(score), 3)             as min_score,
  round(max(score), 3)             as max_score,
  round(stddev_samp(score), 3)     as stddev_score
from public.run_quality_scores
where verdict_status = 'scored'
group by artifact_type, rubric_version
order by artifact_type, rubric_version;

-- ---------------------------------------------------------------------------
-- 4. quality_attempt_health — the judge's OWN reliability signal. Attempt rows
--    by status, plus the stuck-detector: 'started' rows older than a threshold
--    are crashed/dying judges (the "died after 202" signal KAN-83 exists to
--    make visible). Threshold is a view param via a WHERE the operator can
--    adjust; here we expose age so any threshold can be applied downstream.
-- ---------------------------------------------------------------------------
create or replace view public.quality_attempt_health as
select
  a.run_id,
  a.rubric_version,
  a.status,
  a.sample_reason,
  a.created_at,
  a.updated_at,
  round(extract(epoch from (now() - a.created_at)) / 60.0, 1) as age_minutes,
  -- flag: a 'started' attempt older than 10 min is almost certainly stuck
  -- (a live scoring completes in well under a minute). Operator queries this
  -- column; the 10 is the ADR-044 default (QUALITY_JUDGE_STUCK_MINUTES).
  (a.status = 'started'
     and a.created_at < now() - interval '10 minutes')          as likely_stuck
from public.run_quality_attempts a
order by a.created_at desc;

-- ---------------------------------------------------------------------------
-- Operator-only lockdown: match the underlying tables' posture. Revoke from
-- public/anon/authenticated so the views cannot leak data the tables protect.
-- (Owner + service_role retain access; service-role bypasses RLS on the base
-- tables, so operator reads work; anon/authenticated get nothing.)
-- ---------------------------------------------------------------------------
revoke all on public.quality_scores_summary     from public, anon, authenticated;
revoke all on public.quality_gap_aggregate      from public, anon, authenticated;
revoke all on public.quality_score_distribution from public, anon, authenticated;
revoke all on public.quality_attempt_health     from public, anon, authenticated;
