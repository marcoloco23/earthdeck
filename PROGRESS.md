# PROGRESS — earthdeck

Session-by-session history, newest first. Each entry: focus, what got done, build/smoke
status, next priorities. The live task pointer is in [CONTINUITY.md](CONTINUITY.md).

---

## Session: 2026-06-12 (later still) — temporal-median compositing (Horizon 1 #4) ✅

**Focus**: classic change detection rung 1 — per-pixel temporal-median composites so
residual cloud stops faking change.

**Done**:
- [x] **`composite: "leastCC" | "median"` on `eo_render`/`eo_index`/`eo_compare`** (default
      unchanged). Median uses Sentinel Hub `mosaicking: "ORBIT"`: evaluatePixel gets every
      acquisition in the window; per-pixel median over masked-clear samples. New
      `medianRenderEvalscript()` (water kept; zero-clear pixels fall back to an unmasked
      median — no black holes) + `medianStatEvalscript()` (dataMask=0 when no clear obs →
      validPct reads "% pixels with ≥1 clear observation"). Shared `clearCondition()` means
      the median mask is verbatim-identical to the leastCC stat mask (test-enforced).
- [x] Provenance records the method (`ORBIT per-pixel median of clear observations`),
      median renders list their excluded classes, disclaimers are composite-aware.
- [x] Window defaults widen for median (render 14→45 d, compare 25→45 d; S2 revisit ≈5 d).
- [x] 10 new offline tests (mask reuse byte-exact, water rules, channel order, the embedded
      `median()` JS executed directly) → **101 tests green**.

**Build/smoke**: build + typecheck green; **live-verified with real CDSE** (scripts/
live-median.mjs): Manaus median trueColor visibly cloud-free vs the cumulus-peppered
leastCC mosaic (45 d window, 12 s); NDVI median 0.670 / validPct 76 vs leastCC 0.675 / 61;
eo_compare São Félix do Xingu 2019→2025 NDVI −0.111 at 96%/96% valid — clean change signal.

