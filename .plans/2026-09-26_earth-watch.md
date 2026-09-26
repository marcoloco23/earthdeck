# Plan: Earth Watch — the public accountability loop

**Date**: 2026-09-26
**Status**: PLANNING
**Phase**: Horizon 3 (the Watchdog), pulled forward as a public-good MVP. See VISION.md §14.

## Goal

Turn earthdeck from a *monitoring toolkit* into a **standing, public, evidence-first watch
on the planet**: an agent that sweeps the Earth around the clock with the tools we already
have, writes every finding to a tamper-evident public ledger with its evidence, tracks
whether anything happened about it, and publishes an honest "how are we doing" pulse —
good news and bad — that anyone can read and anyone can check.

The one-line product: **"Here is what changed on Earth, here is the proof, here is who was
told, and here is whether it was fixed."**

## Background

The brainstorm (2026-09-26) landed on four conclusions, which this plan implements:

1. **Detection is mostly solved; consequences aren't.** GFW, FIRMS, S5P, Climate TRACE all
   publish alerts. Almost nobody openly links an alert to a responsible asset, routes it to
   someone with leverage, and records what happened next. The loop is
   `detect → verify → attribute → route → track the response`. earthdeck today does steps
   1–2 (26 tools). Steps 3–5 are the impact and the moat (cumulative history, VISION §4).
2. **The audience is the public first.** Trust is earned in the open; leverage-holders
   (buyers under EUDR, lenders, regulators, journalists) consume the *same* ledger via a
   machine-readable feed. One product, two doors. Nothing elitist, nothing paywalled.
3. **Trust must rest on evidence, not on the AI.** Every finding carries scene IDs, dates,
   method + version, confidence, and a re-runnable recipe. We publish our own error rate.
   Assets and institutions are watched — never individuals. Named parties get a right of
   reply, and no finding names anyone without a human sign-off.
4. **Balance is a feature.** A pulse that says "6 improving, 3 worsening, 1 accelerating"
   is more trustworthy *and* more motivating than a news feed. Education is part of the job.

Constraints inherited from CLAUDE.md: open data only, best-effort dashboard push, exact
dep pinning, respect quotas, no commit/push without approval. Node ≥ 20 (so no
`node:sqlite`; the ledger is a JSONL append log, zero new deps).

## Strategy decisions (the ones the plan hinges on)

### Who it's for — "public first, leverage second, same ledger"

| Audience | What they get | Why they matter |
| --- | --- | --- |
| **The public** (primary) | The Watch site: open cases with evidence, the world pulse, plain-language explainers | They are the trust we're building. A watchdog nobody reads has no teeth. |
| Journalists / NGOs | JSON + GeoJSON feed, per-case evidence bundles, `earthdeck` MCP for their own digging | Amplifiers. They turn a ledger row into a story. |
| Leverage-holders (EUDR buyers, lenders, regulators) | The same feed, filtered by asset/commodity/country; EUDR deadline 30 Dec 2026 makes this a *need* | They are the "route" step. Response tracking only works if someone can act. |
| Contributors | Detector recipes + watchlists as plain JSON in the repo; PR a watch, PR a detector | Open source is how a watch on the whole planet gets staffed. |

### Wedge — methane & flaring first, deforestation/EUDR second

- **Methane / flaring**: highest climate impact per unit of effort (methane drives ~30 % of
  current warming; fixing a super-emitter is often a wrench, not a policy), fully open
  data (Sentinel-5P via CDSE — we already have the OAuth client; Climate TRACE asset
  emissions, no key; UNEP IMEO MARS notifications), clear responsible parties (the
  operator of a named facility), and "notified vs. fixed" is a *new* thing to publish.
- **Deforestation / EUDR**: `forest_alerts` already works. Adding protected-area and
  concession attribution makes it a case, and the legal deadline creates demand.
- Later: illegal fishing (Global Fishing Watch), mining creep, reservoir drawdown.

### The trust contract (non-negotiable, written into the schema)

1. A finding cannot exist without an `evidence[]` block. The ledger rejects it.
2. Status is a state machine: `candidate → verified → published → notified → resolved |
   ignored | false_positive`. Only `published+` rows appear on the public site.
   `candidate → verified` needs a second, independent signal (e.g. GFW alert **and** an NDVI
   drop; S5P plume **and** a Climate TRACE asset at that point) *or* a human review.
3. `false_positive` rows are **never deleted** — they are our published error rate.
4. Naming a party (`attribution.party`) requires `review.by` set (a human). The agent may
   propose, never publish, a name. A `reply` field exists for the named party's response.
