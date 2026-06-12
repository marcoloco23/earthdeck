# Plan: Temporal-median compositing (Horizon 1 #4)

**Date**: 2026-06-12
**Status**: COMPLETED
**Phase**: Horizon 1 — Trustworthy analyst (classic change detection, item 4)

## Goal

Add per-pixel **temporal-median compositing** to the Sentinel-2 tools (`eo_render`,
`eo_index`, `eo_compare`): instead of picking pixels from the least-cloudy scene, compute
the median of every *clear* observation in the window. Residual cloud/haze/shadow that
survives scene-level selection vanishes in the median — the classic robust baseline for
change detection.

## Background

ROADMAP Horizon 1: "Classic change detection as tools: temporal median compositing…".
Today the composite is `mosaickingOrder: leastCC` (scene-level least-cloudy pick). That
leaves residual cloud in renders and lets one hazy scene skew a window's index stats —
exactly the noise that makes `eo_compare` deltas untrustworthy. Sentinel Hub evalscripts
support `mosaicking: "ORBIT"`, which hands `evaluatePixel` **all** acquisitions in the
window as a samples array — per-pixel median over masked-clear samples is then pure
evalscript JS. This session has real CDSE creds + network, so it can be live-verified.

## Approach

Option A: new separate tools (`eo_render_median`, …) — tool-count bloat, duplicated wiring.
Option B: a `composite: "leastCC" | "median"` option on the existing three tools, defaulting
to current behavior, with median driving new ORBIT-mosaicking evalscripts.
**Decision**: B — change detection is the same task, compositing is a quality knob. Default
unchanged (median costs more processing units: every orbit in the window is processed).

Details:
- One shared `clearCondition(excludeWater)` builder so the median scripts use the *same*
  SCL + s2cloudless mask as `statEvalscript` (single source of truth, like SCL_CLEAR_MASK).
  The existing byte-exact mask test must stay green.
- `medianRenderEvalscript(view)`: per-band median of clear samples → same visualization
  math as RENDER_EVALSCRIPTS. Render keeps water (excludeWater=false). Pixels with zero
  clear samples fall back to the median of *all* samples (best-effort, no black holes).
- `medianStatEvalscript(index)`: median of the index over clear samples; dataMask=0 when a
  pixel has no clear observation → validPct becomes "% of pixels with ≥1 clear obs".
- Source spec: ORBIT mosaicking ignores scene picking, so pass an explicit
  `{ collection: sentinel-2-l2a }` spec **without** `mosaickingOrder` (leastCC ordering is
  meaningless for ORBIT and risks API rejection). `maxCloud` still passes through (drops
  hopeless scenes early → fewer processing units).
- Window defaults: median needs multiple orbits (S2 revisit ≈5 days) → when
  `composite=median` and no explicit window, `eo_render` widens its default 14→45 days;
  `eo_index` 30 stays; `eo_compare` 25→45.
- Provenance: `composite.mosaicking` records `"ORBIT per-pixel median of clear observations"`
  vs `"leastCC"`; median *renders* now ARE per-pixel masked, so their cloudMask block lists
  the excluded classes (without open-water) instead of "no per-pixel cloud mask".

## Implementation steps

- [x] Plan file
- [x] `evalscripts.ts`: `clearCondition()`, `medianRenderEvalscript()`, `medianStatEvalscript()`
- [x] `provenance.ts`: `composite` opt → mosaicking text + image-mask description
- [x] `tools/analysis.ts`: `composite` zod option on eo_render/eo_index/eo_compare
- [x] tests: evalscripts (ORBIT, median math, mask reuse, water rule) + provenance (101 green)
- [x] `pnpm build && pnpm typecheck && pnpm typecheck:test && pnpm test`
- [x] live verify (`scripts/live-median.mjs`): median render visibly cloud-free vs leastCC;
      NDVI 0.670 @ 76% valid vs 0.675 @ 61%; compare São Félix −0.111 @ 96%/96% valid
- [x] CONTINUITY/PROGRESS/ROADMAP/README

## Files to create / modify

| File | Change |
| --- | --- |
| `src/evalscripts.ts` | clearCondition builder; median render + stat evalscripts |
| `src/provenance.ts` | composite kind in s2Provenance |
| `src/tools/analysis.ts` | `composite` option, wiring + descriptions, window defaults |
| `test/evalscripts.test.ts` | median script tests |
| `test/provenance.test.ts` | median provenance tests |

## Testing

Offline: new node:test checks (script shape, mask byte-reuse, median function, water kept
in renders / dropped for NDVI stats). Existing byte-exact statEvalscript test unchanged.
Live: `node scripts/live-drive.mjs` extended ad hoc — eo_index NDVI Manaus leastCC vs
median (expect similar mean, median slightly cleaner / validPct definition differs),
eo_render median trueColor (visibly less cloud), one eo_compare median run.

## Risks / edge cases

- ORBIT + mosaickingOrder may 400 → omit mosaickingOrder for median (tested live).
- Statistical API: one P{days}D bucket must still hand all orbits to evaluatePixel — verify
  live that sampleCount/validPct look sane.
- Processing-unit cost: median processes every orbit in the window — documented in the tool
  description; default stays leastCC.
- Zero clear samples: stats → dataMask 0 (counted in noDataCount); render → fallback
  unmasked median.

## Definition of done

- [ ] builds + typechecks; offline suite green
- [ ] live-verified median render + index + compare with real CDSE
- [ ] CONTINUITY.md + PROGRESS.md + ROADMAP.md updated

## Notes / log

- 2026-06-12: started; creds + network confirmed available this session.
