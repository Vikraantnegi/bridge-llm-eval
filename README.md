# bridge-llm-eval

KAN-83 operator quality judge. Observational, non-gating. Lives here so Listener stays a UI app (ADR-044).

**Phase 2:** five artifact rubrics, pinned `run_results` mirror, smoke tests, CI mirror check.

**Phase 3 (batch):** offline CLI scores done runs — gate → deterministic → one Sonnet call → five rows + attempt transition. No Fastify, no HMAC, no n8n dispatch.

**Phase 5:** operator views + `calibrate:check` variance probe + [docs/OPERATOR-GUIDE.md](docs/OPERATOR-GUIDE.md).

## Layout

| Path | Role |
|------|------|
| `rubrics/` | Pure scoring functions |
| `lib/` | Batch gate, persistence, judge, packer, calibration |
| `cli/` | `scoreBatch` + `calibrationCheck` entry points |
| `migrations/` | Versioned DDL (applied remotely via Supabase) |
| `docs/` | ADR addendum, batch wiring, operator guide |
| `types/run-results.mirror.ts` | Verbatim Listener mirror at `MIRROR_SHA` |

## Commands

```bash
npm install
npm run typecheck
npm test
npm run check:mirror
npm run score:batch:dev    # last 24h on murmur-dev (needs .env)
npm run score:batch:prod   # prod; refuses unless CALIBRATION_AUTHORIZED_PROD=true
npm run calibrate:check -- --env dev --runs <id1,id2,id3>
```

## Env

See [docs/BATCH-WIRING.md](docs/BATCH-WIRING.md). Operator discipline: [docs/OPERATOR-GUIDE.md](docs/OPERATOR-GUIDE.md).

## CI and Listener

Sibling clone of `asumacodes/listener` in Actions. Repo secret **`LISTENER_READ_TOKEN`** required.
