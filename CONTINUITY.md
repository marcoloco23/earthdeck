# CONTINUITY.md — READ THIS FIRST. DO NOT SKIP.

This is the live state of the project. If you are an agent picking up work, read this whole
file, update the AGENT CHECKIN, then take the next item from the TASK QUEUE. The stable
reference is [CLAUDE.md](CLAUDE.md); the phase plan is [ROADMAP.md](ROADMAP.md).

---

## AGENT CHECKIN

- Agent read full file: YES
- Current task understood: YES
- Current task: **Horizon 1 in progress.** Provenance block shipped (item 3). Next:
  cloud-masking upgrade (item 1) + Sentinel-1 SAR (item 2) — both need live CDSE creds to
  verify, which this container lacks. Strategy in [VISION.md](VISION.md).
- Session started: 2026-06-06 (Session 5)

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

## CURRENT STATE (2026-06-06)

- **v0.1 (Horizon 0) shipped + public.** 8 tools, all live-verified in earlier sessions.
  Now in **Horizon 1 — Trustworthy analyst**.
- **This session (5): Provenance block (Horizon 1 item 3).** Every Copernicus output
  (`eo_render`/`eo_index`/`eo_compare`) now carries a structured `provenance` block — data
  source, sensor/collection, composite window + mosaicking, cloud-mask method + the exact
  masked SCL classes, % valid, best-effort contributing scene IDs, bbox, retrieved-at, and a
  decision-support disclaimer — in the tool output **and** the dashboard cards.
  New `src/provenance.ts`; SCL masked-class list now a single shared constant in
  `evalscripts.ts` (`SCL_CLEAR_MASK` + `maskedClassesFor`) so the reported mask can't drift
  from the applied mask. Build + typecheck green; 27 offline checks pass (incl. byte-identical
  mask refactor); MCP lists all 8 tools.
- **This container has NO `.env`/creds and no network to CDSE**, so live API verification of
  imagery/stats is deferred. The provenance work is pure, fully offline-verifiable logic.
- Next (need live CDSE creds to verify): **cloud-masking upgrade** (Cloud Score+ /
  s2cloudless / OmniCloudMask, Horizon 1 item 1 — highest leverage) and **Sentinel-1 SAR**
  (item 2). The shared mask constant + provenance `cloudMask.method` field are already set up
  to make the masking upgrade a localized change.

## TASK QUEUE

Phase 0 — Scaffold: ✅ done
Phase 1 — Zero-key slice: ✅ done
Phase 2 — Fires: ✅ done + live-verified (133 real detections, Western US)
Phase 3 — Copernicus core: ✅ done + live-verified (Sentinel-2 render + NDVI 0.279 + search)
Phase 4 — Change detection: ✅ done + live-verified (São Félix do Xingu NDVI −0.146, 2019→2025)

Phases 0–5 (Horizon 0): ✅ done + shipped public. 8 tools, all live-verified.

Horizon 1 — Trustworthy analyst (current):
- [x] **Provenance block** on every numeric/imagery output (this session) — offline-verified.
- [ ] **Better cloud masking** (item 1, highest leverage) — Cloud Score+ / s2cloudless /
      OmniCloudMask behind `eo_index`/`eo_render`/`eo_compare`. ⚠️ needs live CDSE to verify.
- [ ] **Sentinel-1 SAR** (item 2) — GRD backscatter render + flood/water mapping. ⚠️ needs creds.
- [ ] Classic change detection · consume GFW alerts · internal STAC+COG layer (see ROADMAP).

8 tools total. Build + typecheck green.

Useful test fixtures: Amazon near Manaus bbox `[-60.2,-3.3,-59.8,-2.9]`; events smoke
returns Tropical Storm Amanda. Run the dashboard on a non-default port to avoid clashes:
`OVERVIEW_DASHBOARD_PORT=5009 node dist/cli.js dashboard`, then point tools at it with
`OVERVIEW_DASHBOARD_URL=http://127.0.0.1:5009`.

---

## SESSION LOG

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
