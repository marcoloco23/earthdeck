# CONTINUITY.md — READ THIS FIRST. DO NOT SKIP.

This is the live state of the project. If you are an agent picking up work, read this whole
file, update the AGENT CHECKIN, then take the next item from the TASK QUEUE. The stable
reference is [CLAUDE.md](CLAUDE.md); the phase plan is [ROADMAP.md](ROADMAP.md).

---

## AGENT CHECKIN

- Agent read full file: YES
- Current task understood: YES
- Current task: **Phase 2 — Fires** (FIRMS client + `fires_in` tool → fire-markers card)
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

- Repo at `~/code/tools/overview-mcp`. **Phase 0 + Phase 1 complete and smoke-tested.**
  `git init` done, **not committed** (waiting on user approval per rule 4).
- Build + typecheck green. Dashboard server works (ingest → SSE → `/img` verified). MCP
  server lists `eo_snapshot` + `events`; both call live NASA APIs and push cards.
- Two real tools, zero keys: `eo_snapshot` (Worldview/GIBS imagery) and `events` (EONET).
- **Reviewed + hardened + visually verified** (2026-06-05): all imagery types and both
  dashboard map paths screenshotted and confirmed; fixed WebGL-kills-feed bug, duplicate
  SSE connect, false-color swath gaps; hardened the HTTP server (loopback-only bind,
  `/ingest` allow-list validation, malformed-URL 400, SSE/process safety nets). See
  PROGRESS.md for the full list. Build + typecheck green.
- Next: **Phase 2 — Fires.** Add a FIRMS client + `fires_in` tool. Needs a free
  `FIRMS_MAP_KEY` to smoke-test (get one at firms.modaps.eosdis.nasa.gov/api/map_key/).

## TASK QUEUE

Phase 0 — Scaffold: ✅ done
Phase 1 — Zero-key slice: ✅ done

Phase 2 — Fires (current):
- [ ] Write `.plans/2026-06-05_fires.md` (new external surface = FIRMS).
- [ ] Add `fires(bbox, dayRange, source)` to `src/clients/nasa.ts` — GET FIRMS area CSV,
      parse to `FireDetection[]` (type already in `src/types.ts`).
- [ ] `fires_in` tool in `src/tools/events.ts` (or a new `src/tools/fires.ts`) → `fires` card.
- [ ] Dashboard: render `fires` card → fire markers (extend `web/src/map.ts`, add a
      `showFires` handler + a `fires` badge/branch in `cards.ts` + `main.ts`).
- [ ] Smoke with a real `FIRMS_MAP_KEY` over a current fire region; update ledgers.

Later phases: see ROADMAP.md (Copernicus core → change detection → polish/ship).

Useful test fixtures: Amazon near Manaus bbox `[-60.2,-3.3,-59.8,-2.9]`; events smoke
returns Tropical Storm Amanda. Run the dashboard on a non-default port to avoid clashes:
`OVERVIEW_DASHBOARD_PORT=5009 node dist/cli.js dashboard`, then point tools at it with
`OVERVIEW_DASHBOARD_URL=http://127.0.0.1:5009`.

---

## SESSION LOG

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
