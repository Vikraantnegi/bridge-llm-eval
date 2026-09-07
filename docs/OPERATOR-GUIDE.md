# KAN-83 — Quality Judge: Operator Guide (5c)

> **Hand-maintained page. No automation writes here.** Paste this into Confluence
> as a child of the KAN-83 / analytics space. It is the "how to actually use the
> quality dataset" companion to the views (5a) and the calibration check (5b).

---

## What this dataset is — and is not

The quality judge (ADR-044) scores delivered artifacts into `run_quality_scores`
as an **observational** dataset. It exists to answer ONE question over time:
*"when I change a writer-agent prompt, did the artifacts get better or worse?"*

It is **not** a grade, **not** a gate, **not** shown to users, and **not** a
target to optimize. Reading it wrong is worse than not having it.

---

## Rule 1 — Read the gaps, not the score

A score (`0.91`) tells you *where to look*. It is a number on an uncalibrated
scale; its only meaning is comparison to other numbers on the same scale.

The **`gaps`** tell you *what is actually wrong* — the specific, structured
issues the judge flagged. That is the actionable signal. Use
`quality_gap_aggregate` to see the top recurring gap classes per artifact type.

Then — always — **open the artifact and confirm the gap is real** with your own
eyes. The judge is an LLM; a flag is a hypothesis, not a fact.

Workflow: aggregate gaps → pick the most common actionable one → read those
artifacts → decide if it is a real writer weakness → fix ONE writer prompt →
re-score at a bumped `rubric_version` → confirm the gap dropped **and** the
artifacts genuinely improved.

---

## Rule 2 — The Confluence floor is structural. Do not chase it.

Confluence scores sit systematically lower than the others (seen from the first
runs: ~0.83–0.86 vs 0.9+). This is **by design**, not a Confluence-writer
defect. `ConfluenceResult` is a flat `{title,id}[]` with no parent graph, so
"hierarchy mirrors PRD" is **unscorable from the payload** without a tenant
crawl (out of scope, ADR-044). That missing dimension is recorded as an
`unrepresented_in_payload` gap and caps the achievable score.

`quality_gap_aggregate` **excludes** `unrepresented_in_payload` (and
`expected_field_absent`, `expected_under_ceiling`) precisely so you do not chase
structural limitations as if they were writer faults. If you "optimize" the
Confluence writer to raise its score, you are fighting a rubric ceiling and will
waste effort or distort the writer to game a capped number.

---

## Rule 3 — Validate the judge before trusting the dataset (do this at N≈40)

Do not draw conclusions — or change any prompt — until the judge is validated.
Run the calibration check (5b):

```
npm run calibrate:check -- --env dev --runs <id1,id2,id3,id4,id5>
```

It does two things:

- **Variance probe (automated):** re-scores those runs at a probe
  `rubric_version` and reports how far scores moved. `max|Δ| ≤ 0.05` = stable
  instrument. `> 0.10` = do NOT trust score comparisons until understood.
- **Validity check (you, by hand):** open the artifacts behind the probed runs
  and judge whether the scores/gaps match your own read. **If the judge
  disagrees with you, fix the JUDGE or the RUBRIC — never the writer.** A judge
  that scores good work poorly is a broken instrument; tuning writers to it makes
  the product worse.

Only after both pass is the dataset trustworthy for prompt work. Record the
result (max|Δ|, your validity notes) somewhere durable, then delete the probe
rows (the CLI prints the cleanup SQL).

---

## Rule 4 — Judge fixed, one writer change at a time

- **Never change the judge and a writer prompt in the same comparison.** If both
  move, a score delta means nothing. The judge model (`judge_model`) and the
  judge's own prompt stay fixed while you tune writers.
- **One writer, one change, re-score, compare.** Batch changes make it
  impossible to attribute a score move to a cause.
- To change the judge deliberately (new model, new rubric): bump the relevant
  version, re-score, and treat old vs new as a separate, labelled comparison —
  the version columns keep the history honest.

---

## Rule 5 — No automated prompt optimization (Goodhart)

KAN-83 scope explicitly excludes auto-tuning prompts from scores. An automated
loop that optimizes writer prompts to raise an LLM-judge score will reliably
learn to **game the judge** — longer, more structured, more buzzword-dense
output that scores higher while real quality flatlines or drops. LLM judges have
known biases (length, structure, confident tone); optimizing against them
amplifies those biases into your product.

All learning here is **human-in-the-loop**: the dataset points you at where to
look; your judgement decides what is real; you make the change. The number is a
side effect to sanity-check, never the objective.

---

## The views (5a) — what each is for

- **`quality_scores_summary`** — one row per scored run; the five scores + verdict
  mix + `judge_usd`. Your at-a-glance "what happened on this run."
- **`quality_gap_aggregate`** — the harness. Top recurring **actionable** gap
  classes per artifact type. This is what grows the prompts.
- **`quality_score_distribution`** — count/mean/min/max/stddev per artifact_type
  per `rubric_version`. The before/after surface, and where the Confluence floor
  shows up as a stable low band (Rule 2).
- **`quality_attempt_health`** — the judge's own reliability. `likely_stuck` =
  a scoring that started and never finished (a crashed/dying judge — the signal
  the whole attempt-row design exists to surface).

All four are operator-only (service-role read; anon/authenticated revoked). No
user-facing surface, ever (ADR-044 clause k).

---

## The cost angle (Phase 4)

The judge is **operator overhead, not per-idea cost** — ~$0.045/scored run,
15% sample in steady state, <$1/mo at launch. It is folded into KAN-49 §2 and
the Unit Economics manual-context page as operator cost, deliberately excluded
from the per-idea basis and margins (`judge_usd` never enters
`pipeline_runs.cost_usd`). If judge spend approaches `QUALITY_JUDGE_MAX_USD`,
drop the sample rate or pause — it is observational and never worth risking
margin.

---

## A generated report (deferred)

A weekly generated Confluence page (like the pipeline analytics report) is
**deliberately deferred** until N is past calibration. Publishing a report over
a handful of runs invites the score-chasing these rules forbid. When the dataset
is large and validated, a section slots into the existing Generate Analytics
Report job — no new infrastructure. Until then: the views + ad-hoc queries via
the Supabase connector are the surface.
