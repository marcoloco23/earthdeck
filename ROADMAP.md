# ROADMAP — overview-mcp

**Status**: Phases 0–4 ✅ — through change detection, all live-verified (2026-06-05).
Seven tools. Next: Phase 5 (polish & ship public).
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

## Phase 5 — Polish & ship 🔜 (next)

- [ ] `geo_resolve` (Nominatim, ToS-safe) so tools accept place names
- [ ] Dashboard design pass (use the `frontend-design` skill)
- [ ] README setup howto + worked transcript
- [ ] Push public to GitHub; flip inventions idea 0005 → `shipped`; log a note
- **Done when**: a fresh clone installs, builds, and runs the full demo from the README.
