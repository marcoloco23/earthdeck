# Plan: Offline test suite + CI

**Date**: 2026-06-06
**Status**: COMPLETED
**Phase**: Engineering quality (cross-cutting; supports the whole roadmap)

## Goal

A real, **fully-offline** automated test suite so we can make verified progress without
network or API creds. Cover the pure logic (parsers, axis/URL transforms, masking,
provenance, validation) directly, and the HTTP clients via a mocked `fetch` against recorded
response fixtures. Wire `pnpm test` and a GitHub Actions CI that runs typecheck + test + build.

## Background

The repo has zero test infrastructure — every "verification" so far was a throwaway inline
node script. This session has no outbound network to data APIs and no creds, so we need a
loop that proves correctness offline. Two facts make this work: (1) lots of bug-prone logic
is pure (FIRMS CSV parser, STAC parser, SCL mask, EONET/Worldview/FIRMS axis-order URL
building, the `/ingest` security validator); (2) the npm registry is reachable, so
`install → typecheck → test → build` all run offline after install.

## Approach

- Runner: **Node's built-in `node:test` + `node:assert`** — zero new deps (matches the
  pinned/minimal-deps rule), run through the existing `tsx` dev dep:
  `node --import tsx --test test/*.test.ts`. (Spiked — works, resolves `.js`→`.ts` imports.)
- Network: a tiny `test/helpers.ts` that swaps `globalThis.fetch` for a mock returning real
  `Response` objects (so `.ok/.text()/.json()/.headers/.arrayBuffer()` behave), capturing
  calls so we can assert on the URL/axis transforms. No real requests, ever.

## Implementation steps

- [ ] export `validateIngest` from `src/dashboard/server.ts` (the security boundary).
- [ ] `test/helpers.ts` — `mockFetch(responder)` + `jsonResponse/textResponse/binaryResponse`.
- [ ] `test/util.test.ts` — addDays/isoDate/assertBBox(valid+invalid)/heightFor/clampWidth/bboxCenter.
- [ ] `test/evalscripts.test.ts` — SCL mask integrity (incl. NDWI keeps water, byte-identical
      condition), maskedClassesFor, unknown index throws.
- [ ] `test/provenance.test.ts` — stats vs image kinds; scenes/validPct presence.
- [ ] `test/stac.test.ts` — parseStacFeatures fixtures + stacSearch (mocked: success, cloud
      `query` body, 403, non-JSON).
- [ ] `test/nasa.test.ts` — parseFiresCsv (VIIRS letters, MODIS numeric, error text);
      snapshot/events/fires URL + axis-order (mocked); error paths.
- [ ] `test/geo.test.ts` — geocode (mocked: boundingbox→bbox order, no-match throws).
- [ ] `test/copernicus.test.ts` — token cache/refresh-on-401, statistics parse (validPct,
      "no valid data" throw), search parse + `Accept: */*`, maxCloud filter.
- [ ] `test/validate-ingest.test.ts` — id charset (XSS payload rejected), type allow-list,
      image mime allow-list, images cap.
- [ ] `package.json`: `test` + `test:watch` scripts.
- [ ] `.github/workflows/ci.yml`: install → typecheck → test → build (offline after install).

## Files to create / modify

| File | Change |
| --- | --- |
| `src/dashboard/server.ts` | export `validateIngest` |
| `test/helpers.ts` + `test/*.test.ts` | NEW — the suite |
| `package.json` | test scripts |
| `.github/workflows/ci.yml` | NEW — CI |

## Testing

- `pnpm test` green locally; `npx tsc` still green; suite runs with no network access
  (verified by the fact the data APIs 403 — mocked fetch never hits them).

## Risks / edge cases

- Mock must restore `globalThis.fetch` after each test (use `t.after`) so tests don't leak.
- Real `Response` from a Buffer body for image endpoints (Uint8Array subclass → OK).
- Keep tests flat in `test/`; `helpers.ts` doesn't match `*.test.ts` so isn't run as a test.

## Definition of done

- [x] `pnpm test` passes (53 tests); CI workflow added
- [x] CONTINUITY.md + PROGRESS.md + ROADMAP.md updated (ticked "add CI"); CLAUDE.md documents
      the offline-first testing approach

## Notes / log

- 2026-06-06: node:test + tsx spiked green on Node 22. Chose built-in runner to add zero deps.
- 2026-06-06: COMPLETED. 9 test files, 53 tests, all green offline; `tsconfig.test.json` type-
  checks src+test (tsc build still only emits src→dist, verified no test files leak to dist);
  CI runs typecheck → typecheck:test → test → build. Exported `validateIngest` to test the
  security boundary. One bug found — in the *test* (heightFor expectation), not the code.
