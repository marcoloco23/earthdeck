# CONTINUITY.md — READ THIS FIRST. DO NOT SKIP.

This is the live state of the project. If you are an agent picking up work, read this whole
file, update the AGENT CHECKIN, then take the next item from the TASK QUEUE. The stable
reference is [CLAUDE.md](CLAUDE.md); the phase plan is [ROADMAP.md](ROADMAP.md).

---

## AGENT CHECKIN

- Agent read full file: YES
- Current task understood: YES
- Current task: **Session 6 complete (2026-06-12): Earth Pulse → simple setup → npm → renamed to earthdeck.**
  Latest: published to npm (earthdeck; overview-mcp deprecated w/ pointer), GitHub repo renamed
  (redirects in place), s2cloudless cloud masking (Horizon 1 #1) shipped + live-verified, and
  `earthdata_search` (NASA CMR catalog, 23rd tool) added. Previously this session: **Earth Pulse.** PR #1 (Session 5's blind-built
  SAR/STAC/provenance) live-verified with real creds and **merged**. Then the **planetary
  indicators layer** landed: 10 new zero-key tools (enso, ocean_temp, co2, global_temp,
  sea_ice, quakes, climate_history, air_quality, river_discharge, planet_pulse) + 3 new
  dashboard card types (series/quakes/pulse). **22 tools, 88 offline tests, all 16 E2E calls
  live-verified, dashboard screenshotted.** Next: Horizon 1 leftovers — cloud masking (#1),
  classic change detection (#4), GFW alerts (#5) — then Horizon 2 (AlphaEarth embeddings).
- Session started: 2026-06-12 (Session 6)

---

## WORKFLOW (every session)

1. Read this file fully. Update AGENT CHECKIN.
2. Take the next unchecked item in TASK QUEUE (below) / ROADMAP.md.
3. If the item introduces a new module or external surface, **write a plan first**: copy
   `.plans/_TEMPLATE.md` → `.plans/YYYY-MM-DD_<slug>.md`, fill Goal/Approach/Steps/Files.
4. Implement. Then run `pnpm build && pnpm typecheck`. Smoke-test the change.
5. Update this file (SESSION LOG + CURRENT STATE + TASK QUEUE) and add a PROGRESS.md entry.
   Tick the matching ROADMAP.md checkbox.
6. **Keep going** until the current phase is complete or you hit a blocker. Then stop and
   report.

Hard rules (full list in CLAUDE.md): dashboard push is best-effort and must never break a
tool · open data only · deps pinned exactly · no commit/push/publish without explicit user
approval · respect API quotas/ToS · cap image size and always return stats with images.

---

## CURRENT STATE (2026-06-12)

- **PR #1 merged.** Session 5's blind-built work (provenance, STAC, SAR ×3, tests+CI) was
  live-verified this session with the real `.env` creds — stac_search returned 5 real
  Sentinel-2 scenes + COG links; eo_index NDVI 0.667 with full provenance; sar_render viewed;
  sar_water 19.4% (Manaus, 100% valid); sar_flood +2 pts Apr→Jun (Amazon rising-water
  season — plausible). Merged via `gh pr merge 1 --merge`; main fast-forwarded.
- **Earth Pulse — the planetary indicators layer (Session 6, plan
  `.plans/2026-06-12_earth-pulse.md`).** The repo's scope grew from "satellite imagery" to
  **the data layer for the Earth system**: 10 new tools, all zero-key, all with historic
  series + trends. New shared series model (`src/series.ts`: linearTrend/decimate/
  monthlyMean/annualMean/summarize, all pure + tested). New clients:
  `clients/indicators.ts` (ONI + NOAA-rule `ensoPhase`, CO₂ Mauna Loa, GISTEMP, NSIDC sea
  ice v4 + climatology), `clients/erddap.ts` (OISST point SST 1981→now, auto-stride ≤400 pts,
  end clamped to dataset `(last)`), `clients/openmeteo.ts` (ERA5 archive 1940→, CAMS air
  quality, GloFAS discharge 1984→), `clients/usgs.ts` (FDSN quakes). New tools:
  `tools/ocean.ts` (enso, ocean_temp), `tools/indicators.ts` (co2, global_temp, sea_ice,
  planet_pulse — parallel + partial-failure tolerant), `tools/climate.ts` (climate_history,
  air_quality, river_discharge), `tools/quakes.ts` (quakes).
- **Dashboard: 3 new card types.** `series` (hand-rolled SVG chart, `web/src/chart.ts`,
  zero new deps; multi-line + dashed thresholds + legend), `quakes` (magnitude-scaled GPU
  circle layer + popups), `pulse` (vital-signs metric grid). Server `CARD_TYPES` allow-list
  extended; all built via DOM nodes/textContent (XSS-safe).
- **Live-verified (2026-06-12), all real APIs:** ENSO Neutral ONI +0.48 (MAM 2026, strongest
  El Niño NDJ 2015 +2.75); Niño3.4 SST 28.03 °C; CO₂ 432.34 ppm (+1.83 YoY, +25.7/decade);
  GISTEMP +1.12 °C (2026-05, +0.27 °C/decade since 1980); Arctic ice 10.759 M km² (−1.282 vs
  climatology, below p10), Antarctic 11.79 (−1.104, below p10); 20 quakes M5.5+ incl. M7.8
  Philippines; Berlin 1950→2026 warming ~+0.5 °C/decade recent; Delhi AQI 167 (PM2.5 63
  ⚠️ WHO); Rio Negro discharge 2.46× period mean (rising-water season — consistent with
  sar_flood!). planet_pulse degrades gracefully when one source throttles (EONET).
  **All 16 E2E calls green in one session** (`scripts/live-drive.mjs`); dashboard
  screenshotted with charts, quake markers, pulse grid.
- **22 tools, 88 offline tests, build + typecheck green.**
- **This session (5): Provenance block (Horizon 1 item 3).** Every Copernicus output
  (`eo_render`/`eo_index`/`eo_compare`) now carries a structured `provenance` block — data
  source, sensor/collection, composite window + mosaicking, cloud-mask method + the exact
  masked SCL classes, % valid, best-effort contributing scene IDs, bbox, retrieved-at, and a
  decision-support disclaimer — in the tool output **and** the dashboard cards.
  New `src/provenance.ts`; SCL masked-class list now a single shared constant in
  `evalscripts.ts` (`SCL_CLEAR_MASK` + `maskedClassesFor`) so the reported mask can't drift
  from the applied mask. Build + typecheck green; 27 offline checks pass (incl. byte-identical
  mask refactor); MCP lists all 8 tools.
- **Also this session: internal STAC layer (Horizon 1 item 6).** New `stac_search` tool
  (`src/tools/stac.ts`, `src/clients/stac.ts`) hits the open, **no-auth Earth Search (Element
  84)** STAC API — a **zero-key** scene search (today's `eo_search` needs CDSE OAuth) that
  also returns **COG asset URLs** (the Horizon 2 substrate). Endpoint configurable via
  `EARTHDECK_STAC_URL` (→ Planetary Computer / self-hosted). Now **9 tools**. The parser
  `parseStacFeatures()` is pure + fixture-tested (15 checks); the no-network error path is
  graceful (`isError`, clean message).
- **Also this session: offline test infrastructure.** New `test/` suite on Node's built-in
  runner (`node:test`, **zero new deps**), run via `tsx`: **53 tests across 9 files**, all
  green with **no network and no creds** — every HTTP client goes through a `fetch` mock
  (`test/helpers.ts`) against fixtures. Covers pure logic (FIRMS/STAC parsers, SCL mask,
  provenance, util) + the bug-prone client transforms (Worldview/EONET/FIRMS bbox axis order,
  Copernicus OAuth token cache + 401 refresh, geocode) + the `/ingest` XSS security boundary
  (`validateIngest`, now exported). `pnpm test` / `pnpm typecheck:test`; **GitHub Actions CI**
  (`.github/workflows/ci.yml`) runs typecheck → test → build on push/PR. This is the answer to
  "how do we work offline" — verified progress no longer depends on live APIs.
- **Also this session: Sentinel-1 SAR (Horizon 1 item 2 — the #1 weakness).** New `sar_render`
  tool (all-weather radar; VV / VH / VV-VH-ratio false-color; GAMMA0 terrain-corrected). To get
  there, generalized `CopernicusClient` to target any collection via a `DataSourceSpec`
  (`buildInput` + `s2Source`) — the Sentinel-2 request body is unchanged (deep-equality test
  guards it). Added `SAR_EVALSCRIPTS` and `sarProvenance` (no cloud mask — records all-weather
  as the advantage). Added `sar_water` (all-weather water/flood extent: water % of the AOI from
  low VV backscatter, via the now-generalized `statistics()` + a binary water evalscript whose
  mean = water fraction; thresholdDb default −17) and `sar_flood` (flood onset: Δ water %
  between a pre-event baseline and a post-event date, with a pure unit-tested `floodResult`
  helper). **12 tools, 65 tests.** ⚠️ Live S1 render/stats + threshold/visualization-gain tuning
  deferred (documented starting points); the request-body shapes, evalscripts, water-fraction +
  flood-delta logic, and provenance are offline-verified.
- **This container has NO `.env`/creds and NO outbound network** (all hosts 403 via policy —
  even the open STAC endpoints), so ALL live API verification is deferred this session. The
  provenance + STAC-parser work is pure, fully offline-verifiable logic.
- Next (need live CDSE creds AND/OR network to verify): **cloud-masking upgrade** (Cloud
  Score+ / s2cloudless / OmniCloudMask, item 1 — highest leverage) and **Sentinel-1 SAR**
  (item 2). The shared mask constant + provenance `cloudMask.method` field are set up to make
  the masking upgrade a localized change. Also pending: **live-verify `stac_search`** against
  Earth Search the moment a session has network.

## TASK QUEUE

Phase 0 — Scaffold: ✅ done
Phase 1 — Zero-key slice: ✅ done
Phase 2 — Fires: ✅ done + live-verified (133 real detections, Western US)
Phase 3 — Copernicus core: ✅ done + live-verified (Sentinel-2 render + NDVI 0.279 + search)
Phase 4 — Change detection: ✅ done + live-verified (São Félix do Xingu NDVI −0.146, 2019→2025)

Phases 0–5 (Horizon 0): ✅ done + shipped public. 8 tools, all live-verified.

Horizon 1 — Trustworthy analyst (current):
- [x] **Provenance block** on every numeric/imagery output (this session) — offline-verified.
- [x] **Internal STAC layer** — `stac_search` (Earth Search, no key, COG URLs) (this session)
      — offline-verified (15 parser checks); ⚠️ live Earth Search call deferred (no network).
- [x] **Sentinel-1 SAR** (item 2) — `sar_render` backscatter (VV/VH/false-color) + `sar_water`
      (water/flood extent) + `sar_flood` (flood onset, Δ water between two dates), via a
      generalized multi-collection client (this session). ⚠️ live render/stats + threshold/viz-gain tuning deferred.
- [ ] **Better cloud masking** (item 1, highest leverage) — Cloud Score+ / s2cloudless /
      OmniCloudMask behind `eo_index`/`eo_render`/`eo_compare`. ⚠️ needs live CDSE to verify.
- [ ] Classic change detection (#4, temporal-median compositing) · consume GFW alerts (#5) ·
      STAC-backed render path (see ROADMAP).

Earth Pulse — planetary indicators (Session 6): ✅ done + live-verified (see ROADMAP section).
- [x] 10 zero-key tools: enso · ocean_temp · co2 · global_temp · sea_ice · quakes ·
      climate_history · air_quality · river_discharge · planet_pulse
- [x] series/quakes/pulse dashboard cards + SVG chart renderer (no new deps)
- [x] Offline tests 65 → 88; full 16-call live E2E green; dashboard screenshotted

Onboarding (Session 6, "make it super simple"): ✅ done + live-verified
- [x] `earthdeck demo` — zero-key wow path: starts the dashboard, runs the real MCP
      server in-process (InMemoryTransport), calls 7 zero-key tools, opens the browser.
- [x] `earthdeck doctor` — checks Node, env keys, and live reachability of all 9
      zero-key sources + CDSE OAuth + FIRMS key status (with quota); 1 retry on transient
      throttles; prints exactly what's ready and the links to fix what isn't.
- [x] README restructured: 30-second `npx … demo` quickstart + `claude mcp add` one-liner
      ABOVE the tool tables; keys table with direct links; doctor output sample.

22 tools total. Build + typecheck green. **88 offline tests green** (`pnpm test`).
Live driver: `node scripts/live-drive.mjs [tool …]` (boots dashboard on :5099, reads `.env`).

Engineering quality (cross-cutting):
- [x] Offline `node:test` suite (53 tests, network mocked) + GitHub Actions CI. (this session)
- [ ] Publish to npm (currently `npx github:` install).

Useful test fixtures: Amazon near Manaus bbox `[-60.2,-3.3,-59.8,-2.9]`; events smoke
returns Tropical Storm Amanda. Run the dashboard on a non-default port to avoid clashes:
`EARTHDECK_DASHBOARD_PORT=5009 node dist/cli.js dashboard`, then point tools at it with
`EARTHDECK_DASHBOARD_URL=http://127.0.0.1:5009`.

---

## SESSION LOG

### 2026-06-12 — Session 6c (rename → earthdeck; npm; cloud masking; NASA CMR)
- **Renamed the project to `earthdeck`** (user choice; npm/GitHub searchability). GitHub repo
  renamed (old URLs redirect); npm `earthdeck@0.3.x` published; `overview-mcp` deprecated with
  a pointer (kept installable; `overview-mcp` bin alias retained in the earthdeck package).
  Env prefix is now `EARTHDECK_*` with `OVERVIEW_*` still honored (config.ts `env()` helper).
- **Cloud masking rung 1 (Horizon 1 #1)**: stat evalscripts now mask SCL + s2cloudless
  (CLM=1 or CLP≥102/255) — CDSE band support live-confirmed first. Provenance method/classes
  updated via shared constants. Live: Manaus validPct 64→61%, NDVI 0.667→0.675.
- **`earthdata_search` (tool #23)**: NASA CMR collections search (keyless) — topic/bbox/time
  → most-used datasets with concept ids + landing pages; search card lists collections.
  CMR *granule* endpoint was timing out repeatedly (2026-06-12) → granule-level search
  delegated to NASA's hosted Earthdata MCP (documented in README "Goes well with").
- `demo`/`doctor` commands added earlier this session (see 6b note in PROGRESS); doctor now
  probes CMR too (10 zero-key sources).

### 2026-06-12 — Session 6 (PR #1 verification + merge; Earth Pulse)
- Live-verified everything Session 5 built blind, with real creds: 65/65 offline tests, then
  stac_search (5 real S2 scenes + COG links), eo_index provenance (NDVI 0.667, 64% valid),
  sar_render (S1 false-color viewed), sar_water (19.4%, 100% valid), sar_flood (+2 pts
  Apr→Jun over Manaus — Amazon rising-water season). Merged PR #1 (`--merge`, branch deleted).
- **Earth Pulse:** live-grounded 9 data sources with curl first (ONI, CO₂, GISTEMP, NSIDC
  v4 — note: v3 path is dead, v4 + climatology is current —, USGS FDSN, ERDDAP OISST incl.
  stride + `(last)`, Open-Meteo archive/air/flood; Open-Meteo *marine* SST history only
  reaches ~2022 → used ERDDAP OISST for the long series). Then plan → series model → 4
  clients (parsers pure + fixture-tested) → 10 tools → 3 dashboard card types → 23 new
  offline tests → full live E2E (16 calls) → screenshots.
- Gotchas: ERDDAP strided multi-decade reads can take ~60 s on first hit (cached after);
  ONI seasons map to mid-months (DJF → Jan per CPC); GISTEMP uses `***` for missing; NSIDC
  v4 CSV quotes the source-file column (regex parse, not naive split); `yearFraction` of a
  bare year must land mid-year or annual-series trends skew.
- Server instructions rewritten around the "data layer for the Earth system" framing +
  cross-referencing hints (ENSO ↔ fires/floods/SST; discharge ↔ SAR floods).

### 2026-06-06 — Session 5 (SAR flood onset)
- Added `sar_flood(bbox, dateBefore, dateAfter, …)` — composes the water measurement across two
  dates (pre-event baseline vs post-event) and reports the Δ water %: positive over a short
  window = flooding. All-weather, so it works for storms/monsoons optical can't see through.
- Extracted a pure `floodResult()` helper (delta, low-quality flag, interpretation) and
  unit-tested it directly (`test/sar.test.ts`) — flood/recede/unchanged/rounding/low-coverage.
- Verified offline: 65 tests green; typecheck (src+test) + build green; MCP lists 12 tools.
  ⚠️ Live S1 stats deferred.

### 2026-06-06 — Session 5 (SAR water/flood extent)
- Added `sar_water` — quantifies the water-covered fraction of an AOI from Sentinel-1 VV
  backscatter (water/smooth = low γ⁰), all-weather flood/water signal. Generalized
  `statistics()` to accept a `source` (mirrors the `process()` refactor); a binary water
  evalscript whose Statistical-API mean = water fraction; thresholdDb (default −17) → linear.
- Verified offline: 60 tests green (water evalscript threshold/bands; S1 statistics body shape
  + water-fraction from a mocked response; S2 statistics unchanged); typecheck (src+test) +
  build green; MCP lists 11 tools. ⚠️ Live S1 stats + threshold tuning deferred.

### 2026-06-06 — Session 5 (Sentinel-1 SAR — the all-weather answer)
- Added `sar_render` (Sentinel-1 GRD backscatter: VV / VH / VV-VH-ratio false-color; GAMMA0
  terrain-corrected, most-recent in a lookback window) — the start of closing our #1 weakness.
- Generalized `CopernicusClient`: `DataSourceSpec` + `buildInput`/`s2Source` so Process can
  target any collection; the **S2 request body is byte-unchanged** (deep-equality test guards
  it). New `SAR_EVALSCRIPTS` (sqrt-stretch viz) + `sarProvenance` (all-weather → no cloud mask).
- Verified offline: 57 tests green (SAR evalscripts, S1 vs S2 request-body shape, SAR
  provenance), typecheck (src+test) + build green, MCP lists 10 tools, no-creds path returns a
  clean error. ⚠️ Live S1 render + visualization-gain tuning deferred (no creds/network) —
  gains documented as a starting point.

### 2026-06-06 — Session 5 (offline test suite + CI)
- Built the thing that unblocks all future offline work: a `node:test` suite (zero new deps,
  run via `tsx`) with a `fetch` mock so HTTP clients are tested without network. **53 tests,
  9 files**, all green offline. Covered pure logic + the bug-prone transforms + the `/ingest`
  security validator (exported `validateIngest`).
- Added `tsconfig.test.json` (type-checks src+test; the `tsc` build still only emits
  src→dist — verified no test files leak to `dist/`), `pnpm test`/`test:watch`/`typecheck:test`
  scripts, and `.github/workflows/ci.yml` (typecheck → typecheck:test → test → build).
- CLAUDE.md now documents the offline-first testing approach; ROADMAP "add CI" ticked.
- Verified the full CI sequence locally: all green; the only failure found was a wrong
  expectation in my own test (heightFor), fixed — the code was right.

### 2026-06-06 — Session 5 (Horizon 1: internal STAC layer)
- Second Horizon 1 step (item 6). With no creds AND no outbound network (all hosts 403),
  chose the most offline-verifiable foundational item: a provider-independent STAC search.
- New `src/clients/stac.ts` (pure `parseStacFeatures()` + thin `stacSearch()` fetch wrapper),
  `src/tools/stac.ts` (`stac_search`, no key), `config.stacUrl()` (`EARTHDECK_STAC_URL` ??
  Earth Search). Returns scene ids/dates/cloud + **COG asset URLs**; endpoint swappable to
  Planetary Computer / self-hosted. Registered in `index.ts` (9 tools); README + `.env.example`
  updated.
- Verified offline: `tsc` + `vite build` green; **15 parser fixture checks** (6→4 bbox
  normalize, data-vs-thumbnail asset split, least-cloudy sort, `maxCloud` filter, malformed
  feature skipped, missing-features → []); MCP lists `stac_search`; live call returns a clean
  wrapped error (`403 Host not in allowlist`) — confirms fetch wiring + graceful failure.
  Live Earth Search response parsing deferred to a session with network.

### 2026-06-06 — Session 5 (Horizon 1: provenance block)
- First Horizon 1 step. Chose the **provenance block** (item 3) because it's the
  highest-leverage item that's **fully offline-verifiable** — this container has no CDSE
  creds, so the cloud-masking (item 1) and SAR (item 2) upgrades can't be live-verified yet.
- New `src/provenance.ts`: `Provenance` type + `s2Provenance({kind:"stats"|"image",…})`.
  Extracted the SCL masked-class list into one shared `SCL_CLEAR_MASK` constant +
  `maskedClassesFor()` in `evalscripts.ts`, and rebuilt `statEvalscript` from it — so the
  provenance description and the applied mask share one source of truth (verified
  byte-identical to the old hardcoded condition).
- Wired provenance into `eo_render` (image), `eo_index` (stats), `eo_compare` (per-date) —
  in the tool text/meta AND the card payload. Contributing scene IDs are a **best-effort**
  catalog lookup (free metadata, runs in parallel, 4s-timeout + swallow → never blocks/breaks
  a tool). Dashboard cards gained a safe, collapsible provenance footer (`web/src/cards.ts` +
  CSS), built via DOM nodes/textContent (scene ids come from upstream).
- Verified: `tsc` + `vite build` green; 27 offline checks pass (mask integrity + provenance
  shapes); MCP lists all 8 tools. Live CDSE imagery/stats verification deferred to a session
  with creds.

### 2026-06-05 — Session 4 (Phase 4 change detection)
- Extended the card model to carry multiple images (`IngestPayload.images` /
  `Card.imageUrls`; server stores at `/img/{id}::{n}`, validated).
- `eo_compare(bbox, dateA, dateB, index)`: 2 renders + 2 index stats (parallel) → delta;
  dashboard `compare` card (before/after + Δ) + `showCompare` map overlay.
- Live-verified: São Félix do Xingu 2019→2025 NDVI mean −0.146 (Novo Progresso −0.112);
  before/after renders clearly show forest → cleared land; dashboard card screenshotted.

### 2026-06-05 — Session 3 (Phase 3 Copernicus core)
- Grounded all CDSE API shapes with live calls (OAuth 1800s; Process PNG; Statistical
  needs dataFilter.timeRange + FLOAT32 + a fitting bucket; Catalog returns geo+json).
- Built `copernicus.ts` (token cache + refresh-on-401), `evalscripts.ts`, and
  `tools/analysis.ts` (`eo_render`/`eo_index`/`eo_search`) + dashboard index/search cards.
- Fixed two live bugs: catalog 406 (Accept must be `*/*`) and empty stats (bucket length
  must fit inside the window → `floor(span)`).
- Live-verified with real CDSE creds: rendered 10 m Sentinel-2 of Manaus (trueColor + NDVI
  ramp, viewed), NDVI mean 0.279, scene search with cloud %, dashboard screenshot. No-creds
  path returns a clean error.

### 2026-06-05 — Session 2 (review/hardening + Phase 2 fires)
- Independent code review → fixed WebGL-kills-feed, duplicate SSE connect, false-color
  swath gaps; hardened the HTTP server (loopback bind, ingest allow-list, malformed-URL
  400, SSE/process safety nets). Committed `ad38c96`.
- Phase 2: FIRMS client (`fires()` + header-keyed `parseFiresCsv()` for VIIRS & MODIS),
  `fires_in` tool, dashboard GPU fire-marker layer (`showFires`) + `fires` feed card.
- Verified: parser (both sensors + error path), tool registration, no-key graceful error,
  90-point cluster rendered on the map (screenshot). Live FIRMS call deferred (needs key).

### 2026-06-05 — Session 1 (scaffold + zero-key slice)
- Created repo, `git init`, all config files (pinned deps mirroring knuspr-mcp + vite/maplibre).
- Wrote the full roadmap scaffold: CLAUDE/AGENTS/ROADMAP/CONTINUITY/PROGRESS + `.plans/`.
- Built the MCP server (`cli.ts` dispatcher, `index.ts`, `result.ts`/`config.ts`/`util.ts`/
  `errors.ts`/`types.ts`), the dashboard server (`dashboard/server.ts` with `/ingest`,
  `/img/:id`, `/events` SSE, `/api/state`, static serve + fallback shell), the best-effort
  `dashboard/push.ts`, the NASA client (`clients/nasa.ts`: Worldview snapshot + EONET), and
  the two zero-key tools (`tools/imagery.ts` → `eo_snapshot`, `tools/events.ts` → `events`).
- Built the MapLibre dashboard UI (`web/`: GIBS Blue Marble basemap, imagery overlays,
  event markers, live SSE card feed, dark mission-control styling).
- **Verified**: `pnpm build` + `pnpm typecheck` green. Dashboard endpoints exercised via
  curl. MCP driven via the SDK client: tools listed, `events` returned live data + pushed,
  `eo_snapshot` returned a JPEG + pushed. All cards landed in `/api/state`.
- Not committed (rule 4). Next session: Phase 2 (fires).
