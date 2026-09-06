-- KAN-83 Phase 3a · run_quality_attempts
-- Operator-only attempt bookkeeping for the quality judge.
-- Idempotency key = PK (run_id, rubric_version).
-- Crash visibility = status='started' that never advances (detected by age).
-- Not a Listener type; not a sixth verdict_status; does not change five-row score policy (ADR-044 addendum).

create table public.run_quality_attempts (
  run_id          uuid not null references public.pipeline_runs(id) on delete cascade,
  rubric_version  text not null,
  status          text not null
                    check (status in ('started','scored','judge_error')),
  sample_reason   text not null check (sample_reason in ('calibration','sample')),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint run_quality_attempts_pk primary key (run_id, rubric_version)
);

alter table public.run_quality_attempts enable row level security;

-- ADR-027 footgun: REVOKE FROM PUBLIC alone is insufficient — anon/authenticated
-- inherit table privileges via default grants on these projects.
revoke all on public.run_quality_attempts from public, anon, authenticated;
