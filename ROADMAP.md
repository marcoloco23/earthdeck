# ROADMAP — earthdeck

> **The 5-year strategy lives in [VISION.md](VISION.md)** — north-star (the *AI Environmental
> Watchdog*), the moat (cumulative monitoring history + trust), wedges (EUDR, methane), the
> capability pillars, the data/AI stack, and the Horizon 0→5 plan. This file is the near-term
> tactical tracker. v0.1 (Horizon 0) is shipped; **Horizon 1 is next (see bottom).**

**Status**: ✅ SHIPPED v0.1.0 (Horizon 0) — public at https://github.com/marcoloco23/earthdeck
(2026-06-05). All 5 phases done, 8 tools, all live-verified; fresh `npx` install confirmed.
**Goal**: ship a free, open-data Earth-observation MCP + live mission-control dashboard,
public and `npx`-installable, mirroring the knuspr-mcp pattern.

Status markers: `[ ]` todo · `[x]` done · `🚧` in progress · `🚫` blocked.

---

## Tool / endpoint contract (single source of truth)

Env: `CDSE_CLIENT_ID`/`CDSE_CLIENT_SECRET` (Copernicus), `FIRMS_MAP_KEY` (fires),
`EARTHDECK_DASHBOARD_URL` (default `http://127.0.0.1:5005`), `EARTHDECK_DASHBOARD_PORT` (5005).

| Tool | Backend | Auth | Card |
| --- | --- | --- | --- |
| `eo_search(bbox, dateFrom, dateTo, collection="sentinel-2-l2a", maxCloud=20)` | Copernicus Catalog/STAC | OAuth | search |
| `eo_snapshot(bbox, date, layers="trueColor", width=1024)` | NASA Worldview Snapshots | none | imagery |
| `eo_render(bbox, date, view="trueColor"\|"falseColor"\|"ndvi", width=1024)` | Copernicus Process + evalscript | OAuth | imagery |
| `sar_render(bbox, date, view="falseColor"\|"vv"\|"vh", windowDays=14, orbitDirection?)` | Copernicus Process (Sentinel-1 GRD) | OAuth | imagery |
| `sar_water(bbox, date, windowDays=14, thresholdDb=-17, orbitDirection?)` | Copernicus Statistics (Sentinel-1 GRD) | OAuth | index |
| `sar_flood(bbox, dateBefore, dateAfter, windowDays=12, thresholdDb=-17, orbitDirection?)` | Copernicus Statistics ×2 (Sentinel-1 GRD) | OAuth | index |
| `eo_index(bbox, date, index="NDVI"\|"NDWI"\|"NBR")` | Copernicus Statistical | OAuth | index |
| `fires_in(bbox, dayRange=1, source="VIIRS_SNPP_NRT")` | NASA FIRMS area | map key | fires |
| `events(category?, status="open", bbox?, days=30)` | NASA EONET v3 | none | events |
| `eo_compare(bbox, dateA, dateB, index="NDVI")` | render×2 + index delta | OAuth | compare |
| `geo_resolve(place)` *(optional)* | OSM Nominatim | none | — |
| `stac_search(bbox, dateFrom, dateTo, collection="sentinel-2-l2a", maxCloud?, limit=8)` | Earth Search STAC | none | search |
| `enso(months=120)` | NOAA CPC ONI (oni.ascii.txt) | none | series |
| `ocean_temp(lat, lon, start?, end?)` | NOAA OISST v2.1 via CoastWatch ERDDAP griddap | none | series |
| `co2(sinceYear?)` | NOAA GML co2_mm_mlo.txt | none | series |
| `global_temp()` | NASA GISTEMP v4 GLB.Ts+dSST.csv | none | series |
| `sea_ice(pole)` | NSIDC G02135 v4.0 daily + 1981–2010 climatology | none | series |
| `quakes(bbox?, minMagnitude=4.5, days=7, limit=100)` | USGS FDSN event service | none | quakes |
| `climate_history(lat, lon, variable?, startYear?, endYear?)` | Open-Meteo archive (ERA5, 1940→) | none | series |
| `air_quality(lat, lon)` | Open-Meteo air-quality (CAMS) | none | series |
| `river_discharge(lat, lon, start?, end?)` | Open-Meteo flood (GloFAS, 1984→) | none | series |
| `planet_pulse()` | all of the above + EONET + USGS, parallel best-effort | none | pulse |
| `earthdata_search(keyword, bbox?, dateFrom?, dateTo?, limit=10)` | NASA CMR collections.json | none | search |

