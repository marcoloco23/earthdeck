# Plan: GFW integrated deforestation alerts (Horizon 1 #5)

**Date**: 2026-06-12
**Status**: COMPLETED
**Phase**: Horizon 1 — Trustworthy analyst (consume GFW alerts instead of rebuilding deforestation)

## Goal

A `forest_alerts` tool that surfaces **GFW integrated deforestation alerts** (GLAD-L +
GLAD-S2 + RADD fused by UMD/WUR; daily, 10 m, 30°N–30°S) for a bbox/time window: total
alert count + area (ha), daily counts (→ dashboard series chart), and confidence breakdown.

## Background

ROADMAP: "Consume GFW alerts (GLAD-L/GLAD-S2/RADD/DIST-ALERT) instead of rebuilding
deforestation." User created a GFW account (marcsperzel1@googlemail.com, 2026-06-12).
API grounded live this session against `data-api.globalforestwatch.org` (OpenAPI + probes):

- **Auth**: `POST /auth/token` (form: username/password) → bearer; `POST /auth/apikey`
  (Bearer; JSON `{alias, organization, email, domains: []}`) → key. Data calls take header
  **`x-api-key`** (query param also accepted). Keyless query → clean 403 with docs link.
- **Data**: `POST /dataset/gfw_integrated_alerts/latest/query/json` body
  `{sql, geometry: <GeoJSON>}`; SQL over pseudo-table `results`. `latest` 307-redirects to
  the daily version (e.g. v20260610) — follow redirects, keep POST (308/307 + fetch handles
  via `redirect: "follow"`; verify live).
- **Fields** (confirmed via `/fields`): `gfw_integrated_alerts__date`,
  `gfw_integrated_alerts__confidence` (2 nominal / 3 high / 4 highest; meanings come back as
  strings in query JSON), `gfw_integrated_alerts__intensity`, `area__ha`, lat/lon.
- UNCONFIRMED until a key exists: whether WHERE on confidence compares strings
  (`IN ('high','highest')`) or numbers — live-verify both, keep the working one.

## Approach

Option A: pixel-point list (like fires_in) — huge result sets at 10 m; needs caps anyway.
Option B: aggregate-first — count + SUM(area__ha) overall and per day + per confidence;
series card on the dashboard; no new card types.
**Decision**: B (aggregates are what an analyst needs; points can come later via intensity
tiles). Two parallel queries: (1) totals + confidence breakdown via GROUP BY confidence,
(2) daily counts via GROUP BY date → series card.

- Env: `GFW_API_KEY` (config helper + README keys table + .env.example + doctor presence
  check). No-key error mirrors fires_in: link to the create-key guide.
- Client `src/clients/gfw.ts`: `gfwQuery(dataset, sql, geometry, key)` + pure
  `bboxToPolygon`, `alertsSql*` builders, row parsers (fixture-tested offline).
- Tool `src/tools/forest.ts`: `forest_alerts(bbox, days=90, minConfidence?)`; bbox area
  capped (≤ 4 deg²) with a clear "tile your AOI" error; notes the 30°N–30°S coverage.
- Dashboard: `series` card with daily alert counts (existing card type, zero new deps).

## Implementation steps

- [x] config: `gfwApiKey()`
- [x] client + SQL builders + parsers (`src/clients/gfw.ts`)
- [x] `forest_alerts` tool + register (tool #24); MCP smoke: 24 tools listed, clean no-key error
- [x] offline tests (9 new; 110 total green): URL/header/body shape, SQL builders,
      parsers, 403/500 paths, parallel summary+daily with confidence filter
- [x] README (tool table, keys table) + .env.example + doctor probe (tiny COUNT query)
- [x] key minted via /auth/token + /auth/apikey (account me@marcsperzel.com; expires
      2027-06-12), set in .env → LIVE VERIFIED: São Félix do Xingu 90 d = 3697 alerts /
      45.2 ha (2546 high + 238 highest + 913 nominal); minConfidence=high → 2784 / 34.0 ha;
      doctor probe ✓. Gateway findings now encoded in the client + tests:
      **`origin` header required** (localhost), **`IN` unsupported** (string-equality OR
      chain), **`AS` aliases ignored** (parse `count`/`area__ha`), transient 403 → 1 retry.

## Files to create / modify

| File | Change |
| --- | --- |
| `src/config.ts` | `gfwApiKey()` |
| `src/clients/gfw.ts` | new client (query + SQL builders + parsers) |
| `src/tools/forest.ts` | new `forest_alerts` tool |
| `src/index.ts` | register |
| `test/gfw.test.ts` | new offline tests |
| `README.md`, `.env.example`, `src/doctor.ts` | key docs + probe |

## Testing

Offline: mocked-fetch tests assert endpoint URL, `x-api-key` header, `{sql, geometry}`
body, parser outputs from a recorded-shape fixture, no-key + 403 error paths, bbox cap.
Live (needs key): Amazon arc-of-deforestation bbox (e.g. [-52.2,-6.75,-51.8,-6.45]),
90 days — expect nonzero alerts; dashboard series card renders.

## Risks / edge cases

- POST through the 307 redirect must preserve method+body (Node fetch does for 307/308).
- Confidence WHERE syntax unconfirmed → isolate in one builder, verify live.
- Coverage is tropics-only (30°N–30°S): return a clear note for out-of-coverage bboxes.
- Big AOIs → on-the-fly raster query latency; bbox area cap + clear message.

## Definition of done

- [ ] builds + typechecks; offline suite green
- [ ] live-verified with the user's key
- [ ] CONTINUITY.md + PROGRESS.md + ROADMAP.md updated

## Notes / log

- 2026-06-12: API grounded live (no key yet): fields, auth flow, 403 message, version
  redirect all confirmed; user account exists.
- 2026-06-12 (later): key minted + everything live-verified; SQL dialect quirks found and
  fixed (origin header, no IN, no aliases, transient 403s). 111 offline tests green.
