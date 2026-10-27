# Decisions — 2026-10-27 (hub session, morning)

"Hub" = the author's coordinating session (Claude Opus 5.5); "Ciki" = the author.

## The restart questions left open by 004

| # | item | finding | decision |
|---|---|---|---|
| 1 | Browser landed on the login form after a restart (004 hub addendum) | **Not reproduced on the server side.** Scratch clone, `LLM_ENABLED=false`, curl with a cookie jar: login → `/api/me` 200 → kill and restart → same cookie → `/api/me` 200 and `/api/state` 200 with the same session id. `auth.json` reloads as written. The 10/26 observation was most likely the browser pane not re-sending its session cookie, not the server. | No code change. If it recurs in a real browser against the deployed site, look again. |
| 2 | **The chat clock ran backwards after a restart** (found while reading `sessions.ts` for #1) | Reproduced: before the restart *"From now on Jordan does the Tuesday pickup."* was stamped `09:00:42`; after the restart *"Actually, Riley does the Tuesday pickup from now on."* was stamped `09:00:00` — the newer sentence earlier than the older one. The model derives `decided_at` from `sent_at`, so the newer decision would be ordered as the older one: the exact failure the product promises not to have. Any host that sleeps or redeploys triggers it. | **Fixed by the hub** (`4f9c96b`): the chat clock starts one second past the latest chat line under `state/sessions/`. Test D13 (3 cases). Same curl run after the fix: the post-restart sentence is stamped `09:00:43`. 148/148 offline. `docs/screen.md` now describes the chat clock (`3caeecc`; the 004 report said it was written there — it was not). |
| 3 | Plans on screen and undo tokens are in memory | A restart loses them; the calendar change itself is persisted with its versions. | Accepted as a known limit; README (`722b646`). Not worth persisting before the freeze. |

## Hosting (spec §6) — research done, choice is Ciki's (it costs money)

Read-only research 2026-10-27 10:30–10:43 CDT from official pricing / docs pages (no sign-ups):

- **Render Free, Koyeb Free, Cloud Run, Hugging Face Spaces** — no persistent disk on the free tier (Render:
  files "lost every time the service redeploys, restarts, or spins down", and it sleeps after 15 idle minutes).
  The wall would refuse model calls after nearly every wake-up and every judge sandbox would vanish. **Unfit.**
- **Oracle Always Free** — persistent and free, but idle instances are reclaimed (CPU and network under 20 %
  over 7 days), which a low-traffic demo meets. Card required. Risky.
- **Railway Hobby** — always on by default, volumes persist ($0.15 / GB / month), $5 / month includes $5 of
  usage; this app should fit inside it. Ciki already has a Railway account (JumpOnion). Unknown: her current
  plan, and whether JumpOnion already uses the included $5.
- **Fly.io** — no free allowance for new organisations; about $2.3 / month with a 1 GB volume; card required.

Hub recommendation: **Railway Hobby, one service, one volume mounted at the app's `state/` directory**,
`SPEND_LEDGER_PATH` inside that volume, Serverless (app sleeping) **off**, a usage hard limit set in the
Railway console. No code change is needed for that shape: auth, sandboxes and the ledger all live under
`state/`. Pending: Ciki looks at her Railway plan and says yes / no (money).

## 〔定 2026-10-27 11:06 Ciki〕Hosting: no money — "先别花钱，托管再想想别的办法。"

Railway Hobby is off. The $0 plan the hub built on branch `feat/ledger-mirror` (not merged; merges only on
Ciki's yes):

- **Host: Render Free web service, no payment method.** Official page (read 11:0x CDT): free services spin
  down after "15 minutes without receiving any inbound traffic", spin-up "takes about one minute", the local
  filesystem is lost on spin-down, 750 instance hours a month, and without a payment method an overage
  *suspends* the free services for the rest of the month — it cannot charge anything.
- **The one thing that must survive a restart — the spend ledger — lives in a private GitHub repository**
  (`src/spend/mirror.ts`, the `feat(spend)` commit on that branch): restored at start, every reserve pushed *before* the request is sent,
  any mirror failure keeps model calls off with the reason on screen. Tests M1–M9; a mutation check (skip the
  awaited push) turns M4, M5, M8 red. Smoke against the real GitHub API with a fake token: `HTTP 401 (Bad
  credentials)` → wall OFF with that reason, no ledger created, token in no log line. 157/157 offline.
- **What does not survive on Render Free** (accepted as known limits, to be written in README and the
  Devpost testing instructions): judge sandboxes and logins reset after 15 idle minutes (log in again, fresh
  seeded sandbox); the first page after idle takes about a minute.
- **Ciki's steps (accounts and tokens are hers):** ① say yes to the private repo (the hub can create it with
  `gh`, name e.g. `unworried-ledger`) ② create a fine-grained token limited to that repository, Contents read
  and write ③ create the Render account (no card) and paste the token and the Nebius key into Render's
  environment herself. The hub seeds the mirror from her local ledger after S7.
- **Not yet checked:** Render's supported Node version (the repo asks for Node ≥ 26) and whether its build
  installs `tsx` (a devDependency) — check before deploy.