Endpoints:
- OAuth token: `POST https://identity.dataspace.copernicus.eu/auth/realms/CDSE/protocol/openid-connect/token` (`client_credentials`)
- STAC: `POST https://sh.dataspace.copernicus.eu/api/v1/catalog/1.0.0/search`
- Process: `POST https://sh.dataspace.copernicus.eu/api/v1/process`
- Statistical: `POST https://sh.dataspace.copernicus.eu/api/v1/statistics`
- Worldview snapshot: `GET https://wvs.earthdata.nasa.gov/api/v1/snapshot?REQUEST=GetSnapshot&TIME=&BBOX=&CRS=EPSG:4326&LAYERS=&FORMAT=image/jpeg&WIDTH=&HEIGHT=`
- FIRMS area: `GET https://firms.modaps.eosdis.nasa.gov/api/area/csv/{MAP_KEY}/{SOURCE}/{west,south,east,north}/{dayRange}/{date}`
- EONET: `GET https://eonet.gsfc.nasa.gov/api/v3/events?status=open&bbox=&days=`
- STAC: `POST https://earth-search.aws.element84.com/v1/search` (open, no key; `EARTHDECK_STAC_URL` overrides)

---

## Phase 0 — Scaffold ✅

- [x] Repo + config files (package.json, tsconfig, vite.config, .gitignore, .nvmrc, .editorconfig, LICENSE)
- [x] Roadmap scaffold (CLAUDE/AGENTS/CONTINUITY/PROGRESS/ROADMAP, .plans/)
- [x] MCP stdio skeleton (`src/index.ts`, `src/cli.ts`, `errors.ts`, `types.ts`, `util.ts`, `result.ts`, `config.ts`)
- [x] Dashboard server (`src/dashboard/server.ts`) + best-effort push (`src/dashboard/push.ts`)
- [x] Web shell (`web/` Vite + MapLibre + SSE client)
- [x] `pnpm build` + `pnpm typecheck` green
- **Done**: `node dist/cli.js dashboard` serves the dashboard at `:5005` (verified on `:5009`);
  the MCP server starts on stdio and lists its tools.

## Phase 1 — Zero-key vertical slice (first demo) ✅

- [x] `src/clients/nasa.ts` (Worldview snapshot + EONET)
- [x] `eo_snapshot` tool → imagery card (no key)
- [x] `events` tool → events card (no key)
- [x] Dashboard renders imagery overlay on the map + a live events list
- **Done**: verified via MCP SDK client — `events` returned live events (Tropical Storm
  Amanda) and pushed a card; `eo_snapshot` returned a JPEG image block for the Amazon and
  pushed an imagery card; both visible in `/api/state`. Pending: run inside a live Claude
  Code session for the full visual demo (mechanically proven, just not yet eyeballed).

## Phase 2 — Fires ✅

- [x] FIRMS client in `src/clients/nasa.ts` (`fires()` + header-keyed `parseFiresCsv()`,
      handles VIIRS & MODIS) + `fires_in` tool (`src/tools/fires.ts`) → fire-markers card
- [x] Dashboard: GPU circle layer for fire points (`showFires` in `web/src/map.ts`) +
      `fires` feed card + `focusCard` wiring
- **Done + live-verified**: parser handles both sensors + error path; `fires_in` registers
  and errors cleanly without a key; **live FIRMS call returned 133 real detections over the
  Western US (and 25,543 over central Africa), rendered as markers** (screenshotted). VIIRS
  single-letter confidence (l/n/h) normalized to low/nominal/high.

