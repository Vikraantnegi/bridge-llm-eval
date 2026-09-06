# bridge-llm-eval

KAN-83 operator quality judge. Observational, non-gating. Lives here so Listener stays a UI app (ADR-044) and the pipeline worker is not the home of scoring.

**Phase 2 (this repo today):** five artifact rubrics, a pinned `run_results` type mirror, smoke tests, and CI that typechecks + tests + fails on mirror drift.

**Phase 3 (not here yet):** HMAC `POST /score { run_id }`, calibration/budget/sample gates, one Sonnet call, five-row upsert, `increment_judge_cost`.

## Layout

| Path | Role |
|------|------|
| `rubrics/` | `scorePrd`, `scoreBrand`, `scoreJira`, `scoreConfluence`, `scoreResearch` |
| `types/run-results.mirror.ts` | Verbatim copy of `listener/types/run-results.ts` at `MIRROR_SHA` |
| `scripts/check-run-results-mirror.mjs` | Fails if the mirror body drifted or the pin is stale |
| `.github/workflows/ci.yml` | `tsc`, Vitest, then the mirror check against a sibling clone of Listener |

Canonical types live only in Listener. Do not import `@sprintzero/schemas` from the pipeline repo — that is a different snake_case PRD generator.

## Score (v1)

- `null` artifact column → `artifact_absent`, score `null` (not 0).
- Deterministic checks produce `detScore`.
- No LLM / abstain → `score = detScore`.
- Else `score = detScore * (0.5 + 0.5 * q)` with `q` clamped to `[0,1]`. The LLM cannot raise score above `detScore`.

Locks: Jira orphans join on epic **key**; Confluence coverage is KIND regex (not frozen titles); research URLs absent = flag, dead URLs = penalty; `nameNotes` is off the brand checklist.

## Commands

```bash
npm install
npm run typecheck
npm test
npm run check:mirror
```

`check:mirror` needs a Listener clone. Default path is the sibling `../listener`. Override with `LISTENER_REPO`.

## CI and Listener

The mirror check is a **sibling clone** in GitHub Actions (`actions/checkout` of `asumacodes/listener` into `./listener`), not a submodule and not a second pinned copy.

This repo (`Vikraantnegi/bridge-llm-eval`) and Listener (`asumacodes/listener`) are different GitHub owners, so `GITHUB_TOKEN` cannot clone Listener. Add a repo secret **`LISTENER_READ_TOKEN`**: a read-only PAT that can clone `asumacodes/listener`. The workflow uses `fetch-depth: 0` so `git log -1 -- types/run-results.ts` is the last-touch SHA, not truncated HEAD.
