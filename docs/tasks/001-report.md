# Task 001 — report

Written 2026-10-26 22:2x CDT by the task session (Claude Fable 5.1). Everything below comes from command
output seen in this session; nothing was run against the network or a real model.

## What changed

| file | one line |
|---|---|
| `src/spend/prices.ts` | price table from `NEBIUS_PRICES_JSON` or `config/prices.json`; worst-case and actual cost; a model with no price is refused |
| `config/prices.json` | three provisional Nemotron ids, each marked `"source": "third-party aggregator, unverified 2026-10-14"` |
| `src/spend/limits.ts` | the default limits and their env overrides; `max_tokens` by call kind with a 1,024 hard cap (an override above it is a loud error) |
| `src/spend/kill-switch.ts` | `LLM_ENABLED`: false/0/off/no → off with reason; unrecognised value → off with reason |
| `src/spend/limiter.ts` | sliding-window rate limits, global and per session; refuses, never waits; separate code from the budget |
| `src/spend/breaker.ts` | hourly breaker on actual trailing-60-minute spend; trips for the process, never resets itself |
| `src/spend/ledger.ts` | append-only JSONL ledger: `opened` / `reserve` / `settle` / `refuse` / `breaker` lines; totals per call / action / session / Chicago day / all; `chicagoIso`, `chicagoDay`, `chicagoDayBounds` |
| `src/spend/guard.ts` | the single exit: gate → price → worst case → budgets → rate → reserve → call → settle; one retry on timeout/5xx; `fromEnv()`; `asProvider()` so `ModelClient` can sit on top |
| `src/llm/nebius.ts` | `NebiusProvider`: OpenAI-compatible chat completions, injectable fetch, 30 s timeout, usage passed through, 401/403 redacted |
| `src/llm/provider.ts` | `ChatRequest.maxTokens?`, `ChatResult.usage?`, `ProviderErrorKind` gains `"refused"` |
| `src/llm/modes.ts` | `PROVIDER_MODEL` accepts any `vendor/Name` id; a pinned id with no human order has no Meterless fallback |
| `scripts/spend-status.ts` | prints totals in all and by day and the last 10 lines; `init` creates the ledger, refuses to overwrite |
| `.env.example` | placeholders only; base URL value to verify; every limit with its default |
| `docs/spend-wall.md` | how a call goes through, the two independent walls, the ledger, operating, reconciliation, S7 recipe |
| tests | `src/spend/guard.test.ts` (S1–S6 + refusals, retries, asProvider), `src/spend/ledger.test.ts` (S10 + bookkeeping), `src/spend/single-exit.test.ts` (S8), `src/spend/status.test.ts` (S9), `src/llm/nebius.test.ts` |

No new dependencies. `src/engine/` untouched.

## Final test run and commits

```
> tsc --noEmit
 Test Files  10 passed (10)
      Tests  68 passed (68)
```

(31 tests before this task → 68 after; the 37 new tests are all offline.)

```
5d1c740 docs(spend): how the wall works, how to operate and reconcile it; .env.example
f56880e feat(spend): spend-status script for reconciliation against the Usage page
08f8f5f feat(spend): guard as the single exit for model calls
4d8a2b4 feat(llm): Nebius Token Factory provider with injectable transport
00cff6d feat(spend): append-only JSONL ledger with reserve/settle and Chicago day buckets
b205d13 feat(spend): price table, limits, kill switch, rate limiter and hourly breaker
40c29a8 docs(tasks): shared rules and task cards 001 (spending wall, Nebius provider) and 002 (sandbox calendar, actions)
064e50b feat(engine): import the decision-ledger engine from unexplained @3007251, with provenance
```

Plus the commit carrying this report. All commits carry the `-0500` offset. `npm run typecheck && npm test`
was run green once over the whole working tree before the six commits were cut (they split one green tree
into logical pieces; running the suite per staged subset would have needed `git stash`, which this session
may not use).

## Acceptance

