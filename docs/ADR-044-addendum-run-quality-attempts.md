# ADR-044 addendum — `run_quality_attempts` (KAN-83 Phase 3a)

Paste onto Confluence page **74055725** (ADR-044). Index pointer row on parent **22970369** remains a separate by-hand edit.

---

## Addendum: attempt bookkeeping (Phase 3a)

Operator-only table `public.run_quality_attempts` records that the quality judge **proceeded** for a `(run_id, rubric_version)`. It is **not** a Listener type, **not** a sixth `verdict_status`, and **does not** change the five-row `run_quality_scores` insert policy.

- **PK** `(run_id, rubric_version)` is the idempotency key: a second dispatch collides on insert rather than double-spending Anthropic.
- **`status`** is only `started` | `scored` | `judge_error`. A process death after `202` leaves `started` forever; operators detect stuck judges by age (`created_at` older than `QUALITY_JUDGE_STUCK_MINUTES`), not by a fourth status.
- Skip outcomes (`not_authorized`, `over_budget`, `not_sampled`) write **zero** attempt rows and **zero** score rows.
- RLS on, zero policies; revoke from `public`, `anon`, and `authenticated` (same posture as `run_quality_scores` / `run_costs`). Retention shares the run (`ON DELETE CASCADE`, ADR-018).
