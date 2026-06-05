# CONTINUITY.md — READ THIS FIRST. DO NOT SKIP.

This is the live state of the project. If you are an agent picking up work, read this whole
file, update the AGENT CHECKIN, then take the next item from the TASK QUEUE. The stable
reference is [CLAUDE.md](CLAUDE.md); the phase plan is [ROADMAP.md](ROADMAP.md).

---

## AGENT CHECKIN

- Agent read full file: YES
- Current task understood: YES
- Current task: **SHIPPED** ✅ — v0.1.0 public. Optional post-ship backlog in ROADMAP.md.
- Session started: 2026-06-05

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

## CURRENT STATE (2026-06-05)

- Repo at `~/code/tools/overview-mcp`. **Phases 0–3 complete; reviewed, hardened, and
  live-verified.** All three credentials live in `.env` (gitignored): FIRMS + CDSE.
- **Seven tools now**: `eo_snapshot`, `events` (zero key); `fires_in` (FIRMS); `eo_render`,
  `eo_index`, `eo_search`, `eo_compare` (Copernicus Sentinel-2). Build + typecheck green.
  Dashboard renders imagery overlays, event/fire markers, NDVI index panel, scene lists,
  and before/after compare cards (all screenshotted). Commits through the Phase 4 commit.
- Next: **Phase 5 — Polish & ship.** Optional `geo_resolve` (Nominatim, ToS-safe) so tools
  accept place names; a dashboard design pass (`frontend-design` skill); a README with the
  free-keys howto + a worked transcript; then push public to GitHub and flip inventions
  idea 0005 → `shipped`.

## TASK QUEUE

Phase 0 — Scaffold: ✅ done
Phase 1 — Zero-key slice: ✅ done
Phase 2 — Fires: ✅ done + live-verified (133 real detections, Western US)
Phase 3 — Copernicus core: ✅ done + live-verified (Sentinel-2 render + NDVI 0.279 + search)
Phase 4 — Change detection: ✅ done + live-verified (São Félix do Xingu NDVI −0.146, 2019→2025)

Phase 5 — Polish & ship (current):
- [x] `geo_resolve(place)` via OSM Nominatim — live-verified (Manaus → bbox).
- [x] README + `.env.example`.
- [~] Dashboard design pass — already polished; skipped full redesign.
- [ ] **Push public to GitHub** — awaiting user confirmation (repo name/visibility).
- [ ] Flip inventions idea 0005 → `shipped`; log a note.

8 tools total now (added `geo_resolve`). Build + typecheck green.

Useful test fixtures: Amazon near Manaus bbox `[-60.2,-3.3,-59.8,-2.9]`; events smoke
returns Tropical Storm Amanda. Run the dashboard on a non-default port to avoid clashes:
`OVERVIEW_DASHBOARD_PORT=5009 node dist/cli.js dashboard`, then point tools at it with
`OVERVIEW_DASHBOARD_URL=http://127.0.0.1:5009`.

---

## SESSION LOG

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
