# AGENTS.md — earthdeck

Generic agent guidance. For the full reference see [CLAUDE.md](CLAUDE.md); for the live
task state read [CONTINUITY.md](CONTINUITY.md) **first**.

## One-liner

Earth-observation MCP server + live mission-control dashboard, over free Copernicus + NASA
data. Claude drives; the dashboard shows what Claude sees.

## Commands

```bash
pnpm install
pnpm build           # tsc + vite build
pnpm typecheck
pnpm dev             # MCP server (stdio) from source
pnpm dev:dashboard   # dashboard server from source
pnpm dev:web         # vite dev server (frontend HMR)
```

## Layout

```
src/cli.ts              dispatch: `dashboard` arg → dashboard server; else MCP stdio
src/index.ts            MCP bootstrap + tool registration
src/tools/*             tool groups (imagery, analysis, events)
src/clients/*           HTTP clients (copernicus, nasa, geo)
src/dashboard/*         dashboard server + best-effort card push
src/evalscripts.ts      Sentinel Hub band-math library
web/                    dashboard frontend (Vite + MapLibre) → dist/web
```

## Working rules (short form)

- Read CONTINUITY.md, take the next TASK QUEUE item, keep going until the phase is done.
- New module/surface ⇒ write a `.plans/` entry first.
- After each change: `pnpm build && pnpm typecheck`, smoke-test, update CONTINUITY.md +
  PROGRESS.md, tick the ROADMAP.md box.
- Hard rules live in CLAUDE.md "CRITICAL OPERATIONAL RULES" — dashboard push is
  best-effort, open data only, deps pinned, no commit/push without approval, respect ToS,
  cap image size.

## Continuity Ledger (for long-running tasks)

Keep CONTINUITY.md current. Begin work by restating **Goal / Now / Next**. Facts only;
mark uncertainty as `UNCONFIRMED`.
