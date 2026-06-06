# ROADMAP — overview-mcp

> **The 5-year strategy lives in [VISION.md](VISION.md)** — north-star (the *AI Environmental
> Watchdog*), the moat (cumulative monitoring history + trust), wedges (EUDR, methane), the
> capability pillars, the data/AI stack, and the Horizon 0→5 plan. This file is the near-term
> tactical tracker. v0.1 (Horizon 0) is shipped; **Horizon 1 is next (see bottom).**

**Status**: ✅ SHIPPED v0.1.0 (Horizon 0) — public at https://github.com/marcoloco23/overview-mcp
(2026-06-05). All 5 phases done, 8 tools, all live-verified; fresh `npx` install confirmed.
**Goal**: ship a free, open-data Earth-observation MCP + live mission-control dashboard,
public and `npx`-installable, mirroring the knuspr-mcp pattern.

Status markers: `[ ]` todo · `[x]` done · `🚧` in progress · `🚫` blocked.

---

## Tool / endpoint contract (single source of truth)

Env: `CDSE_CLIENT_ID`/`CDSE_CLIENT_SECRET` (Copernicus), `FIRMS_MAP_KEY` (fires),
`OVERVIEW_DASHBOARD_URL` (default `http://127.0.0.1:5005`), `OVERVIEW_DASHBOARD_PORT` (5005).

| Tool | Backend | Auth | Card |
| --- | --- | --- | --- |
| `eo_search(bbox, dateFrom, dateTo, collection="sentinel-2-l2a", maxCloud=20)` | Copernicus Catalog/STAC | OAuth | search |
| `eo_snapshot(bbox, date, layers="trueColor", width=1024)` | NASA Worldview Snapshots | none | imagery |
| `eo_render(bbox, date, view="trueColor"\|"falseColor"\|"ndvi", width=1024)` | Copernicus Process + evalscript | OAuth | imagery |
| `eo_index(bbox, date, index="NDVI"\|"NDWI"\|"NBR")` | Copernicus Statistical | OAuth | index |
| `fires_in(bbox, dayRange=1, source="VIIRS_SNPP_NRT")` | NASA FIRMS area | map key | fires |
| `events(category?, status="open", bbox?, days=30)` | NASA EONET v3 | none | events |
| `eo_compare(bbox, dateA, dateB, index="NDVI")` | render×2 + index delta | OAuth | compare |
| `geo_resolve(place)` *(optional)* | OSM Nominatim | none | — |

Endpoints:
- OAuth token: `POST https://identity.dataspace.copernicus.eu/auth/realms/CDSE/protocol/openid-connect/token` (`client_credentials`)
- STAC: `POST https://sh.dataspace.copernicus.eu/api/v1/catalog/1.0.0/search`
- Process: `POST https://sh.dataspace.copernicus.eu/api/v1/process`
- Statistical: `POST https://sh.dataspace.copernicus.eu/api/v1/statistics`
- Worldview snapshot: `GET https://wvs.earthdata.nasa.gov/api/v1/snapshot?REQUEST=GetSnapshot&TIME=&BBOX=&CRS=EPSG:4326&LAYERS=&FORMAT=image/jpeg&WIDTH=&HEIGHT=`
- FIRMS area: `GET https://firms.modaps.eosdis.nasa.gov/api/area/csv/{MAP_KEY}/{SOURCE}/{west,south,east,north}/{dayRange}/{date}`
- EONET: `GET https://eonet.gsfc.nasa.gov/api/v3/events?status=open&bbox=&days=`

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
- [x] **Pushed public**: https://github.com/marcoloco23/overview-mcp (MIT, public)
- [x] Fresh `npx -y github:marcoloco23/overview-mcp --help` verified (clones + builds + runs)
- [x] Inventions idea 0005 → `shipped`
- **Done** ✅: a fresh `npx` install builds and runs.

## Horizon 1 — Trustworthy analyst (next, ≈ months 0–6) — see [VISION.md](VISION.md) §7

All free / low-or-no GPU. Highest-leverage first:

- [ ] **Better cloud masking** — Cloud Score+ / s2cloudless / OmniCloudMask behind
      `eo_index`/`eo_render`/`eo_compare` (big reliability jump over SCL; keep %-valid flag).
- [ ] **Sentinel-1 SAR** — GRD backscatter render + flood/water mapping (`sar_*` tools).
      The start of all-weather; SAR sees through cloud/smoke/night. (Closes our #1 weakness.)
- [x] **Provenance block** on every numeric/imagery output (data source, sensor/collection,
      composite window + mosaicking, cloud-mask method + masked SCL classes, % valid,
      best-effort contributing scene IDs, bbox, retrieved-at, decision-support disclaimer).
      Shared SCL-mask constant keeps the reported mask honest. In `eo_render`/`eo_index`/
      `eo_compare` output + dashboard cards. Offline-verified (27 checks); live CDSE deferred.
- [ ] **Classic change detection** as tools: temporal median compositing, CCDC/BFAST/LandTrendr.
- [ ] **Consume GFW alerts** (GLAD-L/GLAD-S2/RADD/DIST-ALERT) instead of rebuilding deforestation.
- [ ] **Internal STAC + COG layer** (Earth Search + Planetary Computer); GEE as research backend.

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
- Publish to npm (currently `npx github:` install); add CI.
- More FIRMS sources / MODIS false-color option; antimeridian bbox support.
- Transient-failure retry for the no-key NASA fetches (EONET occasionally throttles under
  hammering). Sub-2-day stats-window guard. Evict images by card, not count.
- [done 2026-06-05] SCL cloud+shadow+water masking + %-valid quality flag.
