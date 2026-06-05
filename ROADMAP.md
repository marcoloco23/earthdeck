# ROADMAP — overview-mcp

**Status**: Phase 0 ✅ + Phase 1 ✅ + Phase 2 ✅ — fires shipped & verified (2026-06-05).
Next: Phase 3 (Copernicus core).
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

## Phase 3 — Copernicus core 🔜 (next)

- [ ] `src/clients/copernicus.ts` — OAuth client-credentials + in-process token cache (refresh on 401)
- [ ] `src/evalscripts.ts` — trueColor / falseColor / NDVI / NDWI / NBR
- [ ] `eo_search` (STAC), `eo_render` (Process), `eo_index` (Statistical)
- **Done when**: `eo_render` returns higher-res Sentinel-2 imagery and `eo_index` returns
  NDVI stats over a known bbox; both produce cards.

## Phase 4 — Change detection

- [ ] `eo_compare` (two renders + index delta) → compare (swipe / side-by-side) card
- **Done when**: `eo_compare` over a known deforestation site shows a mean-NDVI drop.

## Phase 5 — Polish & ship

- [ ] `geo_resolve` (Nominatim, ToS-safe) so tools accept place names
- [ ] Dashboard design pass (use the `frontend-design` skill)
- [ ] README setup howto + worked transcript
- [ ] Push public to GitHub; flip inventions idea 0005 → `shipped`; log a note
- **Done when**: a fresh clone installs, builds, and runs the full demo from the README.
