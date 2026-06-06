# Plan: Provenance block on every numeric/imagery output

**Date**: 2026-06-06
**Status**: COMPLETED
**Phase**: Horizon 1 — Trustworthy analyst (VISION §7, ROADMAP item 3)

## Goal

Attach a structured **provenance block** to every Copernicus output (`eo_render`,
`eo_index`, `eo_compare`) so each result is decision-support, not a bare number:
data source, sensor/collection, the composite time window + mosaicking order, the
cloud-mask method + the exact masked classes, % valid pixels, the contributing
Sentinel-2 scene IDs (best-effort), bbox, retrieval time, and a decision-support
disclaimer. Surface it in the tool text and on the dashboard cards.

## Background

v0.1 (Horizon 0) is shipped. The north-star (VISION) is the *trustworthy analyst*:
principle 4 is "verification by default — every quantitative output ships with
provenance (scene IDs, dates, sensor, baseline) … output is decision-support, not
decision." ROADMAP Horizon 1 lists this as item 3. It is the highest-leverage item
that can be **fully verified offline** (no live CDSE creds in this container), unlike
the cloud-masking upgrade (#1) and SAR (#2), which need real-API verification.

## Approach

- **A**: bolt a free-text "provenance" string onto each result. *Rejected* — not
  machine-readable, drifts from the actual mask logic.
- **B (chosen)**: a typed `Provenance` object built by one shared `src/provenance.ts`
  helper. The SCL masked-class list moves into a single shared constant in
  `evalscripts.ts` that BOTH the stat evalscript and the provenance description read,
  so the reported mask can never drift from the mask actually applied. Scene IDs are
  fetched best-effort (catalog search is free metadata, no processing units) and in
  parallel with the main call, wrapped so a failure or slowness never breaks the tool
  (mirrors the best-effort dashboard-push rule).

## Implementation steps

- [x] `evalscripts.ts`: extract SCL masked classes to a shared `SCL_CLEAR_MASK`
      constant (id + human label, always-list + water-for-non-NDWI); build
      `statEvalscript` from it so the mask and its description share one source.
- [x] `src/provenance.ts`: `Provenance` type + `s2Provenance({bbox,from,to,kind,index,
      validPct,scenes})` builder (`kind: "stats" | "image"`).
- [x] `tools/analysis.ts`: best-effort `scenesFor()` helper; attach provenance to
      `eo_render` (image), `eo_index` (stats), `eo_compare` (per-date) — in the tool
      text/meta AND the card payload.
- [x] `web/src/cards.ts`: compact, safe (`<details>`/textContent) provenance footer
      on imagery/index/compare cards.

## Files to create / modify

| File | Change |
| --- | --- |
| `src/evalscripts.ts` | shared `SCL_CLEAR_MASK` constant; `statEvalscript` derives the mask from it |
| `src/provenance.ts` | NEW — `Provenance` type + `s2Provenance()` builder |
| `src/tools/analysis.ts` | best-effort scene lookup; provenance in render/index/compare output + cards |
| `web/src/cards.ts` | safe provenance footer renderer |

## Testing

- `pnpm build` + `npx tsc --noEmit` green.
- Unit-smoke `statEvalscript` output: NDVI/NBR include `SCL!==6`, NDWI does not;
  the always-masked classes (1,3,8,9,10) all present — i.e. the refactor produces
  the same mask string as before.
- Smoke the provenance builder: stats-kind lists masked classes + validPct + scenes;
  image-kind reports the mosaic (no per-pixel mask), no validPct.
- Live CDSE verification deferred (no creds here) — note it in the ledgers.

## Risks / edge cases

- Best-effort scenes must never block/slow/break a tool → timeout + try/catch,
  omit on failure.
- Refactoring `statEvalscript` must produce a byte-identical mask condition →
  assert in the smoke test.
- Card payload is arbitrary JSON (server validates only that it's an object), so a
  new `provenance` key needs no server change. Confirmed in `dashboard/server.ts`.

## Definition of done

- [x] builds + typechecks
- [x] offline smoke passes (evalscript + provenance shape) — 27 checks
- [x] CONTINUITY.md + PROGRESS.md + ROADMAP.md updated

## Notes / log

- 2026-06-06: chose provenance (offline-verifiable) over cloud-masking/SAR (need live
  CDSE). Designed the shared-mask-constant approach so provenance stays honest and the
  later Cloud Score+/s2cloudless upgrade is a localized change.
- 2026-06-06: COMPLETED. `tsc` + `vite build` green; 27 offline checks pass (mask
  integrity incl. byte-identical refactor + NDWI-keeps-water; provenance shapes for both
  kinds); MCP lists all 8 tools. Live CDSE imagery/stats verification deferred (no creds).
