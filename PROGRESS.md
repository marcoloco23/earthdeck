# PROGRESS — overview-mcp

Session-by-session history, newest first. Each entry: focus, what got done, build/smoke
status, next priorities. The live task pointer is in [CONTINUITY.md](CONTINUITY.md).

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
