# n8n checklist — KAN-83 Phase 3a Quality Judge shell

Apply in the Bridge n8n UI **after** the scorer URL is reachable. Agent cannot reach n8n.

## Env (n8n)

| Variable | Purpose |
|----------|---------|
| `QUALITY_JUDGE_ENABLED` | Master off-switch; IF equals string `true` |
| `QUALITY_JUDGE_URL` | Base URL of the Fastify scorer (no trailing slash) |
| `MURMUR_HMAC_SECRET` | Same secret the scorer uses for `v1:score:{run_id}:{ts}` |

## Env (scorer process)

| Variable | Purpose |
|----------|---------|
| `MURMUR_HMAC_SECRET` | Auth |
| `SUPABASE_URL` | Service DB |
| `SUPABASE_SERVICE_ROLE_KEY` | Service DB |
| `QUALITY_JUDGE_CALIBRATION_AUTHORIZED` | Must be `true` to write attempts/scores |
| `QUALITY_JUDGE_MAX_USD` | Standing spend ceiling (fail-closed if unset/NaN) |
| `QUALITY_JUDGE_SAMPLE_RATE` | `1.0` → `0.15` (fail-closed if unset/NaN/out of `[0,1]`) |
| `QUALITY_JUDGE_STUCK_MINUTES` | Optional; default `10` |
| `PORT` | Optional; default `8787` |

## Main workflow (one node, one wire)

1. After **Finalize Run Cost**, add **Dispatch Quality Judge** (`executeWorkflow`, typeVersion ≥ 1.2 / export uses 1.3).
2. Wire it **parallel** to `Evt: building_board done` → mail. Do **not** merge back onto the mail spine.
3. Settings:
   - **Wait for Sub-Workflow Completion:** OFF (`wait:false`)
   - **onError:** `continueRegularOutput`
   - Input (defineBelow), exactly one field:
     - `run_id` = `{{ $('Verify HMAC').item.json.__runId }}`

## New workflow: Quality Judge (three nodes)

1. **Execute Workflow Trigger** — declared input: `run_id`.
2. **Enabled?** (`IF`): `{{ $env.QUALITY_JUDGE_ENABLED }}` equals `true`.
   - true → POST `/score`
   - false → no downstream node (path ends)
3. **POST /score** (`httpRequest`):
   - Method `POST`
   - URL `{{ $env.QUALITY_JUDGE_URL }}/score`
   - Headers:
     - `x-murmur-timestamp`: unix seconds
     - `x-murmur-signature`: `v1=<hmac-sha256 hex of v1:score:{run_id}:{ts} with MURMUR_HMAC_SECRET>`
   - Body: `{ "run_id": "{{ $json.run_id }}" }`
   - `onError: continueRegularOutput`; timeout ~5s
   - Do not parse the response beyond completion (expect **202**)

Do **not** fork LLM Call (`JMkXea4OF38BBmdK`) — that path bills `increment_run_cost`.