## Phase 3 — Copernicus core ✅

- [x] `src/clients/copernicus.ts` — OAuth client-credentials + in-process token cache (refresh on 401)
- [x] `src/evalscripts.ts` — trueColor / falseColor / NDVI render + NDVI/NDWI/NBR stat scripts
- [x] `eo_search` (STAC), `eo_render` (Process), `eo_index` (Statistical) + dashboard index/search cards
- **Done + live-verified** with real CDSE creds: `eo_render` trueColor/ndvi rendered 10 m
  Sentinel-2 of Manaus (viewed); `eo_index` NDVI mean 0.279 (median 0.27, p75 0.71);
  `eo_search` listed scenes with cloud %; no-creds path returns a clean error. Gotchas
  solved: catalog `Accept: */*` (406 otherwise); stats need `dataFilter.timeRange` +
  `FLOAT32` output + a bucket that fits inside the window.

## Phase 4 — Change detection ✅

- [x] `eo_compare` (two renders + index delta) → before/after compare card (card model
      extended to carry multiple images) + map overlay of the "after" image
- **Done + live-verified**: `eo_compare` over São Félix do Xingu (Pará) 2019→2025 returned
  **NDVI mean −0.146** with both renders clearly showing forest → cleared land. Also probed
  Novo Progresso (−0.112). Mechanism + dashboard compare card confirmed (screenshot).

## Phase 5 — Polish & ship 🚧

- [x] `geo_resolve` (OSM Nominatim, ToS-safe) — place name → bbox; live-verified (Manaus)
- [x] README (pitch, tool table, install snippet, free-keys howto, transcript, attribution)
- [x] `.env.example`
- [~] Dashboard design pass — current UI already polished; skipped a full redesign to avoid
      regressions (revisit only if desired)
- [x] **Pushed public**: https://github.com/marcoloco23/earthdeck (MIT, public)
- [x] Fresh `npx -y github:marcoloco23/earthdeck --help` verified (clones + builds + runs)
- [x] Inventions idea 0005 → `shipped`
- **Done** ✅: a fresh `npx` install builds and runs.

## Horizon 1 — Trustworthy analyst (next, ≈ months 0–6) — see [VISION.md](VISION.md) §7

All free / low-or-no GPU. Highest-leverage first:

- [x] **Better cloud masking (rung 1, 2026-06-12)** — s2cloudless via CDSE's CLM/CLP bands
      (support live-confirmed) layered ON TOP of SCL in the stat evalscripts: a pixel is
      excluded if either flags it (SCL catches shadows; s2cloudless catches haze/small
      cumulus). CLP cutoff 102/255 ≈ 40%. Shared `S2CLOUDLESS_MASK` + `STAT_MASK_METHOD`
      constants keep evalscript ↔ provenance in lockstep. Live: Manaus validPct 64→61%,
      NDVI mean 0.667→0.675 (haze removed). Rungs 2+ (Cloud Score+ / OmniCloudMask) need
      GEE/GPU — revisit in Horizon 2+.
- [x] **Sentinel-1 SAR** — `sar_render` (GRD backscatter, GAMMA0 terrain-corrected; VV/VH/
      false-color), `sar_water` (water/flood extent: water % from low VV backscatter), and
      `sar_flood` (flood onset: Δ water % between a pre-event baseline and a post-event date),
      via a generalized multi-collection Copernicus client (Process + Statistics). Offline-verified
      (65 tests) **and live-verified 2026-06-12 with real CDSE creds**: Manaus render viewed,
      water 19.4% (100% valid), flood Δ +2 pts Apr→Jun (Amazon rising-water season — plausible).
- [x] **Provenance block** on every numeric/imagery output (data source, sensor/collection,
      composite window + mosaicking, cloud-mask method + masked SCL classes, % valid,
      best-effort contributing scene IDs, bbox, retrieved-at, decision-support disclaimer).
      Shared SCL-mask constant keeps the reported mask honest. In `eo_render`/`eo_index`/
      `eo_compare` output + dashboard cards. Offline-verified (27 checks); live CDSE deferred.
