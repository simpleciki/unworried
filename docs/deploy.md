# Deploy — Render Free + the ledger mirror

Decided 2026-10-27 by the author: no paid hosting. One Render Free web service (no payment method on the
account, so an overage suspends the service and charges nothing) and the spend ledger mirrored to the private
repository `simpleciki/unworried-ledger` (`docs/spend-wall.md` § Ledger mirror).

## Who does what

| step | who |
|---|---|
| Private repository `simpleciki/unworried-ledger` (created 2026-10-27, private, branch `main`) | done |
| Private code repository `simpleciki/unworried` (created and pushed 2026-10-27) | done |
| Making `unworried` public (after the 10/29 secret scan) | the author decides |
| Fine-grained GitHub token for that repository | the author, in her browser |
| Render account (no card), the web service, the secret environment values | the author |
| Seeding the mirror from the author's local ledger (after S7) | hub, with the author's go-ahead |
| Reading back the deployed site (login, SAMPLE banner, wall state) | hub |

## 1. The token (author)

GitHub → Settings → Developer settings → Personal access tokens → **Fine-grained tokens** → Generate new token:

- Token name: `unworried-ledger-mirror`; Expiration: a custom date after the judging period (e.g. 2026-12-31).
- Repository access: **Only select repositories** → `unworried-ledger` (nothing else).
- Permissions → Repository permissions → **Contents: Read and write** (Metadata: Read-only is added by GitHub).
  Nothing else.

Paste it only into Render's environment (step 2). Never into chat, a file or a commit.

## 2. The Render web service (author)

Render needs the code from a GitHub repository: `simpleciki/unworried` (created private and pushed 2026-10-27 on
the author's go-ahead; made public for submission after a full-history secret scan, as the rules require a public
repository with an open-source licence). When connecting GitHub to Render, grant Render access to that one
repository only.

Settings:

| field | value |
|---|---|
| Instance type | Free |
| Build command | `npm ci` |
| Start command | `npm start` |
| `NODE_VERSION` | `26` — first deploy 2026-10-27 17:38 CDT: "Using Node.js version 26.12.1 via environment variable NODE_VERSION", build successful |

First deploy (2026-10-27, commit `1ca2793`): live at https://unworried.onrender.com — `GET /` 200, `/api/me`
401 without a login, start log "ledger mirror: no ledger in the mirror yet — model calls stay off" (the token
reached the private repository; an absent file is a 404, not an auth error), wall OFF. `npm ci` reports 3
vulnerabilities (1 moderate, 2 critical) — all in vitest's dev tree (`tinypool`, `@vitest/mocker`);
`npm audit --omit=dev` finds 0.

Environment (secret values typed by the author in Render's dashboard):

| variable | value |
|---|---|
| `HOST` | `0.0.0.0` (Render sets `PORT` itself) |
| `JUDGE_ACCOUNTS` | `name:secret` pairs for the judges and the author |
| `NEBIUS_API_KEY` | the demo key (a second key, not the development one) |
| `NEBIUS_BASE_URL` | as in `.env.example` |
| `NEBIUS_MODEL` | the id confirmed in S7 |
| `LLM_ENABLED` | `true` only after the mirror is seeded; `false` until then |
| `LEDGER_MIRROR_REPO` | `simpleciki/unworried-ledger` |
| `LEDGER_MIRROR_TOKEN` | the token from step 1 |
| `SPEND_DAY_USD` | `1` during judging (spec §1.2 ④) |
| other `SPEND_*` | the defaults unless the author changes them |

## 3. Seeding the mirror (hub, after S7)

The mirror starts as a byte-for-byte copy of the author's local ledger, so development spend is part of the
hosted total. After seeding, spend only from the hosted site. Until the mirror has a file, the hosted wall
stays off and the site runs in SAMPLE mode (`ledger mirror: no ledger in the mirror yet`).

## What a judge sees on Render Free

- The first page after 15 idle minutes takes about a minute (the service spins up).
- After an idle spin-down the local disk is gone: log in again; the sandbox is the seed again. The spend
  ledger is not affected (it comes back from the mirror).
- Write both in the Devpost testing instructions.
