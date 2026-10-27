# Recorded model replies (SAMPLE mode)

One JSON file per reply, keyed by SHA-256 of (model id, system prompt, user prompt, temperature) — the
`FileCache` format from `src/llm/cache.ts`. The screen's model client reads this directory first, so the demo's
scripted sentences (see `docs/screen.md`, "The three demo routes") get their recorded replies even when the
spending wall is closed and the banner says "Model is off".

Only the author records here, with `RECORD_SAMPLES=yes npx tsx scripts/record-samples.ts` inside her approval
window. Everything else under `cache/` is ignored by git; this directory is committed.
