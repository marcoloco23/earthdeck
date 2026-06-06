# CLAUDE.md — overview-mcp

> Agent reference for this repo. **If you are picking up work, read
> [CONTINUITY.md](CONTINUITY.md) FIRST** — it holds the current task and the
> session loop. This file is the stable reference; CONTINUITY.md is the live state.

## What this is

`overview-mcp` is an **Earth-observation MCP server** plus a **live mission-control
dashboard**. It gives Claude eyes on Earth over free, open data:

- pull satellite imagery for any place/date,
- compute vegetation/water/burn indices (NDVI/NDWI/NBR),
- surface live wildfires (NASA FIRMS) and natural disasters (NASA EONET),
- diff a place across two dates (change detection).

Claude Code is the brain. Each tool returns its result to Claude **and** best-effort
pushes a "card" to a local dashboard server, which streams it to the browser over SSE —
so you watch the map light up as Claude works.

## Architecture

```
  Claude Code  ──stdio──►  overview-mcp (MCP server, src/index.ts)
                                │  tool: call open API → return to Claude
                                │  AND best-effort POST a card (src/dashboard/push.ts) ↓
                                ▼
                       dashboard server (src/dashboard/server.ts, Node http)
                         POST /ingest   GET /img/:id   GET /events (SSE)   GET /api/state
                                │ SSE
                                ▼
                          Browser dashboard (web/, MapLibre + live card feed)
                            basemap = NASA GIBS true-color (free, no key)
```

One package, two commands (dispatched in `src/cli.ts`):
- `overview-mcp` → stdio MCP server (what Claude Code launches).
- `overview-mcp dashboard` → dashboard server + serves the built UI (default `:5005`).

## Commands

```bash
pnpm install              # installs; prepare runs tsc + vite build
pnpm build                # tsc (server → dist/) + vite build (web → dist/web/)
pnpm typecheck            # tsc --noEmit (server)
pnpm typecheck:test       # tsc -p tsconfig.test.json (src + test/)
pnpm test                 # node:test suite via tsx — FULLY OFFLINE (network is mocked)
pnpm test:watch           # same, re-running on change
pnpm dev                  # run MCP server from source (tsx)
pnpm dev:dashboard        # run dashboard server from source (tsx)
pnpm dev:web              # vite dev server for the frontend (HMR, :5173)
node dist/cli.js          # built MCP server (stdio)
node dist/cli.js dashboard
```

## Testing (offline-first)

`test/` holds a Node-built-in (`node:test`) suite that runs with **zero network and zero
creds** — every HTTP client is exercised through a `fetch` mock (`test/helpers.ts`) against
recorded response fixtures, so the data APIs are never hit. This is the way to make verified
progress in a sandbox with no outbound network / no keys (e.g. Claude Code on the web).

- Pure logic is tested directly: `parseFiresCsv`, `parseStacFeatures`, `statEvalscript`/SCL
  mask, `s2Provenance`, the `util` helpers, and the `/ingest` security validator.
- Clients are tested via the mock, asserting the **bug-prone transforms** (Worldview/EONET/
  FIRMS bbox axis order, Copernicus OAuth token cache + 401 refresh, STAC parsing, geocode).
- New behavior should land with a test here. Live-API verification is still valuable when
  creds/network exist, but is no longer the *only* way to prove a change.

Run: `pnpm test` (+ `pnpm typecheck:test`). CI (`.github/workflows/ci.yml`) runs typecheck →
test → build on every push/PR.

## Configuration (env vars)

| Var | Needed for | Notes |
| --- | --- | --- |
| `CDSE_CLIENT_ID` / `CDSE_CLIENT_SECRET` | `eo_search`, `eo_render`, `eo_index`, `eo_compare` | Free Copernicus Data Space OAuth client |
| `FIRMS_MAP_KEY` | `fires_in` | Free NASA FIRMS map key |
| `OVERVIEW_DASHBOARD_URL` | card push target | default `http://127.0.0.1:5005` |
| `OVERVIEW_DASHBOARD_PORT` | dashboard server | default `5005` |

**`eo_snapshot` and `events` need zero keys** — the zero-setup demo path.

## How to pick up work

1. Read [CONTINUITY.md](CONTINUITY.md) — current task, workflow, task queue.
2. Take the next unchecked item in the TASK QUEUE.
3. If it introduces a new module/surface, write a `.plans/YYYY-MM-DD_<slug>.md` first
   (copy `.plans/_TEMPLATE.md`).
4. Implement → `pnpm build && pnpm typecheck` → smoke-test → update CONTINUITY.md +
   PROGRESS.md → tick the ROADMAP.md checkbox.
5. Keep going until the phase is done or you hit a blocker.

## CRITICAL OPERATIONAL RULES (read first)

1. **Dashboard push is best-effort.** A tool must NEVER fail, block, or noticeably slow
   down because the dashboard is off or unreachable. All pushes go through
   `src/dashboard/push.ts` with a try/catch and a short timeout, and swallow errors.
2. **Open data only.** No paid or satellite-*tasking* APIs in this repo (that's SkyFi's
   space). Everything here is free Copernicus + NASA + OSM.
3. **Pin dependencies exactly.** No `^`/`~`. Mirror the knuspr-mcp discipline.
4. **No commit / push / publish without explicit user approval.** Build locally; the user
   decides when it goes public.
5. **Respect quotas and ToS.** Copernicus has processing-unit limits; FIRMS has
   transaction limits per map key; Nominatim is ≤1 req/s with a descriptive User-Agent.
   Fail gracefully on 429 with a clear message — never hammer.
6. **Cap render size** (default 1024 px) to protect Claude's context / base64 budget, and
   **always return numeric stats alongside images** so Claude can reason without the pixels.

## Code conventions

- TypeScript ESM, Node ≥20, native `fetch`, no HTTP framework (Node `http` for the
  dashboard server).
- MCP tools registered via `server.registerTool(name, { title, description, inputSchema },
  handler)` with zod schemas; wrap handler bodies in the shared `safe()` result helper.
- Errors flow through `OverviewError` (status + body) → `errorResult()`.
- Tools return `{ content: [{ type: "image", data, mimeType }, { type: "text", text }] }`
  for imagery so Claude gets the picture and the numbers.