5. Subjects are **assets, places, and institutions**. No detector may target a person.
6. Rows are hash-chained (`prevHash` → `hash` over canonical JSON). Anyone can verify the
   log wasn't edited after the fact; a reproduction recipe (`recipe`) re-runs the tool calls.

### Around-the-clock, for free

`earthdeck watch --once` is a deterministic sweep that runs anywhere (laptop, cron,
**GitHub Actions on a schedule**). Actions runs it every N hours with the keys in repo
secrets, commits the ledger to a `watch-data` branch, and deploys a static export to
GitHub Pages. That's a 24/7 public watch with zero infrastructure cost. The optional
**analyst** step (Claude via `claude -p` / the Messages API) runs after each sweep to
cross-check candidates with a second tool and write the plain-language explanation —
so the AI reasons, but the deterministic layer decides what *counts* as a finding.

## Approach

Option A: Build the public site as a separate app (Next.js etc.) reading from a hosted DB.
Option B: Extend the existing Node dashboard + a static export; JSONL ledger in-repo.
Option C: Only ship MCP tools (attribution/pulse) and leave the ledger to users.

**Decision: B.** Zero new runtime deps, reuses the card feed + SSE + chart renderer, keeps
the whole thing self-hostable and forkable (open-source requirement), and the static
export gives a public URL without running a server. C doesn't build the moat (history);
A splits the codebase and adds hosting cost before there's a reason.

## Architecture

```
 watchlists/*.json ──► earthdeck watch [--once|--every 6h]  (src/watch/runner.ts)
   (AOIs + detectors)        │  runs the real MCP server in-process (as demo.ts does)
                             │  for each AOI × detector: call tools → candidate findings
                             ▼
                       detectors (src/watch/detectors/*.ts)  — pure rules over tool output
                             │  forest-loss · fires-in-protected · methane-plume · flaring
                             ▼
                       ledger (src/ledger/*.ts) ── data/ledger.jsonl (append-only, hash-chained)
                             │  status machine · evidence required · attribution needs review
                             ├──► optional analyst (src/watch/analyst.ts): 2nd-signal check + narrative
                             ├──► dashboard cards (finding / pulse) via push.ts (best-effort)
                             └──► GET /api/ledger, /api/ledger/:id, /feed.json, /feed.geojson
                                       │
                       web/  "Watch" view: open cases · case page w/ evidence · world pulse
                       `earthdeck watch export` → static site (dist/site) → GitHub Pages
```

