# Batch scorer — wiring (npm scripts, env, scheduler)

## 1. package.json scripts

```jsonc
{
  "scripts": {
    "score:batch": "tsx cli/scoreBatch.ts",
    "score:batch:dev": "tsx cli/scoreBatch.ts --env dev --since 24",
    "score:batch:prod": "tsx cli/scoreBatch.ts --env prod --since 24"
  }
}
```

The repo uses `tsx` (same as the old `npm start` path). No `dist/` emit — `tsconfig` is `noEmit` + extensionless ESM.

The CLI loads env via `dotenv` from a local `.env` (gitignored). Schedulers can also inject real process env vars.

## 2. .env (gitignored) — per-environment, suffixed `_DEV` / `_PROD`

```bash
# Shared
ANTHROPIC_API_KEY=sk-ant-...
RUBRIC_VERSION=v1                       # optional; falls back to config.RUBRIC_VERSION

# --- DEV target ---
SUPABASE_URL_DEV=https://ylqmqjiftgtsurziouep.supabase.co
SUPABASE_SERVICE_ROLE_KEY_DEV=<dev service_role>
QUALITY_JUDGE_CALIBRATION_AUTHORIZED_DEV=true
QUALITY_JUDGE_SAMPLE_RATE_DEV=1.0
QUALITY_JUDGE_MAX_USD_DEV=25

# --- PROD target (leave AUTHORIZED false until you deliberately score prod) ---
SUPABASE_URL_PROD=https://jighdyaffeiimyqhlzuv.supabase.co
SUPABASE_SERVICE_ROLE_KEY_PROD=<prod service_role>
QUALITY_JUDGE_CALIBRATION_AUTHORIZED_PROD=false
QUALITY_JUDGE_SAMPLE_RATE_PROD=0.15
QUALITY_JUDGE_MAX_USD_PROD=25
```

Double lock: `npm run score:batch:prod` selects the prod DB, but the batch
REFUSES unless `QUALITY_JUDGE_CALIBRATION_AUTHORIZED_PROD=true`. Two independent
switches; fat-fingering `--env prod` cannot write to prod on its own.

## 3. Scheduler (trigger only — judge is still Sonnet-5)

Cursor / cron / launchd only **triggers** the process. The judge itself remains
the Anthropic API call inside `runJudge` (`judge_model` stays honest).

Portable options:

- **Linux / droplet:** `0 2 * * * cd /path/repo && npm run score:batch:dev >> log 2>&1`
- **macOS:** launchd plist calling the same npm script
- **Cursor Cloud Agent:** schedule an agent whose instruction is to run
  `npm run score:batch:dev` (agent = trigger, not the scoring model)

The null-check lives in the script: no eligible runs → clean exit, no Anthropic.

## 4. Trigger cadence

`--since 24` with a nightly 02:00 run covers the prior day with margin. If a run
is missed (laptop asleep), the next night's `--since 24` won't reach it — widen
to `--since 48` occasionally, or run on an always-on host. Selector +
`insertAttempt` idempotency mean re-running a wider window never double-scores.

## 5. Live DB notes (as-built)

- `sumJudgeUsd` pages `run_costs.judge_usd` client-side — this project's PostgREST
  rejects aggregates (`PGRST123`).
- `fetchRunResults` does not select `transcript` — the live `run_results` table
  has no such column; packer already excludes transcript in v1.
- `selectRunsToScore` requires a `run_results` row (done-but-empty pipeline runs
  are skipped, not claimed as `judge_error`).