**Also**: **`forest_alerts` (tool #24, GFW integrated deforestation alerts)** — grounded the
GFW Data API live (OpenAPI + probes: x-api-key header, POST {sql, geometry} to
/dataset/gfw_integrated_alerts/latest/query/json, fields + confidence values 2/3/4 =
nominal/high/highest, keyless 403 message, /latest→daily-version 307). New
`src/clients/gfw.ts` (SQL builders + parsers, pure + tested) and `src/tools/forest.ts`
(summary + confidence breakdown + daily counts → series card; 4 deg² AOI cap; tropics
coverage note). doctor probes the key with a tiny COUNT query. 9 new offline tests →
**111 green**; MCP lists 24 tools; no-key error is clean. Key minted via
/auth/token→/auth/apikey (me@marcsperzel.com, expires 2027-06-12) and **live-verified**:
São Félix do Xingu 90 d = 3697 alerts / 45.2 ha (2546 high + 238 highest + 913 nominal),
minConfidence=high → 2784 / 34.0 ha, doctor ✓. SQL-dialect quirks found live and encoded
in client+tests: origin header required, IN unsupported (OR chain), AS aliases ignored,
transient 403 → 1 retry.

**Next**: Horizon 2 — AlphaEarth embeddings → eo_similar.

---

## Session: 2026-06-12 (later) — npm · rename to earthdeck · s2cloudless masking · NASA CMR ✅

**Focus**: ship the simple-setup story end-to-end (npm), give the project a findable name,
land Horizon 1's cloud-masking upgrade, and integrate NASA's Earthdata catalog.

**Done**:
- [x] **Published to npm**: `overview-mcp@0.2.0`, then renamed → **`earthdeck`** (user-picked
      from vetted options; zero collisions on npm + GitHub). GitHub repo renamed (redirects);
      `overview-mcp` deprecated with a pointer; `overview-mcp` bin alias kept. `npx -y
      earthdeck` installs instantly (prebuilt dist). Env prefix `EARTHDECK_*` (+ `OVERVIEW_*`
      fallback).
- [x] **s2cloudless cloud masking (Horizon 1 #1, rung 1)** — CDSE CLM/CLP bands confirmed
      live, layered on top of SCL in stat evalscripts (either flags → excluded; CLP ≥ 40%).
      Shared constants keep mask ↔ provenance honest. Live: Manaus validPct 64→61%, NDVI
      0.667→0.675. Tests updated to pin the exact combined condition.
- [x] **`earthdata_search` (tool #23)** — NASA CMR collections search, keyless: topic/bbox/
      time → most-used datasets (concept ids, providers, coverage, landing pages); dashboard
      search card lists collections. CMR granule endpoint was down all day → granule search
      delegated to NASA's hosted Earthdata MCP (`https://cmr.earthdata.nasa.gov/mcp/v1`,
      documented in README). doctor now probes 10 zero-key sources.

**Build/smoke**: 91 offline tests green; earthdata_search live-verified (5 real collections
for "soil moisture" over Manaus); fresh `npx -y earthdeck --help` verified from the registry.

**Next**: temporal-median compositing (#4) · GFW alerts (#5) · Horizon 2 (AlphaEarth).

---

## Session: 2026-06-12 (PR #1 verified + merged · Earth Pulse — the planetary indicators layer) ✅

**Focus**: (1) live-verify and land PR #1 (Session 5's blind-built provenance/STAC/SAR/tests);
(2) grow the repo into **the data layer for the Earth system** — ocean temperatures over time
(El Niño tracking), CO₂, the global temperature record, sea ice, earthquakes, air quality,
river discharge, per-place climate history. All free, zero-key, with historic series + trends.

**Done**:
- [x] **PR #1 live-verified with real creds and merged**: 65/65 offline tests; stac_search →
      5 real Sentinel-2 scenes + COG links; eo_index NDVI 0.667 + full provenance block;
      sar_render viewed; sar_water 19.4% (100% valid); sar_flood +2 pts Apr→Jun over Manaus
      (Amazon rising-water season — plausible). Merged; main fast-forwarded; branch deleted.
- [x] **9 data sources live-grounded with curl before writing code** (recorded in
      `.plans/2026-06-12_earth-pulse.md`): NOAA CPC ONI · NOAA GML CO₂ · NASA GISTEMP ·
      NSIDC Sea Ice Index **v4** (v3 path is dead) + 1981–2010 climatology · USGS FDSN ·
      ERDDAP OISST (stride + `(last)` clamp) · Open-Meteo archive/air-quality/flood.
      Finding: Open-Meteo *marine* SST history only reaches ~2022 → ERDDAP OISST (1981→)
      is the long-series source.
- [x] **Shared series model** `src/series.ts` — linearTrend (OLS, per-decade), decimate
      (≤400 pts, ends kept), monthlyMean/annualMean, summarize; all pure, all tested.
- [x] **4 new clients** with pure exported parsers: `indicators.ts` (ONI + NOAA 5-season
      `ensoPhase` rule, CO₂, GISTEMP `***`-safe, NSIDC daily+climatology), `erddap.ts`
      (OISST point series, auto-stride, end clamped to dataset latest), `openmeteo.ts`
      (ERA5 1940→, CAMS, GloFAS), `usgs.ts` (FDSN GeoJSON → normalized quakes).
- [x] **10 new tools (→ 22 total)**: `enso`, `ocean_temp`, `co2`, `global_temp`, `sea_ice`,
      `quakes`, `climate_history`, `air_quality`, `river_discharge`, and `planet_pulse`
      (all vital signs in one parallel, partial-failure-tolerant call). Every result names
      its source and carries the series.
- [x] **Dashboard: 3 new card types** — `series` (hand-rolled SVG chart, `web/src/chart.ts`,
      zero new deps: multi-line, null-gap-aware, dashed thresholds, legend), `quakes`
      (magnitude-scaled GPU circle layer + popups), `pulse` (vital-signs grid). `CARD_TYPES`
      allow-list extended; everything DOM-node/textContent built (XSS-safe).
- [x] **Tests 65 → 88** (series math, ENSO phase rule incl. event definition, all parsers
      from live-shaped fixtures, ERDDAP clamp/stride, Open-Meteo error reasons, USGS bbox
      query bounds, out-of-range lat/lon rejected pre-network).

**Build/smoke**: build + typecheck + typecheck:test green; 88/88 offline tests; **all 16
live E2E calls green in one session** (`scripts/live-drive.mjs`, new). Live values
(2026-06-12): ENSO Neutral ONI +0.48 · Niño3.4 SST 28.03 °C · CO₂ 432.34 ppm (+1.83 YoY) ·
GISTEMP +1.12 °C · Arctic ice −1.282 M km² vs climatology (below p10), Antarctic −1.104
(below p10) · M7.8 Philippines · Delhi AQI 167 ⚠️ · Rio Negro 2.46× mean discharge
(consistent with sar_flood's +2 pts!). Dashboard screenshotted: pulse grid, charts, quake
markers over the GIBS basemap.

**Also this session — onboarding ("make it super simple")**: new `earthdeck demo`
(zero-key: dashboard + in-process MCP over InMemoryTransport + 7 live tool calls + browser
auto-open — verified with a clean env, all ✓, screenshotted) and `earthdeck doctor`
(probes all 9 zero-key sources with 1 retry, validates CDSE OAuth + FIRMS key incl. quota;
verified both no-key and full-key paths — 22/22 ready). README restructured: 30-second
demo + `claude mcp add` one-liner above the fold, free-keys table with links, doctor sample.

**Next**: Horizon 1 leftovers — cloud masking (#1), temporal-median compositing (#4), GFW
alerts (#5); then Horizon 2 (AlphaEarth embeddings → `eo_similar`). Tidy-up candidates:
**npm publish** (would turn `npx -y github:…` into `npx earthdeck` — needs user's npm
account); ERDDAP first-hit latency note (multi-decade strided reads ~60 s, cached after).

---

## Session: 2026-06-06 (Horizon 1 — SAR flood onset) ✅

**Focus**: `sar_flood` — water-extent change between two dates (flood onset). Composes the
`sar_water` measurement across a pre-event baseline and a post-event date; positive Δ over a
short window indicates new water. All-weather, so it works for storm/monsoon flooding optical
can't see through.

**Done**:
- [x] `sar_flood(bbox, dateBefore, dateAfter, windowDays?, thresholdDb?, orbitDirection?)` →
      water % before/after, the Δ (pts of the AOI), per-date validity + provenance, and an
      interpretation; pushes an index card.
- [x] Extracted a **pure `floodResult()`** helper (delta + rounding + low-quality flag +
      interpretation) so the new logic is unit-testable without the network.

**Build/smoke**: 65 tests green (5 new in `test/sar.test.ts`: flood / recede / unchanged /
one-decimal rounding / low-coverage flag); typecheck (src + test) + build green; MCP lists 12
tools. Live S1 stats deferred (no creds/network).

**Next**: cloud-masking upgrade (#1) or classic temporal-median compositing (#4); live-verify
the SAR tools once creds/network exist.

---

## Session: 2026-06-06 (Horizon 1 — SAR water/flood extent) ✅

**Focus**: `sar_water` — all-weather water/flood extent from Sentinel-1 (ROADMAP Horizon 1
item 2 follow-up). Water and smooth surfaces reflect radar away from the sensor → low VV
backscatter, so a threshold on VV γ⁰ is a robust water mask that works through cloud and night.

**Done**:
- [x] `sar_water(bbox, date?, windowDays?, thresholdDb?, orbitDirection?)` → water % of the
      AOI + % valid + threshold + provenance + interpretation; pushes an index card.
- [x] `sarWaterEvalscript(threshLinear)` — binary water band (VV < thresh ? 1 : 0), so the
      Statistical-API **mean = water fraction**; thresholdDb (default −17) → linear via 10^(dB/10).
- [x] Generalized `statistics()` to accept a `source?: DataSourceSpec` (mirrors the earlier
      `process()` refactor); SAR water passes the `sentinel-1-grd` GAMMA0 spec.

**Build/smoke**: 60 tests green (3 new — water evalscript threshold/bands; S1 statistics
request-body shape + water-fraction from a mocked response; S2 statistics unchanged);
typecheck (src + test) + build green; MCP lists 11 tools. **Live S1 stats + threshold tuning
deferred** (no creds/network); −17 dB is a documented starting point.

**Next**: SAR Δ-water (flood onset between two dates); cloud-masking upgrade (#1); live-verify
the SAR tools once creds/network exist.

---

## Session: 2026-06-06 (Horizon 1 — Sentinel-1 SAR) ✅

**Focus**: Sentinel-1 C-band SAR backscatter rendering (`sar_render`) — all-weather imagery
that sees through cloud, smoke, and night. VISION's #1 weakness ("the cloud answer");
ROADMAP Horizon 1 item 2. Built + tested offline; live render deferred (no creds/network).

**Done**:
- [x] `sar_render(bbox, date?, view?, windowDays?, orbitDirection?, width?)` — views
      falseColor (VV/VH/ratio), vv, vh; GAMMA0 terrain-corrected, most-recent scene in a
      lookback window. Image + provenance + imagery card.
- [x] Generalized `CopernicusClient` to target any collection: a `DataSourceSpec`
      (`collection`/`mosaickingOrder`/`dataFilter`/`processing`/`maxCloud`) drives `buildInput`;
      S2 callers use `s2Source()`, which reproduces the **exact previous request body**
      (deep-equality test guards the refactor). `ProcessOpts.source?` threads it through.
- [x] `SAR_EVALSCRIPTS` (sqrt-stretch viz over VV/VH) + `sarProvenance` — SAR has no cloud
      mask, so `cloudMask.method` records "all-weather" as the advantage, with a SAR-specific
      disclaimer (speckle, incidence-angle/orbit sensitivity).

**Build/smoke**: 57 tests green (4 new: SAR evalscripts, S1 vs S2 `/process` request body,
SAR provenance); typecheck (src + test) + build green; MCP lists 10 tools; `sar_render`
without creds returns the clean "set CDSE_*" error. **Live S1 render + visualization-gain
tuning deferred** (no creds/network) — gains are a documented starting point to tune against
real scenes.

**Next**: SAR flood/water mapping + a `sar_*` stat tool; cloud-masking upgrade (#1); and
live-verify the SAR render once creds/network exist.

---

## Session: 2026-06-06 (offline test suite + CI) ✅

**Focus**: A way to make **verified progress fully offline** (no network, no creds) — the
thing this sandbox needs. Stand up real test infrastructure (the repo had none).

**Done**:
- [x] Node built-in `node:test` suite (**zero new deps**), run through the existing `tsx`:
      `node --import tsx --test test/*.test.ts`. **53 tests, 9 files**, all green offline.
- [x] `test/helpers.ts` — a `fetch` mock returning real `Response` objects + call capture, so
      HTTP clients are tested without ever touching the network.
- [x] Coverage: pure logic (`util`, `evalscripts`/SCL mask + byte-identical refactor guard,
      `provenance`, `parseFiresCsv`, `parseStacFeatures`) and clients via the mock — asserting
      the bug-prone bits: Worldview `S,W,N,E` / EONET `W,N,E,S` / FIRMS `W,S,E,N` bbox axis
      order + dayRange clamp; Copernicus OAuth **token cache + single 401-refresh** + stats
      `validPct` + "no valid data" throw + catalog `Accept: */*`; geocode `[S,N,W,E]→[W,S,E,N]`;
      and the `/ingest` **XSS security boundary** (`validateIngest`, now exported — id charset,
      type/mime allow-lists, images cap).
- [x] `tsconfig.test.json` + `pnpm typecheck:test` (type-checks src+test; the `tsc` build still
      only emits `src→dist`, verified no test artifacts leak to `dist/`).
- [x] `.github/workflows/ci.yml` — typecheck → typecheck:test → test → build on push/PR.
- [x] CLAUDE.md documents the offline-first testing approach; ROADMAP "add CI" ticked.

**Build/smoke**: full CI sequence run locally — `tsc` (server) ✅, `tsc -p tsconfig.test.json`
✅, **53/53 tests** ✅, `tsc && vite build` ✅, no test files in `dist/` ✅. The only failure
encountered was a wrong expectation in a test I wrote (heightFor), fixed; the code was correct.

**Why it matters**: live-API verification is great when creds/network exist, but it's no
longer the *only* way to prove a change — Horizon 1 logic work (and refactors) can now land
with regression-proof tests in any sandbox.

**Next**: cloud-masking upgrade (#1) + Sentinel-1 SAR (#2) still need live CDSE; new pure
logic should land with tests here.

---

## Session: 2026-06-06 (Horizon 1 — internal STAC layer) ✅

**Focus**: Second Horizon 1 step — a provider-independent **STAC search** against the open,
no-auth **Earth Search (Element 84)** API (VISION §7/§8 "Internal STAC + COG layer … so we're
not bound to one provider's API"; ROADMAP Horizon 1 item 6).

**Why this item**: this container has no creds **and** no outbound network (every host 403s
via the policy), so nothing external can be live-verified. The STAC layer is the most
offline-verifiable foundational item — its core is a pure parser (fixture-testable, like
`parseFiresCsv`) — and it delivers two things v0.1 lacked: a **zero-key** scene search
(`eo_search` needs CDSE OAuth) and **COG asset URLs** (the substrate Horizon 2 reads).

**Done**:
- [x] `src/clients/stac.ts` — `StacScene`/`StacAsset` types; pure `parseStacFeatures(json,
      maxCloud)` (normalize id/datetime/cloud, 6→4 bbox, split data-COG vs thumbnail assets,
      sort least-cloudy, defensive skips) + thin `stacSearch()` fetch wrapper (POST /search,
      `query` cloud filter, clean errors).
- [x] `src/tools/stac.ts` — `stac_search` tool (no key) → result with source/endpoint/COG
      assets + a `search` dashboard card. Registered in `index.ts` (9 tools); server
      instructions updated.
- [x] `config.stacUrl()` (`EARTHDECK_STAC_URL` ?? Earth Search) so Planetary Computer / a
      self-hosted STAC drop in. README tool table + `.env.example` updated.

**Build/smoke**: `tsc` + `vite build` green; **15 parser fixture checks pass** (3D-bbox
normalize, asset split, least-cloudy sort, `maxCloud` filter, malformed-feature skip,
empty → []); MCP lists `stac_search`; a live call returns a cleanly wrapped error
(`STAC search failed (403) — Host not in allowlist`), confirming the fetch wiring + graceful
failure. **Live Earth Search response parsing deferred** (no network this session).

**Next**: cloud-masking upgrade (#1) + Sentinel-1 SAR (#2) — need live CDSE creds; and
live-verify `stac_search` against Earth Search once a session has network.

---

## Session: 2026-06-06 (Horizon 1 — provenance block) ✅

**Focus**: First Horizon 1 step — make every Copernicus output decision-support by attaching
a structured **provenance block** (VISION §5.4 "verification by default"; ROADMAP Horizon 1
item 3).

**Why this item first**: this container has no CDSE creds/network, so the cloud-masking
upgrade (item 1) and Sentinel-1 SAR (item 2) can't be live-verified — and the project's
discipline is "build → live-verify against real APIs". Provenance is the highest-leverage
item that is **fully offline-verifiable** (pure logic over known parameters).

**Done**:
- [x] New `src/provenance.ts`: `Provenance` type + `s2Provenance({bbox,from,to,kind,index,
      validPct,scenes})` builder. `kind:"stats"` (masked composite → lists excluded SCL
      classes + % valid) vs `kind:"image"` (least-cloudy mosaic, not per-pixel masked).
- [x] Extracted the SCL masked-class list into one shared `SCL_CLEAR_MASK` constant +
      `maskedClassesFor()` in `evalscripts.ts`; rebuilt `statEvalscript` from it so the
      reported mask can't drift from the applied mask (verified byte-identical to the old
      hardcoded condition).
- [x] Wired provenance into `eo_render`/`eo_index`/`eo_compare` (tool text + card payload).
      Contributing scene IDs via a **best-effort** parallel catalog lookup (free metadata;
      4 s timeout + try/catch → never blocks or breaks the tool, mirroring the dashboard-push
      rule).
- [x] Dashboard: safe collapsible provenance footer on imagery/index/compare cards
      (`web/src/cards.ts` + CSS), built via DOM nodes/textContent (scene ids are upstream).

**Build/smoke**: `tsc` + `vite build` green; 27 offline checks pass (mask integrity incl.
NDWI-keeps-water, byte-identical refactor, provenance shapes for both kinds); MCP server
lists all 8 tools. **Live CDSE imagery/stats verification deferred** (no creds in this
container).

**Next**: cloud-masking upgrade (Cloud Score+ / s2cloudless / OmniCloudMask — item 1) and
Sentinel-1 SAR (item 2). Both need live CDSE creds to verify. The shared mask constant +
`provenance.cloudMask.method` field are set up to make the masking upgrade localized.

---

## Session: 2026-06-05 (final deep review + full E2E) ✅

**Focus**: Independent deep review of the shipped code + end-to-end test of everything.

**Found + fixed**:
- **Critical XSS** (compare card): server-built image URLs embed the card `id`, which was
  interpolated into `innerHTML`, and `/ingest` validated `id` only as a non-empty string
  with `*` CORS → a malicious page could POST a compare card with `id="x\" onerror=..."` for
  a drive-by XSS. Fixed both layers: `validateIngest` constrains `id` to
  `^[A-Za-z0-9._-]{1,128}$`; `cards.ts` builds `<img>` via DOM nodes. Exploit payload now
  rejected ("invalid id"); legit UUID accepted. Commit `f9d7d43`.
- Robustness: `handleCard` try/catch (a bad card can't break the feed); `CopernicusClient`
  de-dupes concurrent token refreshes (eo_compare's 4 calls) via an in-flight promise.

**Verified**:
- All 8 tools live via MCP (geo_resolve, eo_snapshot, events, fires_in, eo_search, eo_index,
  eo_render, eo_compare −0.146). Combined dashboard screenshot shows every card type.
- Edge paths graceful: invalid/out-of-range bbox, dashboard-off (best-effort), unknown place,
  no-key. Build + typecheck green.
- **Fresh clone of the public repo installs + builds + runs** (verified on the pushed commit).
- Secret scan of tracked files: clean; `.env` never tracked.

Review verdict: solid, well-engineered; the one critical XSS is fixed. Remaining items are
backlog (see ROADMAP post-ship): transient-EONET retry, sub-2-day stat window guard,
evict-by-card.

---

## Session: 2026-06-05 (Phase 5 — polish & SHIPPED) ✅

**Focus**: geo_resolve, README, and publishing.

**Done**:
- [x] `geo_resolve` (OSM Nominatim, no key) — place → bbox; live-verified (Manaus). 8 tools.
- [x] README (pitch, tool table, install snippet, free-keys howto, transcript, attribution)
      + `.env.example`.
- [x] Secret scan of tracked files (clean), then **published public**:
      https://github.com/marcoloco23/earthdeck (MIT).
- [x] Verified a fresh `npx -y github:marcoloco23/earthdeck --help` (clones + builds + runs).
- [x] Inventions idea 0005 → `shipped`.

**Status**: SHIPPED v0.1.0. Dashboard design pass skipped (already polished) — see ROADMAP
post-ship backlog for optional follow-ups.

---

## Session: 2026-06-05 (Phase 4 — change detection) ✅

**Focus**: `eo_compare` — render two dates + index delta (deforestation/flood/burn).

**Done**:
- [x] Card model carries multiple images (`IngestPayload.images`, `Card.imageUrls`); server
      stores/validates each at `/img/{id}::{n}`. Single-image path unchanged.
- [x] `eo_compare(bbox, dateA, dateB, index, view, windowDays)` in `tools/analysis.ts`:
      2 renders + 2 index stats (parallel) → mean/median delta; returns both images + delta.
- [x] Dashboard `compare` card (before/after thumbnails + colored Δ) + `showCompare` overlay.

**Build/smoke**: build + typecheck green. **Live-verified**: São Félix do Xingu (Pará)
2019→2025 → **NDVI mean −0.146**; before/after renders clearly show forest → cleared land
(also probed Novo Progresso −0.112, Apuí ~0). Dashboard compare card screenshotted.

**Next**: Phase 5 — polish & ship (geo_resolve, design pass, README, publish public).

---

## Session: 2026-06-05 (Phase 3 — Copernicus core) ✅

**Focus**: High-res Sentinel-2 imagery + index statistics + scene search via Copernicus.

**Done**:
- [x] `src/clients/copernicus.ts` — `CopernicusClient`: OAuth client-credentials with an
      in-process token cache (refresh on 401); `process()`, `statistics()`, `search()`.
- [x] `src/evalscripts.ts` — render (trueColor/falseColor/ndvi ramp) + stat (NDVI/NDWI/NBR,
      FLOAT32 + dataMask) evalscripts.
- [x] `src/tools/analysis.ts` — `eo_render`, `eo_index`, `eo_search` (require CDSE creds,
      clean error if unset), registered in `index.ts`.
- [x] Dashboard `index` card (mean + −1..1 gradient marker + min/median/max) and `search`
      card (scene dates + cloud %).

**Build/smoke**: build + typecheck green. **Live-verified with real CDSE creds**:
`eo_render` trueColor + NDVI of Manaus (viewed — 10 m detail, Meeting of Waters);
`eo_index` NDVI mean 0.279 (median 0.27, p75 0.71); `eo_search` listed scenes (June 3,
4.25% cloud); dashboard screenshot shows the Sentinel-2 overlay + index + search cards;
no-creds path returns the clean "set CDSE_*" error. API gotchas fixed: catalog `Accept: */*`,
stats bucket must fit inside the window + `FLOAT32` output.

**Next**: Phase 4 — change detection (`eo_compare`).

---

## Session: 2026-06-05 (Phase 2 — fires) ✅

**Focus**: Add NASA FIRMS active-fire detections + dashboard fire markers.

**Done**:
- [x] `fires()` + header-keyed `parseFiresCsv()` in `src/clients/nasa.ts` (one parser for
      VIIRS `bright_ti4`/string-confidence and MODIS `brightness`/numeric-confidence).
- [x] `fires_in` tool (`src/tools/fires.ts`), registered in `index.ts`; clean
      "set FIRMS_MAP_KEY" error when unconfigured.
- [x] Dashboard: GPU circle layer (`showFires` in `web/src/map.ts`) + `fires` feed card
      (count + peak FRP) + `focusCard` wiring + styling.

**Build/smoke**: build + typecheck green. Verified: parser (both sensors + "Invalid
MAP_KEY" error path), `listTools` shows `fires_in`, no-key call returns isError with the
help message. **Live FIRMS verified** with a real `FIRMS_MAP_KEY`: `fires_in` returned 133
detections over the Western US (25,543 over central Africa), rendered as markers
(screenshotted). VIIRS confidence letters (l/n/h) normalized to low/nominal/high.

**Next**: Phase 3 — Copernicus core (OAuth + `eo_render`/`eo_index`/`eo_search`).

---

## Session: 2026-06-05 (full review + visual verification + hardening)

**Focus**: Eyeball everything end to end and harden the hand-rolled HTTP server.

**Visually verified** (rendered real imagery + screenshotted the live dashboard via Chrome
DevTools Protocol):
- Imagery: trueColor (Egypt/Nile), fires overlay (California thermal anomalies), VIIRS
  false-color (Amazon) — all correct, georeferenced, recognizable.
- Dashboard UI: imagery overlay on the GIBS Blue Marble basemap **and** event markers on
  the world map; live feed populated; "● live" status.

**Bugs found + fixed**:
- WebGL init failure used to take down the whole dashboard (map init threw before SSE
  connected). Now: SSE connects first, `createMap()` is guarded and shows a fallback notice;
  `web/src/map.ts` no-ops if the map isn't ready.
- Duplicate `connect()` in `web/src/main.ts` (opened two SSE streams) — removed.
- `falseColor` switched MODIS Bands721 → VIIRS BandsM11-I2-I1 to avoid low-latitude
  black swath gaps (verified: full coverage now).

**Security/robustness hardening** (`src/dashboard/server.ts`, from an independent review):
- C1: malformed-URL `decodeURIComponent` throw → 400 instead of crashing the process
  (verified `GET /%`, `/img/%ZZ` → 400, server stays up).
- S3: bind to `127.0.0.1` only (verified: LAN IP refused) — was implicitly `0.0.0.0`.
- S1/S5: `/ingest` now validates with an allow-list (`type` ∈ CardType, image mime ∈
  jpeg/png) — verified injection payloads rejected; closes a DOM/XSS vector.
- S2: SSE ping wrapped in try/catch + `res.on("error")` drop; process-level
  `uncaughtException`/`unhandledRejection` safety net.
- S4: `/img` decodes id + strips query + sends `cache-control`.
- Defense-in-depth: `web/src/cards.ts` coerces unknown `card.type` to a safe value.

**Build/smoke**: `pnpm build` + `pnpm typecheck` green; MCP tools re-verified with the
dashboard both ON (cards pushed) and OFF (best-effort, tools still return). Adversarial
HTTP tests pass.

---

## Session: 2026-06-05 (scaffold + zero-key slice) — Phase 0 ✅ + Phase 1 ✅

**Branch**: main
**Focus**: Stand up the repo + roadmap scaffold, then ship the zero-key vertical slice end
to end (MCP tools + live dashboard).

**Done**:
- [x] `git init` + config files (pinned deps mirroring knuspr-mcp + vite/maplibre).
- [x] Roadmap scaffold: CLAUDE/AGENTS/ROADMAP/CONTINUITY/PROGRESS + `.plans/`.
- [x] MCP server: `cli.ts` (dispatch `dashboard` vs stdio), `index.ts`, `result.ts`,
      `config.ts`, `util.ts`, `errors.ts`, `types.ts`.
- [x] Dashboard server `dashboard/server.ts` (`/ingest`, `/img/:id`, `/events` SSE,
      `/api/state`, static + fallback shell) and best-effort `dashboard/push.ts`.
- [x] NASA client `clients/nasa.ts` (Worldview snapshot + EONET) — no keys.
- [x] Tools: `eo_snapshot` (imagery card) + `events` (events card).
- [x] MapLibre dashboard UI (`web/`): GIBS Blue Marble basemap, imagery overlays, event
      markers, live SSE feed, dark mission-control styling.

**Build status**: `pnpm build` (tsc + vite) ✅, `pnpm typecheck` ✅.
**Smoke status**: ✅ Dashboard endpoints curl-tested (ingest → state → `/img`). ✅ MCP via
SDK client: `listTools` → `eo_snapshot, events`; `events` → 3 live events, dashboard
"pushed"; `eo_snapshot` → `image/jpeg` block, dashboard "pushed". Not yet eyeballed inside
a live Claude Code session (mechanically proven).

**Next priorities**:
1. Phase 2 — Fires: FIRMS client + `fires_in` tool + fire markers on the map (needs a free
   `FIRMS_MAP_KEY`).
2. Phase 3 — Copernicus core (OAuth + `eo_render`/`eo_index`/`eo_search`).
3. Eyeball the full visual demo in a live Claude Code session.