New MCP tools (so Claude — and contributors' agents — can work the loop interactively):

| Tool | Backend | Key | Purpose in the loop |
| --- | --- | --- | --- |
| `world_pulse(indicators?)` | Our World in Data grapher CSV + World Bank API | none | civilization vital signs w/ direction + "better when" |
| `protected_areas(bbox)` | OSM Overpass `boundary=protected_area` (zero-key); Protected Planet/WDPA when token set | none / opt | attribution: is this inside a reserve? |
| `emitters(bbox, sector?)` | Climate TRACE assets API | none | attribution: which facility is here, what does it emit? |
| `methane_plumes(bbox, days)` | Sentinel-5P CH₄ via CDSE Statistics + (verify) UNEP MARS public plumes | CDSE OAuth | detect: column-CH₄ anomaly vs. window baseline |
| `flaring(bbox, days)` | VIIRS Nightfire (EOG, free registration) — fallback: VIIRS fires w/ high FRP at known O&G assets | opt | detect: flaring at emitters |
| `ledger_find(id?, status?, bbox?)` / `ledger_add(finding)` / `ledger_update(id, status, note)` | local ledger | none | Claude can read, propose, and advance cases (never publish a name) |

`world_pulse` reuses `src/series.ts` exactly like `planet_pulse`. Indicator registry
(`src/clients/owid.ts`) is a table: slug, label, unit, `betterWhen: "up" | "down"`, source
URL — so a contributor adds an indicator with one line. Initial set (all OWID, zero-key):
child mortality ↓, extreme poverty ↓, life expectancy ↑, solar+wind share ↑, coal share ↓,
CO₂ per capita ↓, forest area ↑, protected land share ↑, deaths from disasters ↓, literacy
↑, conflict deaths ↓ (UCDP via OWID), renewable capacity additions ↑. Output: each with
latest, 10-y trend, `direction` (improving/worsening/flat vs. `betterWhen`), and
`accelerating` (trend of the last 5 y vs. the prior 10).

## Milestones

**M1 — Memory (the ledger) + the pulse.** *Zero-key, fully offline-testable, ships the
"balanced dashboard" alone.*
- `src/ledger/{schema,store,hash}.ts`: Finding type (zod), JSONL append store w/ in-memory
  index, hash chain, status machine, validation (evidence required; party ⇒ review).
- Dashboard: `/api/ledger*`, `/feed.json`, `/feed.geojson`; `finding` + `worldpulse` card
  types; a **Watch** tab in `web/` (cases list → case page: map, evidence, timeline, status).
- `world_pulse` tool + `src/clients/owid.ts` + `worldpulse` card (reuses `chart.ts`).
- Tests: ledger round-trip, chain verification detects tampering, status transitions,
  "no evidence ⇒ reject", "party without review ⇒ reject", OWID parser + direction logic.

**M2 — The sweep (`earthdeck watch`).** *Needs GFW/FIRMS/CDSE keys for live runs; the
runner + detectors are offline-testable against fixtures.*
- `watchlists/` JSON format (id, name, bbox, tags, detectors[], `party?` w/ source URL) +
  a seed list: ~10 protected areas / high-risk concessions (Amazon, Congo, Borneo), ~5
  oil & gas basins (Permian, Turkmenistan, Algeria, Iraq, Niger Delta), 3 control AOIs
  (expected-quiet, to measure our false-positive rate).
- `src/watch/runner.ts` (in-process MCP client like `demo.ts`; rate-limited; resumable;
  `--once` / `--every`), `src/watch/detectors/{forestLoss,firesInProtected,methane,flaring}.ts`
  (pure functions: tool output → candidate | null, with thresholds in the watchlist).
- Dedup: same AOI + detector within `cooldownDays` → update existing case, don't open a new one.
- `earthdeck watch` CLI in `src/cli.ts`; doctor learns the new keys.

**M3 — Attribution + methane wedge.**
- `protected_areas`, `emitters`, `methane_plumes`, `flaring` tools + clients + fixtures.
- Detectors gain `attribution` (auto-proposed asset/reserve; `party` stays unreviewed).
- Case page shows attribution + a "response" timeline (notified → resolved/ignored).
- `ledger_*` MCP tools so Claude can triage interactively on the dashboard.

**M4 — Public & around-the-clock.**
- `earthdeck watch export` → `dist/site` (static Watch site + feeds; no server needed).
- `.github/workflows/watch.yml`: schedule (every 6 h), runs `watch --once` with secrets,
  commits `data/ledger.jsonl` to `watch-data`, deploys Pages.
- `src/watch/analyst.ts` (optional; `ANTHROPIC_API_KEY` or `claude -p`): for each new
  candidate, run one independent cross-check tool and draft the explanation +
  `recipe`; writes back as `verified` only when the 2nd signal agrees. Prompt + tool
  allow-list kept in `src/watch/analyst.prompt.md`.
- Response tracking: `notify` step records *who* was told (public contact/regulator URL,
  never personal data) and starts the "days open" clock shown on the site.

**M5 — Open it up.**
- `CONTRIBUTING.md` + `docs/detectors.md` + `docs/watchlists.md` (recipe format, how to PR a
  watch, review rules); the trust contract published as `TRUST.md`; issue templates for
  "false positive" and "right of reply".
- Published accuracy page: counts by status, false-positive rate per detector, generated
  from the ledger.

M1 + M2 are the MVP; M3–M4 make it a watchdog; M5 makes it a movement.

## Implementation steps

- [ ] M1: ledger schema + store + hash chain + tests
- [ ] M1: dashboard ledger endpoints + feeds; `finding`/`worldpulse` in `CARD_TYPES`
- [ ] M1: `world_pulse` tool, OWID client + registry, fixtures + tests
- [ ] M1: Watch tab in `web/` (cases list, case page, pulse grid)
- [ ] M2: watchlist format + seed lists + validation
- [ ] M2: runner (in-process MCP, rate limits, dedup/cooldown, `--once`/`--every`)
- [ ] M2: detectors forestLoss + firesInProtected (+ tests on fixtures)
- [ ] M2: `earthdeck watch` CLI + doctor updates + README section
- [ ] M3: `protected_areas` (Overpass), `emitters` (Climate TRACE), `methane_plumes` (S5P), `flaring`
- [ ] M3: methane + flaring detectors; attribution on cases; `ledger_*` tools
- [ ] M4: static export + Pages + scheduled Actions workflow
- [ ] M4: analyst step (2nd-signal verification + narrative) + response tracking
- [ ] M5: CONTRIBUTING / TRUST / docs / accuracy page

## Files to create / modify

| File | Change |
| --- | --- |
| `src/ledger/schema.ts` | `Finding`, `Evidence`, `Attribution`, `Status` (zod); transition table |
| `src/ledger/store.ts` | JSONL append-only store, in-memory index, query, `verifyChain()` |
| `src/ledger/hash.ts` | canonical JSON + SHA-256 chain (`node:crypto`) |
| `src/clients/owid.ts` | OWID grapher CSV fetch + indicator registry (`betterWhen`) |
| `src/clients/{overpass,climatetrace,s5p,eog}.ts` | attribution/detection clients |
| `src/tools/{worldpulse,attribution,methane,ledger}.ts` | new MCP tools |
| `src/watch/{runner,watchlist,analyst}.ts`, `src/watch/detectors/*.ts` | the sweep |
| `src/cli.ts` | `watch` subcommand (`--once`, `--every`, `export`) |
| `src/dashboard/server.ts` | `/api/ledger*`, `/feed.*`, new card types, static ledger dir |
| `src/config.ts` | `EARTHDECK_LEDGER_PATH`, `PROTECTED_PLANET_TOKEN`, `EOG_TOKEN`, `ANTHROPIC_API_KEY` |
| `web/src/{watch,case}.ts`, `web/src/cards.ts`, `web/index.html` | Watch tab + cards |
| `watchlists/*.json` | seed AOIs (protected areas, O&G basins, controls) |
| `data/ledger.jsonl` | the ledger (committed on the `watch-data` branch, gitignored on main) |
| `.github/workflows/watch.yml` | scheduled sweep + Pages deploy |
| `test/{ledger,owid,detectors,watchlist}.test.ts` | offline tests |
| `TRUST.md`, `CONTRIBUTING.md`, `docs/*.md` | the contract + how to contribute |
| `VISION.md` §14, `ROADMAP.md`, `CONTINUITY.md`, `README.md` | ledgers |

## Testing

- `pnpm test` stays fully offline: every new client behind the `fetch` mock with fixtures
  (OWID CSV, Overpass JSON, Climate TRACE assets, S5P statistics, GFW alerts already exist).
- Ledger: write 3 rows → `verifyChain()` ok; edit row 2 on disk → chain fails at row 2;
  invalid transitions throw; missing evidence throws; `party` without `review.by` throws.
- Detectors: fixture tool outputs → expected candidate (and control fixtures → `null`).
- Runner: dry run against a 1-AOI watchlist with mocked tools produces exactly one case,
  a second run inside cooldown updates it instead of duplicating.
- Live (when keys/network exist): `earthdeck watch --once --watchlist watchlists/amazon.json`
  opens real cases from real GFW alerts; dashboard shows them in the Watch tab; export builds.

## Risks / edge cases

- **False accusations.** Mitigated by the trust contract: two-signal rule, human review to
  name, published false-positive rate, right of reply, control AOIs. This is the project's
  reputation; err toward *not* publishing.
- **Data-source uncertainty** (verify on first networked session): OWID grapher CSV URL
  shape; Climate TRACE asset endpoint + rate limits; UNEP MARS plume access; EOG Nightfire
  needs registration (fallback to FIRMS FRP at emitter locations); Overpass load (rate-limit
  ≤ 1 req/s, descriptive UA, cache boundaries in the watchlist).
- **Quotas.** GFW/FIRMS/CDSE per-key limits: the runner sleeps between AOIs, caps AOIs per
  sweep, and backs off on 429 (CLAUDE.md rule 5).
- **Surveillance drift.** Detectors are reviewed against "assets and institutions only";
  10 m data is non-identifying; no person-targeting tooling ever enters `src/watch`.
- **Ledger growth.** JSONL + index is fine to ~10⁵ rows; migrate to SQLite/Postgres when a
  hosted tier exists (VISION §7 H3). Keep the schema versioned (`v: 1`) now.
- **Goodhart / gaming.** Multiple independent signals per case; publish methodology.
- **Scope creep.** M1+M2 is the MVP. Don't start M3 tools before a real sweep has opened a
  real case end-to-end.

## Definition of done (MVP = M1 + M2)

- [ ] builds + typechecks; offline tests green; CI green
- [ ] `earthdeck watch --once` on the seed watchlist opens real cases into `data/ledger.jsonl`
- [ ] Watch tab shows cases with evidence + the world pulse; feeds served
- [ ] `verifyChain()` passes on the produced ledger
- [ ] CONTINUITY.md + PROGRESS.md + ROADMAP.md + VISION.md §14 updated

## Notes / log

- 2026-09-26: plan drafted from the accountability-loop brainstorm. Decisions: public first;
  methane/flaring wedge then EUDR; evidence-not-AI as the trust anchor; Option B (extend
  dashboard + JSONL + static export + Actions cron) for zero-cost 24/7.
