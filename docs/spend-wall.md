# The spending wall

Nebius Token Factory has no spending cap and no usage alert; when the balance goes negative it charges
the card on file. So `unworried` keeps its own ledger and refuses a call **before** sending it. Nothing in
this repository may call a model except through `src/spend/guard.ts`; a test (`src/spend/single-exit.test.ts`)
greps `src/` and fails if any other file constructs the provider or reads the key.

## How one call goes through

```
caller ──▶ SpendGuard.call({ session_id, action_id, kind, system, user })
             │
             ├─ kill switch off?            LLM_ENABLED=false → refused "kill_switch"
             ├─ ledger readable?            missing / corrupt file → refused "ledger" (never "zero spent")
             ├─ hourly breaker tripped?     > $0.50 actual in the trailing 60 min → refused "breaker", off for the process
             ├─ provider + model known?     no key → "credentials"; no NEBIUS_MODEL → "model"
             ├─ price known?                model id not in the price table → refused "price"
             ├─ worst case = bytes(prompt)/2 × input price + max_tokens × output price
             ├─ budgets                     action calls, action $, session $, day $, total $ → first one exceeded refuses
             ├─ rate limits                 12/min global, 4/min per session (separate code from budgets)
             ├─ RESERVE worst case in the ledger (append one JSONL line)
             ├─ POST {NEBIUS_BASE_URL}/chat/completions   (30 s timeout; one retry on timeout / 5xx, which reserves again)
             └─ SETTLE: refund to the usage the server reported; no usage → stays at the worst case
```

Every refusal is returned as `{ ok: false, limit, reason }` and also written to the ledger as a `refuse` line,
so a demo that stops can be read back later. A failed attempt (timeout, 5xx) is **booked at the worst case**,
because the wall cannot know whether the server billed it.

### The two walls are independent on purpose

| wall | file | bounds |
|---|---|---|
| budgets | `ledger.ts` + `defaultBudgetCheck` in `guard.ts` | money per action / session / day / total |
| rate limits | `limiter.ts` | calls per minute, global and per session |

Test S3 breaks the budget code and shows the rate limit still holds; S4 breaks the rate limiter and shows the
budget still holds. With default limits the worst hour with a broken budget is 12 calls × 60 min × (1,024 output
tokens + prompt) — at the provisional Nemotron Nano price about $0.18/hour, before the hourly breaker trips at $0.50.

### Limits

| layer | default | env |
|---|---|---|
| per call | `max_tokens` ≤ 1,024, by call kind (default 512) | `SPEND_MAX_TOKENS_<KIND>` |
| per action | ≤ 8 calls and ≤ $0.03 worst case | `SPEND_ACTION_CALLS`, `SPEND_ACTION_USD` |
| per session | $0.15 | `SPEND_SESSION_USD` |
| per day (America/Chicago calendar day) | $3.00 | `SPEND_DAY_USD` |
| total (whole hackathon) | **$47.00** (balance $50 − $3 margin) | `SPEND_TOTAL_USD` |
| rate | 12/min global, 4/min per session | `SPEND_RATE_GLOBAL`, `SPEND_RATE_SESSION` |
| hourly breaker | $0.50 actual | `SPEND_HOUR_USD` |

Defaults are in `src/spend/limits.ts` and are changed only through the environment. An override above the
1,024-token hard cap, or a value that is not a number, is a configuration error: the guard reports
`enabled: false, limit: "config"` instead of falling back to a default.

"Day" is a Chicago calendar day computed from the instant, so 2026-11-01 (DST ends 02:00 CDT) is 25 hours
long; test S10 checks it. A settle is attributed to the day its call **started**.

## The ledger

`state/spend-ledger.jsonl` (path from `SPEND_LEDGER_PATH`), append-only, one JSON object per line, every
`at` an ISO 8601 timestamp with the Chicago offset in force:

| kind | meaning | `usd` |
|---|---|---|
| `opened` | the file was created | — |
| `reserve` | a call is about to be sent | + worst case |
| `settle` | the call finished | actual − reserved (a refund ≤ 0; `booked: "worst_case"` when no usage came back or the call failed) |
| `refuse` | a call was refused before sending | — (`limit`, `reason`) |
| `breaker` | the hourly breaker tripped | — (`spent_usd`) |

The committed spend is the sum of `usd` over `reserve` + `settle` lines. **If the file is missing or any line
does not parse, the guard stays disabled** — it never assumes "nothing spent yet". Only a human creates it:

```bash
npx tsx scripts/spend-status.ts init
```

## Operating it

```bash
npx tsx scripts/spend-status.ts           # totals in all and by day, last 10 entries
LLM_ENABLED=false npm start               # kill switch (any process reading the env)
```

- **Breaker tripped?** It stays off until the process restarts, and a restart re-reads the ledger: if the
  trailing hour is still over $0.50 it trips again at once. Wait, or raise `SPEND_HOUR_USD` knowingly.
- **"no price for model …"**: add the id to `config/prices.json` (or `NEBIUS_PRICES_JSON`). Prices there are
  provisional (`"source": "third-party aggregator, unverified 2026-10-14"`); replace them from the Token Factory
  console before the first real call.
- **Changing the model**: set `NEBIUS_MODEL` to the id exactly as Token Factory lists it. There is no default
  in code.

## Reconciliation against the Nebius Usage page

1. `npx tsx scripts/spend-status.ts` → note **Total** and the **By day** rows.
2. Token Factory console → Usage. Its buckets may be UTC days; Chicago is UTC−5 until 2026-11-01 02:00 and
   UTC−6 after, so compare sums over the same instants, not the same date labels.
3. Expected: Nebius ≤ our total. Our ledger over-estimates on purpose (byte/2 input bound, failed attempts at
   the worst case). If Nebius shows **more** than the ledger, stop: a call went around the wall — check
   `src/spend/single-exit.test.ts` and the key's other users.

**S7 recipe (author only, inside an approval window, in her own terminal):** `SPEND_TOTAL_USD=0.01
NEBIUS_MODEL=<id> npx tsx -e 'import("./src/spend/guard.ts").then(async m => console.log(await
m.SpendGuard.fromEnv().call({ session_id: "s7", action_id: "s7", kind: "probe", user: "Reply with the word ok." })))'`,
then `npx tsx scripts/spend-status.ts` and compare the one settle line with the Usage page the next morning.

## What the wall does not do

- It cannot see calls made with the same key from outside this repository. The key's only user should be this app.
- Prices are inputs. A wrong price table under-books every call in proportion; the hourly breaker and the
  per-call token cap still bound the damage, which is why they are separate.
- The rate limiter and the breaker live in memory per process; the ledger is the only cross-restart state.