| # | test | result | note |
|---|---|---|---|
| S1 | fake transport, total budget $0.01, call repeatedly | ✅ | 18 calls allowed, 19th refused `total_usd` before the transport; transport count == 18; ledger total ≤ $0.01 (`guard.test.ts` "S1") |
| S2 | response without `usage` | ✅ | booked at the worst case $0.001001, settle line `usd: 0` |
| S3 | budget broken (always allows), limiter intact | ✅ | 50 calls over 5 sessions in 5 s → exactly 12 reach the provider; both `rate_session` and `rate_global` refusals seen; flows again after 61 s |
| S4 | limiter broken, budget intact | ✅ | 9 calls reach the provider, every other refusal is `total_usd`, ledger ≤ $0.01 |
| S5 | trailing-hour spend over the breaker | ✅ | $0.60 in the last 30 min → `enabled: false`, `limit: "breaker"`, reason names the amounts; `breaker` line written; stays off after the hour; second case trips on the call that crosses the line |
| S6 | ledger deleted, process restarted | ✅ | new guard over the same path → `limit: "ledger"`, "file is missing; model calls stay disabled", no totals shown; a corrupt line disables too |
| S7 | one real call + reconciliation | ⬜ | author only, inside an approval window; recipe is the last paragraph of `docs/spend-wall.md` § Reconciliation |
| S8 | grep `src/` | ✅ | `single-exit.test.ts` walks every `.ts` under `src/`: the key's env name appears only in `spend/guard.ts`; `new NebiusProvider(` only in `spend/guard.ts` and `llm/nebius.test.ts` (the provider's own test) |
| S9 | `scripts/spend-status.ts` | ✅ | run as a child process through `tsx` with only `SPEND_LEDGER_PATH` in its env: totals in all, by day (10-31 $0.002 / 11-01 $0.004), last 10 lines; missing ledger → exit 1; `init` twice → second refused |
| S10 | DST | ✅ | `chicagoDayBounds("2026-11-01")` = `[00:00-05:00, 2026-11-02T00:00-06:00)` = 25 h; 2026-03-08 = 23 h; ledger `byDay` puts 01:30 CDT and 01:30 CST in the same bucket and 23:30 CST on 10-31 / 00:30 on 11-02 outside it |

## Questions for the author

1. **Frozen engine, `src/engine/time.ts`, DST-transition day.** `parseTime("2026-11-01")` returns a 24-hour span
   starting `2026-11-01T06:00:00Z` (00:00 **CST**). `chicagoOffsetMinutes(2026, 10, 1)` treats the whole day as
   −360 because its check is `md < dstEnd` with `dstEnd` = the first Sunday of November, so the hour
   00:00–01:00 CDT on 11/01 falls into the engine's 10/31 and the day is 24 h, not 25. Likewise 2026-03-08
   is treated as all-DST. It only matters for coarse date values on the two transition days; the spend
   ledger does **not** use it (its own `chicagoDayBounds` is tested against the two midnights directly).
   Suggested fix if you unfreeze: resolve the offset from the instant (Intl `America/Chicago`) instead of
   from the calendar date. I did not touch the engine.
2. **Model ids and prices in `config/prices.json` are both provisional.** I do not know the exact ids Token
   Factory lists for the Nemotron family; the three keys are my best guess at the naming style and must be
   replaced from the console together with the prices. The guard refuses any id without a price, so a wrong
   key cannot leak spend — it can only block.
3. **`NEBIUS_BASE_URL` example value** in `.env.example` and `docs/spend-wall.md` is `https://api.studio.nebius.com/v1`,
   from memory, marked "verify". Nothing in code depends on it.
4. **Failed attempts are booked at the worst case.** A timeout or 5xx keeps its full reservation (the wall cannot
   know whether the server billed it) and the retry reserves again, so one flaky call can cost two worst cases
   of budget. This is the conservative reading of "reserve again"; say if you would rather refund failed attempts.
5. **`LLM_ENABLED` unset = enabled.** The other walls (no key, no model, no ledger) already refuse, so an unset
   switch does not open anything by itself. Say if you prefer "unset = off".
6. **Call kinds.** `max_tokens` is 512 for any kind not named in `SPEND_MAX_TOKENS_<KIND>`; no kinds are
   predefined because none exist yet (tasks 003+). The hard cap 1,024 is enforced in code.
7. **`asProvider()`** is a small addition beyond the card: a `ChatProvider` view of the guard bound to one
   session/action/kind, so the imported `ModelClient` (cache, JSON retries) can sit on top of the wall in
   later tasks without a second exit. A refusal surfaces as `ProviderError("refused", …)`. Tested; remove if
   unwanted.

## What a hook blocked

One Bash command was blocked by `~/.claude/hooks/production-api-spend-guard.js` with reason
`key+exec: NEBIUS_API_KEY`. The command was a `sed` replacing an error-message string in `src/llm/nebius.ts`
followed by `tsc --noEmit` and a `grep` for the key's env name over `src/` (my manual version of S8). It made
no network call and would have spent nothing; the hook matched the env-var name next to an executable. Per
the shared rules I did not re-run, reshape or split that command. The string edit was made with the editor
tool instead, and the grep lives where it belongs, in `src/spend/single-exit.test.ts` (vitest). No command
containing the key's name was issued through the shell afterwards.
