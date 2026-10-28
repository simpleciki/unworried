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
tokens + prompt) — at Nemotron 3 Super's console price about $0.66/hour for output alone ($0.90 / 1M tokens), under $1 with ~1,000-token prompts, before the hourly breaker trips at $0.50.

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
- **"no price for model …"**: add the id to `config/prices.json` (or `NEBIUS_PRICES_JSON`). Prices there
  were read from the Token Factory console prices page on 2026-10-27 (each entry's `source` names the product
  row); re-read them there if the model changes.
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

## Ledger mirror (hosts that forget their disk)

A free web host that sleeps when idle loses its local files on every restart, and a ledger that is lost
would make the wall start again from zero. With `LEDGER_MIRROR_REPO` and `LEDGER_MIRROR_TOKEN` set
(`src/spend/mirror.ts`), one copy of the ledger lives in a private GitHub repository:

- **Start:** the mirror is downloaded to `SPEND_LEDGER_PATH` before the wall opens it. No file in the mirror →
  no local file is created and model calls stay off. A local file that differs from the mirror → model calls
  stay off with the reason on the screen; a person resolves it. Any mirror error (bad token, network) → off.
- **Every call:** the reserve line is pushed to the mirror **before** the request is sent; if the push fails the
  request is not sent, the reserve stays booked at the worst case, and the refusal says `ledger`. The settle
  line follows in the background; if it is lost, the next start counts that reserve in full (over-counts,
  never under-counts).
- **One writer:** each push carries the sha it replaces, pushes are serial, and a stale sha is a loud
  conflict, never an overwrite. Run one instance only.
- The token is sent only as a bearer header to `api.github.com`; it is not logged and not written to the
  ledger (test M8). Every ledger change is a commit in that repository, so the spend history can be audited
  there line by line.
- Seeding: the mirror starts as a copy of the author's local ledger at deploy time, so development spend is
  carried into the hosted total. After that, spend only from one place.

Tests M1–M9 in `src/spend/mirror.test.ts` (offline, fake GitHub).

## What the wall does not do

- It cannot see calls made with the same key from outside this repository. The key's only user should be this app.
- Prices are inputs. A wrong price table under-books every call in proportion; the hourly breaker and the
  per-call token cap still bound the damage, which is why they are separate.
- The rate limiter and the breaker live in memory per process; the ledger is the only cross-restart state.
