# CONTINUITY.md — READ THIS FIRST. DO NOT SKIP.

This is the live state of the project. If you are an agent picking up work, read this whole
file, update the AGENT CHECKIN, then take the next item from the TASK QUEUE. The stable
reference is [CLAUDE.md](CLAUDE.md); the phase plan is [ROADMAP.md](ROADMAP.md).

---

## AGENT CHECKIN

- Agent read full file: YES
- Current task understood: YES
- Current task: **Session 8c complete (2026-09-26 evening, local; Fable orchestrator + 6 more
  Opus workers).** Product renamed **Vital** (earthdeck.co is someone else's; the CLI/npm
  package keeps `earthdeck` for now). **The system now publishes on its own**: trust contract
  `2026-09-26-autonomous` (`TRUST.md`) + `earthdeck analyst --once` (Opus narrates, Sonnet
  reviews with verdict, publish through `publishGates`) — São Félix and Novo Progresso are
  the first AI-published cases (ledger 18 entries, verify OK). **Living value**:
  `natural_value` + `living_value_*` on findings + VISION §15 + research doc. **Public site**:
  `earthdeck watch export` (static, SEO, per-case HTML, in-browser proofs). **Hosting**:
  CloudFormation stack `earthdeck` in Marc's personal AWS (us-east-1), Lambda runner on a
  6-hourly schedule, site at `https://vital.marcsperzel.com`. **GEE**: research + `gee_query`
  client (needs a GCP project/key — UNCONFIRMED live). 283 tests, 43 tools. PR #4.
- Session started: 2026-09-26 (Session 8c)

---

## HANDOFF → next session (written 2026-09-26 late, local)

1. `git checkout main && git pull && pnpm install && pnpm build && pnpm test` (283). Keys in
   `.env` incl. `ANTHROPIC_API_KEY`; run CLI with `node --env-file=.env dist/cli.js …`.
2. **Hosting state**: stack `earthdeck` (profile `personal`, us-east-1). `scripts/deploy.sh`
   is idempotent (`EARTHDECK_DOMAIN` overrides the host; default `vital.marcsperzel.com`).
   `scripts/run-job.sh sweep controls --dry-run` exercises the runner; `scripts/seed-state.sh`
   copies the local ledger to S3 (refuses unless keys match). Schedules: sweeps every 6 h
   staggered (amazon :00 … flaring :40), analyst :50, export +1 h. Alarm email:
   me@marcsperzel.com. Check `state/heartbeat.json` in the state bucket.
3. **Domain + name**: the site is served at **https://vitalearth.io** (registered 2026-09-26,
   $71/yr, refund refused by AWS, auto-renew OFF; Marc dislikes the name but uses it since
   it's paid). The public name is the neutral **"Earth Watch"** (`src/site.config.ts`);
   "Vital Earth" is a taken trademark. **The site is anonymous**: no owner name, email or
   GitHub handle anywhere (test in `test/site-export.test.ts` fails on any); right of reply
   has no channel yet (a forwarding mailbox on the domain is a follow-up). Do NOT register
   or buy anything without showing Marc the exact item + price first. IPv6 is disabled on
   CloudFront on purpose (AAAA-only resolver answers broke the fresh domain on IPv6-less
   networks); Tailscale MagicDNS on Marc's Mac negative-cached the name for an hour.
