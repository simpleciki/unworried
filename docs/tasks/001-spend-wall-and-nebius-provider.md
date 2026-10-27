# Task 001 — Spending wall and the Nebius Token Factory provider

Read `docs/tasks/000-shared-rules.md` first. This task is the first thing built because it is the only wall
between the demo and the author's bank card: Nebius Token Factory has **no spending cap and no usage alert**;
when the balance goes negative it charges the card. So the application keeps its own ledger and refuses
calls before they are sent. Nothing else in this repository may call a model except through this wall.

## Files you own

```
src/spend/guard.ts        the single exit for model calls: reserve worst-case cost → call → settle on usage
src/spend/ledger.ts       append-only JSONL ledger on disk; totals per call / action / session / day / all
src/spend/prices.ts       price table: model id → USD per 1M input tokens, per 1M output tokens
src/spend/limits.ts       the limits (defaults below) and their env overrides
src/spend/limiter.ts      sliding-window rate limits (global and per session), separate from the budget
src/spend/breaker.ts      hourly circuit breaker
src/spend/kill-switch.ts  LLM_ENABLED
src/spend/*.test.ts
src/llm/nebius.ts         ChatProvider for Token Factory (OpenAI-compatible chat completions)
src/llm/nebius.test.ts
scripts/spend-status.ts   prints ledger totals for reconciliation against the Nebius Usage page
.env.example
docs/spend-wall.md        how it works, how to operate it, how to reconcile (feeds the README later)
```

You may change `src/llm/provider.ts` (add optional `usage` to `ChatResult`), `src/llm/client.ts` (the
Meterless routing modes must not be required for a Nebius run; keep tests green), and `src/llm/modes.ts`.
`src/engine/` is frozen.

## Design (decided by the author on 2026-10-14; defaults may be changed only via env, not in code)

Every model call goes through `guard.ts`:

1. **Before sending:** worst-case cost = (input token upper bound × input price) + (`max_tokens` × output
   price). Input upper bound = UTF-8 byte length ÷ 2 (over-estimates on purpose). `max_tokens` is fixed per
   call kind, never above 1,024. If worst-case cost exceeds any remaining budget (action, session, day,
   total) → **refuse before the network call**, with which limit refused.
2. **Reserve** the worst-case cost in the ledger, make the call, then **settle** on the `usage` the response
   reports (refund the difference). **A response with no `usage` is booked at the worst case, never at 0.**
3. **Rate limits are separate code from budgets** (`limiter.ts` vs `ledger.ts`): if one has a bug, the other
   still bounds the loss per hour. Defaults: 12 calls/min global, 4 calls/min per session.
4. **Hourly breaker:** actual spend in the trailing 60 minutes > $0.50 → model calls switch off for the
   process (same effect as the kill switch) and the reason is logged.
5. **Kill switch:** `LLM_ENABLED=false` → `guard` reports `enabled: false, reason`, callers fall back to a
   SAMPLE mode (recorded replies; not part of this task — just make the state queryable).
6. **The ledger must survive restarts:** JSONL file, append-only, path from `SPEND_LEDGER_PATH` (default
   `state/spend-ledger.jsonl`). **If the ledger cannot be read at startup → model calls stay disabled.**
   Never start from zero because the file is missing.
7. **Price table in config, not in code paths:** `prices.ts` reads `NEBIUS_PRICES_JSON` (a JSON object
   `{ "<model id>": { "input_per_m": 0.06, "output_per_m": 0.24 } }`) or `config/prices.json`. **A model id
   with no price → refuse.** Put the author's provisional numbers in `config/prices.json` and mark them
   `"source": "third-party aggregator, unverified 2026-10-14"`; she will replace them from the Nebius console.
8. **Single exit:** only `src/spend/guard.ts` may construct `NebiusProvider` or read `NEBIUS_API_KEY`. Write
   a test that greps `src/` for both and fails if they appear anywhere else.

### Default limits (env override in parentheses)

| layer | default | env |
|---|---|---|
| per call | `max_tokens` ≤ 1,024, by call kind | `SPEND_MAX_TOKENS_<KIND>` |
| per action | ≤ 8 calls and ≤ $0.03 worst case | `SPEND_ACTION_CALLS`, `SPEND_ACTION_USD` |
| per session | $0.15 | `SPEND_SESSION_USD` |
| per day (America/Chicago calendar day) | $3.00 | `SPEND_DAY_USD` |
| total (whole hackathon) | **$47.00** (balance $50 − $3 margin) | `SPEND_TOTAL_USD` |
| rate | 12/min global, 4/min per session | `SPEND_RATE_GLOBAL`, `SPEND_RATE_SESSION` |
| hourly breaker | $0.50 | `SPEND_HOUR_USD` |

"Session" = a caller-supplied id (later: one judge's login). "Action" = a caller-supplied id for one user
request (later: one "handle this conflict" click).

### `src/llm/nebius.ts`

- Implements `ChatProvider` from `src/llm/provider.ts`. `POST {NEBIUS_BASE_URL}/chat/completions` with
  `{ model, messages, max_tokens, temperature }`, header `Authorization: Bearer <NEBIUS_API_KEY>`.
- **Do not hardcode the base URL.** Read `NEBIUS_BASE_URL` from the environment; document the real value in
  `.env.example` and `docs/spend-wall.md` only (the author will fill it from the Token Factory docs).
- Returns `text`, `model` (as the server reports it), `latencyMs`, and `usage: { input_tokens, output_tokens }`
  when present. Timeout 30 s. On timeout or 5xx the **guard** may retry once (the retry reserves budget
  again); 4xx is never retried. 401/403 → `ProviderError("unauthorized")` without echoing the body's
  account details (see `redactAccount` in `src/llm/http.ts`).
- The fetch function is injectable so tests use a fake transport. **No test may reach the network.**
- Model ids are plain strings from env `NEBIUS_MODEL` (the author will set an NVIDIA Nemotron id). Do not
  invent a default model id in code; absent env → refuse with "NEBIUS_MODEL not set".

## Acceptance (from the author's spec; S = spend wall)

| # | test | passes when |
|---|---|---|
| S1 | fake transport, total budget $0.01, call repeatedly | the Nth call is refused **before** the transport is invoked; transport call count == number of calls allowed; ledger total ≤ $0.01 |
| S2 | response without `usage` | booked at worst case, not 0 |
| S3 | budget code deliberately broken in the test (always allows), rate limiter intact | calls allowed in one minute ≤ the rate limit |
| S4 | rate limiter deliberately broken, budget intact | total budget still holds |
| S5 | simulated trailing-hour spend over the breaker threshold | model calls disabled; state says why |
| S6 | ledger file deleted, process restarted | model calls stay disabled (not reset to zero) |
| S8 | grep `src/` | only `src/spend/guard.ts` constructs the provider or reads `NEBIUS_API_KEY` |
| S9 | `scripts/spend-status.ts` | prints totals by day and in all, and the last 10 entries, from the ledger |
| S10 | DST | a "day" bucket on 2026-11-01 is one America/Chicago calendar day, 25 hours long |

S7 (one **real** call with total budget $0.01, then reconciliation against the Nebius Usage page) is done by
the author herself later. Leave a one-line recipe for it in `docs/spend-wall.md`.

## Done looks like

`npm run typecheck && npm test` green including S1–S6, S8–S10; `docs/spend-wall.md` written;
`docs/tasks/001-report.md` written per the shared rules. Small commits, e.g. `feat(spend): ledger with
reserve/settle and day buckets`, `feat(llm): Nebius Token Factory provider with injectable transport`,
`test(spend): S1–S6 …`.
