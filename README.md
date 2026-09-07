# bridge-llm-eval

KAN-83 operator quality judge. Observational, non-gating. Lives here so Listener stays a UI app (ADR-044).

**Phase 2:** five artifact rubrics, pinned `run_results` mirror, smoke tests, CI mirror check.

**Phase 3a–3d (this repo today):** Fastify `POST /score` with HMAC + gates, deterministic runner + SSRF `checkUrl`, Sonnet judge + packer, five-row upsert + attempt transitions via `runRealScore`.

## Layout

| Path | Role |
|------|------|
| `rubrics/` | Pure scoring functions |
| `lib/` | HMAC, gate, config, Supabase attempts store |
| `src/` | Fastify server + `/score` route + stub work |
| `migrations/` | Versioned DDL (applied remotely via Supabase) |
| `docs/` | ADR-044 addendum + n8n checklist |
| `types/run-results.mirror.ts` | Verbatim Listener mirror at `MIRROR_SHA` |

## Commands

```bash
npm install
npm run typecheck
npm test
npm run check:mirror
npm run dev   # POST /score on PORT (default 8787)
```

## Scorer env

See [docs/n8n-quality-judge-checklist.md](docs/n8n-quality-judge-checklist.md).

## CI and Listener

Sibling clone of `asumacodes/listener` in Actions. Repo secret **`LISTENER_READ_TOKEN`** required.