3b. **Rename — one planned pass once Marc picks a name** (2026-09-26: "naming is all over the
   place: earthdeck / Earth Watch / vitalearth.io"). Checklist: npm package + bin + repo
   name; `src/site.config.ts` (name, fullName, organization, baseUrl); ledger predicate
   `https://earthdeck.dev/finding-event/v1` (keep v1 URL for old entries, add v2 or a
   `$schema` alias — do NOT rewrite history); CloudFormation stack/bucket/function names
   (new stack + migrate state, or keep internal names); domain (registration only after
   trademark check + Marc's explicit OK on the exact name + price); README/CLAUDE/VISION;
   `checkpoint` signer name stays "earthdeck" unless the key is rotated. Do it in one PR.
2b. **Scale-out state (2026-09-26 late)**: `earthdeck discover` generates 549 AOIs
   (`watchlists/generated/`, 19 API calls, 53 s; re-run every ~14 days — doctor warns when
   stale). Runner sweeps `all-generated` in 8 shards per 6-h window (13.5-min budget each),
   analyst +1:20, export +1:30, hand-written lists +1:40; per-day caps: CDSE 40, GFW 400,
   FIRMS 3000, analyst 10 cases / $3. **Measured** (shard 0/8 dry run on Lambda): 82 pairs,
   47 done in budget, 39 candidates, 13 optical confirmations, Copernicus 32 / GFW 69 /
   FIRMS 86 calls. Confirm-only providers (Copernicus for forest_loss) *defer* confirmation
   when spent — detection always runs. TODO: measure Copernicus PU per `eo_compare`/S5P
   call (free tier 10k PU/month) and set the cap from data. Name: **TerraKeep**, slogan
   "Keeping Earth within its limits." — package/repo/stack rename still pending (3b).
3c. **Queued by Marc 2026-09-26/27 (in this order, one at a time — "take it slowly")**:
   -1. **Indicator-threshold rule** (2026-09-27, top of queue, in progress): one generic rule
      `indicator_threshold@1` over the existing zero-key indicator tools — sea ice below
      p10 (NSIDC), marine heatwave at a reef/coast point (OISST), river discharge > 2× mean
      (GloFAS), PM2.5 > WHO for N days in watched cities (CAMS), ENSO phase declared (ONI),
      M7+ quake in a watched region (USGS) — case type "threshold crossed", second signal =
      persistence (next window) or a second dataset. Plus a **trend rule** for annual
      indices (LPI, RLI, fish stocks, ocean pH): one case per year per indicator.
   1. **Backtest harness** — `earthdeck backtest --event <file>`: replay rules with the clock
      set to a past date for 8–10 documented events (2019 Amazon fires, 2020 Black Summer,
      2023 Canada, 2023 Maui, Rumaila flaring 2024, São Félix 2025 loss, Permian methane
      super-emitters, a known false alarm…); report detected / confirmed / lag; publish a
      "would we have caught it" page. Data limits: GFW alerts ≥ 2015, VIIRS ≥ 2012.
   2. **Coral bleaching rule** — NOAA CRW DHW crossing alert levels at a reef watchlist
      (tool `coral_bleaching` exists); second signal: SST anomaly persistence / neighbour cell.
   3. **Extreme-fire rule** — global VIIRS FRP/extent anomaly vs. the same weeks in prior
      years (not only inside protected areas); confirm with a later pass + burn index.
   0. **Improvement rule** (queued 2026-09-26, after the flare "stopped" case type lands):
      cases that open when something *gets better* — loss below the ring baseline for 90 d,
      flaring down year-on-year (VNF), bleaching alert lifted, fires absent in a formerly
      burning protected area — same evidence standard, tag `improvement`, shown on the
      landing as good news. "A watch, not a complaint feed."
   4. **Radiation** — `radiation` tool + `radiation_anomaly` rule from open ground networks:
      BfS ODL (DE, open JSON), EURDEP (EU), EPA RadNet (US), Safecast (global, CC0); dose
      rate vs. station baseline, confirmed by a neighbouring station or second network.
      Add to TRUST.md blind spots meanwhile: satellites cannot see radiation.
4. **Next build steps**: (a) attribution onto cases in `created.context` (`protected_areas` +
   `emitters`); (b) `emitters` as the methane confirmer while EMIT is stale; (c) `ledger verify
   --remote <base-url>` (the case pages already print it); (d) GEE: Marc creates the GCP
   project + service-account key (7 steps in `docs/research/2026-09-26_google-earth-engine.md`)
   → live-verify `gee_query`; MapBiomas pasture to fix the pasture-as-grassland flaw in
   `natural_value`; (e) community votes on cases (signal, not gate) — needs a tiny backend;
   (f) `SITE.dataLicense` choice; (g) M5 docs (CONTRIBUTING, detectors, published error rate).
5. Known risks: reviewer identity is self-declared model strings; EMIT plume feed stale since
   2025-09-22; Overpass 504s under load; FIRMS throttles after bursts (kernel records gaps).


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

## CURRENT STATE (2026-06-12)

- **PR #1 merged.** Session 5's blind-built work (provenance, STAC, SAR ×3, tests+CI) was
  live-verified this session with the real `.env` creds — stac_search returned 5 real
  Sentinel-2 scenes + COG links; eo_index NDVI 0.667 with full provenance; sar_render viewed;
  sar_water 19.4% (Manaus, 100% valid); sar_flood +2 pts Apr→Jun (Amazon rising-water
  season — plausible). Merged via `gh pr merge 1 --merge`; main fast-forwarded.
- **Earth Pulse — the planetary indicators layer (Session 6, plan
  `.plans/2026-06-12_earth-pulse.md`).** The repo's scope grew from "satellite imagery" to
  **the data layer for the Earth system**: 10 new tools, all zero-key, all with historic
  series + trends. New shared series model (`src/series.ts`: linearTrend/decimate/
  monthlyMean/annualMean/summarize, all pure + tested). New clients:
  `clients/indicators.ts` (ONI + NOAA-rule `ensoPhase`, CO₂ Mauna Loa, GISTEMP, NSIDC sea
  ice v4 + climatology), `clients/erddap.ts` (OISST point SST 1981→now, auto-stride ≤400 pts,
  end clamped to dataset `(last)`), `clients/openmeteo.ts` (ERA5 archive 1940→, CAMS air
  quality, GloFAS discharge 1984→), `clients/usgs.ts` (FDSN quakes). New tools:
  `tools/ocean.ts` (enso, ocean_temp), `tools/indicators.ts` (co2, global_temp, sea_ice,
  planet_pulse — parallel + partial-failure tolerant), `tools/climate.ts` (climate_history,
  air_quality, river_discharge), `tools/quakes.ts` (quakes).
- **Dashboard: 3 new card types.** `series` (hand-rolled SVG chart, `web/src/chart.ts`,
  zero new deps; multi-line + dashed thresholds + legend), `quakes` (magnitude-scaled GPU
  circle layer + popups), `pulse` (vital-signs metric grid). Server `CARD_TYPES` allow-list
  extended; all built via DOM nodes/textContent (XSS-safe).
- **Live-verified (2026-06-12), all real APIs:** ENSO Neutral ONI +0.48 (MAM 2026, strongest
  El Niño NDJ 2015 +2.75); Niño3.4 SST 28.03 °C; CO₂ 432.34 ppm (+1.83 YoY, +25.7/decade);
  GISTEMP +1.12 °C (2026-05, +0.27 °C/decade since 1980); Arctic ice 10.759 M km² (−1.282 vs
  climatology, below p10), Antarctic 11.79 (−1.104, below p10); 20 quakes M5.5+ incl. M7.8
  Philippines; Berlin 1950→2026 warming ~+0.5 °C/decade recent; Delhi AQI 167 (PM2.5 63
  ⚠️ WHO); Rio Negro discharge 2.46× period mean (rising-water season — consistent with
  sar_flood!). planet_pulse degrades gracefully when one source throttles (EONET).
  **All 16 E2E calls green in one session** (`scripts/live-drive.mjs`); dashboard
  screenshotted with charts, quake markers, pulse grid.
- **22 tools, 88 offline tests, build + typecheck green.**
- **This session (5): Provenance block (Horizon 1 item 3).** Every Copernicus output
  (`eo_render`/`eo_index`/`eo_compare`) now carries a structured `provenance` block — data
  source, sensor/collection, composite window + mosaicking, cloud-mask method + the exact
  masked SCL classes, % valid, best-effort contributing scene IDs, bbox, retrieved-at, and a
  decision-support disclaimer — in the tool output **and** the dashboard cards.
  New `src/provenance.ts`; SCL masked-class list now a single shared constant in
  `evalscripts.ts` (`SCL_CLEAR_MASK` + `maskedClassesFor`) so the reported mask can't drift
  from the applied mask. Build + typecheck green; 27 offline checks pass (incl. byte-identical
  mask refactor); MCP lists all 8 tools.
- **Also this session: internal STAC layer (Horizon 1 item 6).** New `stac_search` tool
  (`src/tools/stac.ts`, `src/clients/stac.ts`) hits the open, **no-auth Earth Search (Element
  84)** STAC API — a **zero-key** scene search (today's `eo_search` needs CDSE OAuth) that
  also returns **COG asset URLs** (the Horizon 2 substrate). Endpoint configurable via
  `EARTHDECK_STAC_URL` (→ Planetary Computer / self-hosted). Now **9 tools**. The parser
  `parseStacFeatures()` is pure + fixture-tested (15 checks); the no-network error path is
  graceful (`isError`, clean message).
- **Also this session: offline test infrastructure.** New `test/` suite on Node's built-in
  runner (`node:test`, **zero new deps**), run via `tsx`: **53 tests across 9 files**, all
  green with **no network and no creds** — every HTTP client goes through a `fetch` mock
  (`test/helpers.ts`) against fixtures. Covers pure logic (FIRMS/STAC parsers, SCL mask,
  provenance, util) + the bug-prone client transforms (Worldview/EONET/FIRMS bbox axis order,
  Copernicus OAuth token cache + 401 refresh, geocode) + the `/ingest` XSS security boundary
  (`validateIngest`, now exported). `pnpm test` / `pnpm typecheck:test`; **GitHub Actions CI**
  (`.github/workflows/ci.yml`) runs typecheck → test → build on push/PR. This is the answer to
  "how do we work offline" — verified progress no longer depends on live APIs.
- **Also this session: Sentinel-1 SAR (Horizon 1 item 2 — the #1 weakness).** New `sar_render`
  tool (all-weather radar; VV / VH / VV-VH-ratio false-color; GAMMA0 terrain-corrected). To get
  there, generalized `CopernicusClient` to target any collection via a `DataSourceSpec`
  (`buildInput` + `s2Source`) — the Sentinel-2 request body is unchanged (deep-equality test
  guards it). Added `SAR_EVALSCRIPTS` and `sarProvenance` (no cloud mask — records all-weather
  as the advantage). Added `sar_water` (all-weather water/flood extent: water % of the AOI from
  low VV backscatter, via the now-generalized `statistics()` + a binary water evalscript whose
  mean = water fraction; thresholdDb default −17) and `sar_flood` (flood onset: Δ water %
  between a pre-event baseline and a post-event date, with a pure unit-tested `floodResult`
  helper). **12 tools, 65 tests.** ⚠️ Live S1 render/stats + threshold/visualization-gain tuning
  deferred (documented starting points); the request-body shapes, evalscripts, water-fraction +
  flood-delta logic, and provenance are offline-verified.
- **This container has NO `.env`/creds and NO outbound network** (all hosts 403 via policy —
  even the open STAC endpoints), so ALL live API verification is deferred this session. The
  provenance + STAC-parser work is pure, fully offline-verifiable logic.
- Next (need live CDSE creds AND/OR network to verify): **cloud-masking upgrade** (Cloud
  Score+ / s2cloudless / OmniCloudMask, item 1 — highest leverage) and **Sentinel-1 SAR**
  (item 2). The shared mask constant + provenance `cloudMask.method` field are set up to make
  the masking upgrade a localized change. Also pending: **live-verify `stac_search`** against
  Earth Search the moment a session has network.

## TASK QUEUE

Phase 0 — Scaffold: ✅ done
Phase 1 — Zero-key slice: ✅ done
Phase 2 — Fires: ✅ done + live-verified (133 real detections, Western US)
Phase 3 — Copernicus core: ✅ done + live-verified (Sentinel-2 render + NDVI 0.279 + search)
Phase 4 — Change detection: ✅ done + live-verified (São Félix do Xingu NDVI −0.146, 2019→2025)

Phases 0–5 (Horizon 0): ✅ done + shipped public. 8 tools, all live-verified.

Horizon 1 — Trustworthy analyst (current):
- [x] **Provenance block** on every numeric/imagery output (this session) — offline-verified.
- [x] **Internal STAC layer** — `stac_search` (Earth Search, no key, COG URLs) (this session)
      — offline-verified (15 parser checks); ⚠️ live Earth Search call deferred (no network).
- [x] **Sentinel-1 SAR** (item 2) — `sar_render` backscatter (VV/VH/false-color) + `sar_water`
      (water/flood extent) + `sar_flood` (flood onset, Δ water between two dates), via a
      generalized multi-collection client (this session). ⚠️ live render/stats + threshold/viz-gain tuning deferred.
- [ ] **Better cloud masking** (item 1, highest leverage) — Cloud Score+ / s2cloudless /
      OmniCloudMask behind `eo_index`/`eo_render`/`eo_compare`. ⚠️ needs live CDSE to verify.
- [x] **Temporal-median compositing** (#4, Session 7) — `composite: "median"` on
      eo_render/eo_index/eo_compare (ORBIT mosaicking, per-pixel median of clear samples,
      shared mask, composite-aware provenance). Live-verified: cloud-free Manaus render,
      compare at 96%/96% valid. Live driver: `node scripts/live-median.mjs`.
- [x] **GFW alerts (#5, Session 7)** — `forest_alerts` (tool #24) shipped + LIVE-VERIFIED:
      GFW integrated deforestation alerts (GLAD-L+GLAD-S2+RADD, daily 10 m, 30°N–30°S) via
      the Data API SQL endpoint; summary + confidence breakdown + daily counts → series
      card; doctor probe ✓. Key in .env (GFW_API_KEY, account me@marcsperzel.com, expires
      2027-06-12). Live: São Félix 90 d = 3697 alerts/45.2 ha; high+ = 2784/34.0 ha.
      Gateway quirks encoded in src/clients/gfw.ts: origin header required, IN unsupported
      (OR chain), AS aliases ignored, transient 403 → 1 retry.
- [ ] STAC-backed render path (see ROADMAP).

Session 7b (2026-06-13) — user asks + Horizon 2:
- [x] **narrate (tool #25)** — streamed dashboard notes (plan `.plans/2026-06-12_narrate.md`):
      `note` card type, server upsert-by-id, in-place node swap in the feed, markdown-lite
      renderer (DOM-only, XSS-safe), 1–20k char validation. Smoke: 3 calls → 1 evolving card.
- [x] **Dashboard nav fixes** — re-clicking imagery/compare cards flies back (was early-return
      on existing source), index/search/any-bbox cards navigate via fallback, imagery zooms
      to 13.
- [x] **eo_similar (tool #26, Horizon 2 #1)** — plan `.plans/2026-06-13_eo-similar.md`. Zero-key
      AlphaEarth similarity search over the Source Coop COG mirror. Key infra: `src/utm.ts`
      (Krüger, <1 cm vs PROJ), `src/clients/aef.ts` (ranged binary search of the 798 MB
      index; pinned bottom-up BigTIFF reader; fzstd; coalesced reads; 5xx retry; pool(3)),
      `similar` heatmap card. Live: urban ref → Manaus grid (1.0 at ref), river → Rio Negro.
- [ ] Horizon 2 next: embedding-difference change detection (two years, same grid — the
      AEF client already supports `year`) · few-shot classification · pgvector index.

Earth Watch — the public accountability loop (Session 8, planned 2026-09-26) — **CURRENT**:
Plan `.plans/2026-09-26_earth-watch.md` (read it first; it holds the strategy decisions and
the trust contract). Checkboxes mirror the ROADMAP "Earth Watch" block.
- [x] M1 ledger: `src/ledger/{jcs,merkle,checkpoint,schema,store}.ts` + 21 tests (RFC
      vectors, tampering, every trust-contract rule). Witnessed Merkle log, not a hash chain.
- [x] M1 dashboard: `LedgerView` (`/api/ledger*`, feeds, `/ledger/*`), `finding`/`worldpulse`
      cards, Watch tab (cases list + case page + map outline). Screenshotted.
- [x] M1 `world_pulse` (tool #27) + `src/clients/owid.ts` registry + `earthdeck ledger` CLI.
      ⚠️ verify OWID grapher CSV URL shape on a networked session.
- [x] M2 kernel (`src/watch/`), rules `forest_loss` + `fires_in_protected` (blind spots
      required, ring baselines, independent confirmation), watchlists + controls, journal
      (watermarks, heartbeat), `earthdeck watch --once [--dry-run]`, README. ⚠️ live sweep
      with keys still to run; doctor not yet aware of the watch keys/ledger.
- [ ] M3 attribution tools (`protected_areas`, `emitters`, `methane_plumes`, `flaring`) +
      detectors + `ledger_*` tools
- [ ] M4 static export + scheduled Actions + Pages · analyst step · response tracking
- [ ] M5 TRUST.md / CONTRIBUTING.md / docs / accuracy page
MVP = M1 + M2. Don't start M3 before one real sweep has opened one real case end-to-end.

Earth Pulse — planetary indicators (Session 6): ✅ done + live-verified (see ROADMAP section).
- [x] 10 zero-key tools: enso · ocean_temp · co2 · global_temp · sea_ice · quakes ·
      climate_history · air_quality · river_discharge · planet_pulse
- [x] series/quakes/pulse dashboard cards + SVG chart renderer (no new deps)
- [x] Offline tests 65 → 88; full 16-call live E2E green; dashboard screenshotted

Onboarding (Session 6, "make it super simple"): ✅ done + live-verified
- [x] `earthdeck demo` — zero-key wow path: starts the dashboard, runs the real MCP
      server in-process (InMemoryTransport), calls 7 zero-key tools, opens the browser.
- [x] `earthdeck doctor` — checks Node, env keys, and live reachability of all 9
      zero-key sources + CDSE OAuth + FIRMS key status (with quota); 1 retry on transient
      throttles; prints exactly what's ready and the links to fix what isn't.
- [x] README restructured: 30-second `npx … demo` quickstart + `claude mcp add` one-liner
      ABOVE the tool tables; keys table with direct links; doctor output sample.

27 tools total. Build + typecheck green. **156 offline tests green** (`pnpm test`).
Live driver: `node scripts/live-drive.mjs [tool …]` (boots dashboard on :5099, reads `.env`).

Engineering quality (cross-cutting):
- [x] Offline `node:test` suite (53 tests, network mocked) + GitHub Actions CI. (this session)
- [ ] Publish to npm (currently `npx github:` install).

Useful test fixtures: Amazon near Manaus bbox `[-60.2,-3.3,-59.8,-2.9]`; events smoke
returns Tropical Storm Amanda. Run the dashboard on a non-default port to avoid clashes:
`EARTHDECK_DASHBOARD_PORT=5009 node dist/cli.js dashboard`, then point tools at it with
`EARTHDECK_DASHBOARD_URL=http://127.0.0.1:5009`.

---

## SESSION LOG

### 2026-09-26 — Session 8b (local: M2 live sweep, M3, UI, life layer — the MVP)
- See PROGRESS.md for the full entry. One orchestrator + six Opus workers in worktrees;
  first real cases in the ledger; controls tuned from data; three live-API bugs fixed;
  M3 tools + rules + `ledger_*` shipped and live-verified; dashboard redesigned.

### 2026-06-12 — Session 6c (rename → earthdeck; npm; cloud masking; NASA CMR)
- **Renamed the project to `earthdeck`** (user choice; npm/GitHub searchability). GitHub repo
  renamed (old URLs redirect); npm `earthdeck@0.3.x` published; `overview-mcp` deprecated with
  a pointer (kept installable; `overview-mcp` bin alias retained in the earthdeck package).
  Env prefix is now `EARTHDECK_*` with `OVERVIEW_*` still honored (config.ts `env()` helper).
- **Cloud masking rung 1 (Horizon 1 #1)**: stat evalscripts now mask SCL + s2cloudless
  (CLM=1 or CLP≥102/255) — CDSE band support live-confirmed first. Provenance method/classes
  updated via shared constants. Live: Manaus validPct 64→61%, NDVI 0.667→0.675.
- **`earthdata_search` (tool #23)**: NASA CMR collections search (keyless) — topic/bbox/time
  → most-used datasets with concept ids + landing pages; search card lists collections.
  CMR *granule* endpoint was timing out repeatedly (2026-06-12) → granule-level search
  delegated to NASA's hosted Earthdata MCP (documented in README "Goes well with").
- `demo`/`doctor` commands added earlier this session (see 6b note in PROGRESS); doctor now
  probes CMR too (10 zero-key sources).

### 2026-06-12 — Session 6 (PR #1 verification + merge; Earth Pulse)
- Live-verified everything Session 5 built blind, with real creds: 65/65 offline tests, then
  stac_search (5 real S2 scenes + COG links), eo_index provenance (NDVI 0.667, 64% valid),
  sar_render (S1 false-color viewed), sar_water (19.4%, 100% valid), sar_flood (+2 pts
  Apr→Jun over Manaus — Amazon rising-water season). Merged PR #1 (`--merge`, branch deleted).
- **Earth Pulse:** live-grounded 9 data sources with curl first (ONI, CO₂, GISTEMP, NSIDC
  v4 — note: v3 path is dead, v4 + climatology is current —, USGS FDSN, ERDDAP OISST incl.
  stride + `(last)`, Open-Meteo archive/air/flood; Open-Meteo *marine* SST history only
  reaches ~2022 → used ERDDAP OISST for the long series). Then plan → series model → 4
  clients (parsers pure + fixture-tested) → 10 tools → 3 dashboard card types → 23 new
  offline tests → full live E2E (16 calls) → screenshots.
- Gotchas: ERDDAP strided multi-decade reads can take ~60 s on first hit (cached after);
  ONI seasons map to mid-months (DJF → Jan per CPC); GISTEMP uses `***` for missing; NSIDC
  v4 CSV quotes the source-file column (regex parse, not naive split); `yearFraction` of a
  bare year must land mid-year or annual-series trends skew.
- Server instructions rewritten around the "data layer for the Earth system" framing +
  cross-referencing hints (ENSO ↔ fires/floods/SST; discharge ↔ SAR floods).

### 2026-06-06 — Session 5 (SAR flood onset)
- Added `sar_flood(bbox, dateBefore, dateAfter, …)` — composes the water measurement across two
  dates (pre-event baseline vs post-event) and reports the Δ water %: positive over a short
  window = flooding. All-weather, so it works for storms/monsoons optical can't see through.
- Extracted a pure `floodResult()` helper (delta, low-quality flag, interpretation) and
  unit-tested it directly (`test/sar.test.ts`) — flood/recede/unchanged/rounding/low-coverage.
- Verified offline: 65 tests green; typecheck (src+test) + build green; MCP lists 12 tools.
  ⚠️ Live S1 stats deferred.

### 2026-06-06 — Session 5 (SAR water/flood extent)
- Added `sar_water` — quantifies the water-covered fraction of an AOI from Sentinel-1 VV
  backscatter (water/smooth = low γ⁰), all-weather flood/water signal. Generalized
  `statistics()` to accept a `source` (mirrors the `process()` refactor); a binary water
  evalscript whose Statistical-API mean = water fraction; thresholdDb (default −17) → linear.
- Verified offline: 60 tests green (water evalscript threshold/bands; S1 statistics body shape
  + water-fraction from a mocked response; S2 statistics unchanged); typecheck (src+test) +
  build green; MCP lists 11 tools. ⚠️ Live S1 stats + threshold tuning deferred.

### 2026-06-06 — Session 5 (Sentinel-1 SAR — the all-weather answer)
- Added `sar_render` (Sentinel-1 GRD backscatter: VV / VH / VV-VH-ratio false-color; GAMMA0
  terrain-corrected, most-recent in a lookback window) — the start of closing our #1 weakness.
- Generalized `CopernicusClient`: `DataSourceSpec` + `buildInput`/`s2Source` so Process can
  target any collection; the **S2 request body is byte-unchanged** (deep-equality test guards
  it). New `SAR_EVALSCRIPTS` (sqrt-stretch viz) + `sarProvenance` (all-weather → no cloud mask).
- Verified offline: 57 tests green (SAR evalscripts, S1 vs S2 request-body shape, SAR
  provenance), typecheck (src+test) + build green, MCP lists 10 tools, no-creds path returns a
  clean error. ⚠️ Live S1 render + visualization-gain tuning deferred (no creds/network) —
  gains documented as a starting point.

### 2026-06-06 — Session 5 (offline test suite + CI)
- Built the thing that unblocks all future offline work: a `node:test` suite (zero new deps,
  run via `tsx`) with a `fetch` mock so HTTP clients are tested without network. **53 tests,
  9 files**, all green offline. Covered pure logic + the bug-prone transforms + the `/ingest`
  security validator (exported `validateIngest`).
- Added `tsconfig.test.json` (type-checks src+test; the `tsc` build still only emits
  src→dist — verified no test files leak to `dist/`), `pnpm test`/`test:watch`/`typecheck:test`
  scripts, and `.github/workflows/ci.yml` (typecheck → typecheck:test → test → build).
- CLAUDE.md now documents the offline-first testing approach; ROADMAP "add CI" ticked.
- Verified the full CI sequence locally: all green; the only failure found was a wrong
  expectation in my own test (heightFor), fixed — the code was right.

### 2026-06-06 — Session 5 (Horizon 1: internal STAC layer)
- Second Horizon 1 step (item 6). With no creds AND no outbound network (all hosts 403),
  chose the most offline-verifiable foundational item: a provider-independent STAC search.
- New `src/clients/stac.ts` (pure `parseStacFeatures()` + thin `stacSearch()` fetch wrapper),
  `src/tools/stac.ts` (`stac_search`, no key), `config.stacUrl()` (`EARTHDECK_STAC_URL` ??
  Earth Search). Returns scene ids/dates/cloud + **COG asset URLs**; endpoint swappable to
  Planetary Computer / self-hosted. Registered in `index.ts` (9 tools); README + `.env.example`
  updated.
- Verified offline: `tsc` + `vite build` green; **15 parser fixture checks** (6→4 bbox
  normalize, data-vs-thumbnail asset split, least-cloudy sort, `maxCloud` filter, malformed
  feature skipped, missing-features → []); MCP lists `stac_search`; live call returns a clean
  wrapped error (`403 Host not in allowlist`) — confirms fetch wiring + graceful failure.
  Live Earth Search response parsing deferred to a session with network.

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
