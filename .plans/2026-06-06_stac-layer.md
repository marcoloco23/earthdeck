# Plan: Internal STAC layer + zero-key `stac_search` tool

**Date**: 2026-06-06
**Status**: COMPLETED (offline; live Earth Search call deferred — no network this session)
**Phase**: Horizon 1 — Trustworthy analyst (VISION §7 / §8, ROADMAP item 6)

## Goal

Add a provider-independent **STAC search** path against the open, no-auth **Earth Search
(Element 84)** API: a new `stac_search` tool that finds Sentinel-2/Sentinel-1/Landsat scenes
for a bbox+date range and returns scene ids, dates, cloud cover, and **Cloud-Optimized
GeoTIFF (COG) asset URLs** — with **no API key**.

## Background

VISION §7 Horizon 1 / §8: "Internal STAC + COG data layer (Earth Search + Planetary
Computer STAC, anonymous) so we're not bound to one provider's API." Today every high-res
capability funnels through Copernicus OAuth (`eo_search`/`eo_render`/`eo_index`). This:
1. removes the single-provider dependency (resilience + the architecture spine in §8),
2. adds a **zero-key** scene search (strengthens the zero-setup demo path), and
3. returns **COG hrefs**, the substrate Horizon 2 reads (stackstac/embeddings).

**Constraint this session:** the container has no outbound network (all hosts 403 via the
policy) and no creds, so live Earth Search calls can't run. Per Phase-2 precedent (FIRMS
parser built + fixture-verified, live call deferred), I build to the documented STAC spec,
verify parsing/normalization against representative response fixtures, and defer the live
call.

## Approach

- **A**: extend the Copernicus client. *Rejected* — that's the dependency we're trying to
  break; STAC is a different (open, anonymous) API shape.
- **B (chosen)**: a standalone `src/clients/stac.ts` with a pure, exported
  `parseStacFeatures()` (unit-testable without network, like `parseFiresCsv`) + a thin
  `stacSearch()` fetch wrapper. Endpoint configurable (`EARTHDECK_STAC_URL`, default Earth
  Search) so Planetary Computer / a self-hosted STAC drop in later.

## Implementation steps

- [x] `config.ts`: `stacUrl()` → `EARTHDECK_STAC_URL` ?? Earth Search v1.
- [x] `src/clients/stac.ts`: `StacScene`/`StacAsset` types; `parseStacFeatures(json, maxCloud)`
      (normalize id/datetime/cloud/bbox[6→4]/data-COG assets/thumbnail, sort least-cloudy);
      `stacSearch(opts)` (POST /search, `query` cloud filter, graceful errors).
- [x] `src/tools/stac.ts`: `stac_search` tool (no key) → result + `search` card.
- [x] `index.ts`: register + mention in server instructions.
- [x] Fixture smoke test (representative Earth Search FeatureCollection) — 15 checks.

## Files to create / modify

| File | Change |
| --- | --- |
| `src/config.ts` | `stacUrl()` |
| `src/clients/stac.ts` | NEW — STAC client + pure parser |
| `src/tools/stac.ts` | NEW — `stac_search` tool |
| `src/index.ts` | register tool; update instructions |

## Testing

- `npx tsc` + `vite build` green; MCP lists 9 tools.
- Fixture smoke: parse a FeatureCollection (incl. a 6-element bbox, an `eo:cloud_cover`,
  data+thumbnail assets) → correct ids/dates/cloud, bbox normalized to 4, COG data assets
  extracted, thumbnail separated, sorted least-cloudy, `maxCloud` filter applied.
- Live Earth Search call **deferred** (no network this session) — note in ledgers.

## Risks / edge cases

- No live verification → code strictly to the STAC 1.0 / Earth Search docs; keep parsing
  defensive (missing assets/properties/bbox → nulls, never throw on a single odd feature).
- Context budget (rule 6): cap default `limit` (8) and return only data-COG assets per scene.
- bbox can be 6-element (3D) in STAC → normalize to [w,s,e,n].

## Definition of done

- [x] builds + typechecks; MCP lists the new tool (9 tools)
- [x] fixture smoke passes (15 checks) + graceful no-network error path
- [x] CONTINUITY.md + PROGRESS.md + ROADMAP.md (+ README, .env.example) updated

## Notes / log

- 2026-06-06: chose the STAC layer as the most offline-verifiable Horizon 1 item given no
  network/creds; pure parser is fixture-testable, fetch wrapper is thin and to-spec.
- 2026-06-06: COMPLETED offline. `tsc`+`vite build` green; 15 parser checks pass; live call
  returns a clean wrapped `403 Host not in allowlist` (proves fetch wiring + graceful
  failure). Live Earth Search response parsing deferred to a networked session.
