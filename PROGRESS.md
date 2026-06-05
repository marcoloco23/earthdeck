# PROGRESS — overview-mcp

Session-by-session history, newest first. Each entry: focus, what got done, build/smoke
status, next priorities. The live task pointer is in [CONTINUITY.md](CONTINUITY.md).

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