- [ ] **Classic change detection** as tools: temporal median compositing, CCDC/BFAST/LandTrendr.
- [ ] **Consume GFW alerts** (GLAD-L/GLAD-S2/RADD/DIST-ALERT) instead of rebuilding deforestation.
- [~] **Internal STAC + COG layer** — `stac_search` against the open, no-auth Earth Search
      (Element 84) STAC (endpoint configurable via `EARTHDECK_STAC_URL` → Planetary Computer /
      self-hosted). Zero-key scene search returning COG asset URLs; provider-independent
      companion to `eo_render` reads still TODO. Offline-verified (15 parser checks) **and
      live-verified 2026-06-12**: 5 real Sentinel-2 scenes with COG links over Manaus.

## Earth Pulse — the planetary indicators layer ✅ (2026-06-12)

VISION §6 pillar 1 ("Observe — fuse with non-satellite feeds") pulled forward: the Earth
system as data, not just pixels. **10 new tools (→ 22 total), all zero-key, all with
historic series + trends**, plus 3 new dashboard card types (`series` hand-rolled SVG
charts, `quakes` magnitude-scaled map layer, `pulse` vital-signs grid).

- [x] `enso` — ONI 1950→now, official phase rule (≥5 seasons ±0.5 °C); live: Neutral, +0.48 (MAM 2026)
- [x] `ocean_temp` — OISST 1981→now via ERDDAP, auto-stride, °C/decade trend
- [x] `co2` — Keeling curve 1958→now; live: 432.34 ppm (2026-05), +1.83 YoY
- [x] `global_temp` — GISTEMP 1880→now; live: +1.12 °C (2026-05), +0.27 °C/decade since 1980
- [x] `sea_ice` — NSIDC v4 both poles vs 1981–2010 climatology; live: both below p10
- [x] `quakes` — USGS FDSN, bbox/magnitude/days; live: M7.8 Philippines
- [x] `climate_history` — ERA5 1940→now, annual/monthly aggregation + trend/decade
- [x] `air_quality` — CAMS PM2.5/PM10/O₃/NO₂/US-AQI + WHO-guideline flag
- [x] `river_discharge` — GloFAS 1984→now, latest-vs-mean flood/drought signal
- [x] `planet_pulse` — all vital signs in one parallel, partial-failure-tolerant call
- [x] Offline tests 65 → 88 (parsers from live-grounded fixtures, trend math, ENSO rule)
- [x] Live-verified: all 16 E2E calls green in one session; dashboard screenshotted

## Horizon 2 — The planet becomes searchable (≈ months 6–12)

- [ ] **AlphaEarth Satellite Embedding** (CC-BY, no GPU) → `eo_similar` ("find everywhere like
      this") + embedding-difference change detection + few-shot classification.
- [ ] **pgvector** embedding index alongside STAC.
- [ ] **`eo_detect`** — text-promptable detection/segmentation (samgeo + Grounding DINO + SAM).
- [ ] **State-machine agentic orchestrator** over the MCP tools (Geo-OLM pattern, ~100× cheaper).

Horizons 3–5 (the Watchdog monitoring platform, verticalization, marketplace/system-of-record):
see [VISION.md](VISION.md) §7.

## Tidy-up backlog (low priority)

- Dashboard design pass (frontend-design skill) if a visual refresh is wanted.
- `eo_compare` swipe slider on the map (currently overlays the "after" image).
- [done 2026-06-06] Offline `node:test` suite (53 tests, network mocked) + GitHub Actions CI
  (typecheck → test → build). Publish to npm still TODO (currently `npx github:` install).
- More FIRMS sources / MODIS false-color option; antimeridian bbox support.
- Transient-failure retry for the no-key NASA fetches (EONET occasionally throttles under
  hammering). Sub-2-day stats-window guard. Evict images by card, not count.
- [done 2026-06-05] SCL cloud+shadow+water masking + %-valid quality flag.
