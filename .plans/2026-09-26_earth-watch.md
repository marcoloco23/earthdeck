# Plan: Earth Watch — the public accountability loop

**Date**: 2026-09-26 (rev. 2 — rewritten after the architecture research)
**Status**: IN PROGRESS (M1)
**Phase**: Horizon 3 (the Watchdog), pulled forward as a public-good MVP. See VISION.md §14.
**Research**: [`docs/research/2026-09-26_earth-watch-architecture.md`](../docs/research/2026-09-26_earth-watch-architecture.md)
— the ten-year architecture this plan implements. Read it for the *why*; this file is the *what*.

## Goal

Turn earthdeck from a *monitoring toolkit* into a **standing, public, evidence-first watch
on the planet**: an agent that sweeps the Earth around the clock with the tools we already
have, writes every finding to an **independently verifiable** public ledger with its
evidence, tracks whether anything happened about it, and publishes an honest "how are we
doing" pulse — good news and bad — that anyone can read and anyone can check.

The one-line product: **"Here is what changed on Earth, here is the proof, here is who was
told, and here is whether it was fixed."**

## The one-line architecture

> **The repo is the platform, static open-format files are the product, and the LLM is a
> step inside a deterministic state machine — never the thing that decides.**

Every format is an IETF / OGC / Apache / C2SP standard, so servers, schedulers, LLM vendors
and even our own Node code are replaceable around a self-describing corpus of files. Runs
for $0–5/month.

## Strategy decisions (unchanged from rev. 1)

- **Public first, leverage second, same ledger.** The public is the trust we're building;
  journalists, NGOs and leverage-holders (EUDR buyers, lenders, regulators) consume the same
  ledger via machine-readable feeds. One product, two doors, nothing paywalled.
- **Wedge order:** methane & flaring → deforestation / EUDR (30 Dec 2026) → fishing, mining, water.
- **Trust rests on checkable evidence, not on the AI.** Subjects are assets, places and
  institutions — never individuals.

## The trust contract (schema-enforced, learned from MARS / GFW / Carbon Mapper / Berkeley Protocol)

1. **No finding without evidence.** Every `created` event carries `evidence[]` (scene IDs,
   acquisition times, method `{name, version, params}`, digests of derived rasters).
2. **Confidence = number of independent detectors.** A candidate becomes `confirmed` only
   when a *second independent signal* (different sensor physics, different provider, or a
   later revisit) agrees — decided by the deterministic layer, never an LLM judge.
   Unconfirmed candidates **expire** (default 180 days, GLAD's rule).
3. **Tiers of consequence.** Tier 0 (auto: candidate/confirmed/expired) · Tier 1 (one
   reviewer: publish a place-level finding) · Tier 2 (**two distinct reviewers, neither the
   trigger**: name a party) · Tier 3 (right-of-reply timer before a named finding goes public).
4. **Two clocks.** 72 h private notice to the responsible party / authority, 30-day public
   release with any reply embedded verbatim. "No response" is a public state.
5. **Nothing is deleted.** `retracted` and `false_positive` are events, kept forever, and
   are our published error rate.
6. **Name assets, places and institutions; owners only via cited registries** (Climate
   TRACE / GEM ownership, stake threshold); never natural persons. Geometry on Indigenous
   lands is aggregated/delayed (community monitors have been killed acting on alerts).
7. **Independently verifiable.** The ledger is an RFC 6962 Merkle log (C2SP tlog-tiles
   layout) with Ed25519-signed checkpoints; checkpoints are witnessed externally (Sigstore
   Rekor via Actions OIDC, OpenTimestamps). `earthdeck ledger verify` re-derives everything.
8. **AI disclosure.** Narrations carry model id, prompt hash, transcript hash and the
   reviewer; every published finding carries the "AI-drafted, human-reviewed" marker (EU AI
   Act Art. 50, from 2 Aug 2026).

## Architecture

```
 watchlists/*.json ──► Watch Kernel  (src/watch/, pure TS, no LLM in core)
   AOIs × rules            │ sweep: watermark-driven catch-up (never "now − N h")
                           │ rules declare their required 2nd signal; thresholds pre-registered
                           │ journal: sweeps · steps(input_hash) · tool_calls · candidates · heartbeats
                           ▼
              candidate ──2nd signal agrees──► confirmed ──review──► published ──notify──► …
                           │                                   ▲
                           │            LlmStep adapter (narrate ONLY; Ajv-validated; evidence_refs
                           │            must resolve to journaled tool calls; numeric-faithfulness check)
                           ▼
 Ledger (src/ledger/) — event-sourced, append-only
   entries.jsonl   one DSSE envelope per line; payload = JCS (RFC 8785) in-toto Statement
   tile/…          RFC 6962 Merkle tree in C2SP tlog-tiles layout (static files)
   checkpoint      C2SP signed note, Ed25519 (+ Rekor / OpenTimestamps anchors in M4)
   findings = fold(events by findingId)  → materialised view, rebuildable, never authoritative
                           │
   Dashboard (src/dashboard/server.ts) — local mission control + review queue
     GET /api/ledger  /api/ledger/:id  /feed.json  /feed.geojson  /ledger/checkpoint  /ledger/tile/*
     cards: finding · worldpulse
   Static export → site shell on Pages, data (GeoParquet/PMTiles) on R2 — M4
```

### Data model (v1 predicate `https://earthdeck.dev/finding-event/v1`)

- Event kinds: `created` · `evidence_added` · `confirmed` · `status_changed` ·
  `attributed` · `narrated` · `reviewed` · `notified` · `replied` · `retracted`.
- Status (projection): `candidate → confirmed → published → notified → (replied|no_response)
  → resolved | ignored`; side exits `expired`, `false_positive`, `retracted`.
- Ids: UUIDv7 (RFC 9562). Times: RFC 3339 `Z`. Geometry: GeoJSON (RFC 7946). Evidence
  refs: STAC-Item-shaped `{id, collection, datetime, href?}` + method `{name, version, params}`.
- Each event carries `prev` (hash of the previous event of the same finding) for cheap
  fork detection, plus `actor` (`system:<rule@ver>` | `reviewer:<handle>` | `model:<id>`).
- Envelope: DSSE `{payloadType: "application/vnd.in-toto+json", payload, signatures[]}`;
  Statement `{_type: in-toto v1, subject: [{name: findingId, digest}], predicateType, predicate}`.
- JSON Schema 2020-12 published in `schema/`; zod at runtime. v2 is added beside v1, never in place.

### Ledger integrity

- Leaf = `sha256(0x00 ‖ envelopeBytes)`; node = `sha256(0x01 ‖ L ‖ R)` (RFC 6962).
- Tiles: `tile/<L>/<N>` (256 hashes, partial suffix `.p/<W>`), `tile/entries/<N>`.
- Checkpoint: `earthdeck.dev/findings/v1\n<size>\n<base64 root>\n\n— earthdeck <base64 sig>\n`.
  Never sign a checkpoint inconsistent with a previous one (consistency proof checked on
  every append). Unknown signatures are ignored (key rotation + witness cosigning).
- `verify`: rebuild the tree from `entries.jsonl`, compare to `checkpoint`, verify the
  signature, verify consistency against a previously seen checkpoint, verify each finding's
  `prev` chain, validate every payload against the schema.
- Zero new runtime deps: `node:crypto` (SHA-256, Ed25519), a vendored ~100-line RFC 8785
  canonicalizer tested against the RFC vectors. `@sigstore/sign` (Rekor) + OpenTimestamps
  are M4, in the Actions workflow, not in the server.

### Watch Kernel rules (M2+)

| Rule | Primary detector | Required 2nd signal | Tier |
| --- | --- | --- | --- |
| `forest_loss@1` | GFW integrated alerts (high+) ≥ threshold ha | NDVI drop via `eo_compare` (median composite) | 1 |
| `fires_in_protected@1` | FIRMS cluster inside a protected-area / LandMark polygon | NBR burn index or a later FIRMS pass | 1 |
| `methane_anomaly@1` | S5P CH₄ column anomaly vs 90-day window (CDSE Statistics) | Climate TRACE / GEM asset at the point **or** EMIT/MARS plume | 2 |
| `flaring@1` | FIRMS high-FRP persistence at a known O&G asset | VNF monthly aggregate (redistributable) | 2 |

### Scheduling (M4)

GitHub Actions cron is best-effort (hours late / skipped in 2026; auto-disables after 60
idle days). Therefore: watermark-driven catch-up, results keyed `(aoi, source, obs_time)`
so re-runs upsert, dedicated workflow with `workflow_dispatch` + `concurrency` + keepalive,
heartbeat row per sweep, external watchdog on `now − last_sweep > 2× period`. v2 = Temporal
single-binary (SQLite) on a $2–5/month box.

### Data-source rules baked in

- `protected_areas`: OSM `boundary=protected_area` (ODbL, kept as a separate table) +
  LandMark (CC BY). WDPA: **IDs and intersection stats only**, never geometry.
- `flaring`: VNF **monthly/annual aggregates only** (nightly not redistributable). Drop
  `VIIRS_SNPP_NRT` before 1 Nov 2026; default NOAA-20/21.
- `methane_plumes`: S5P via CDSE + EMIT plume GeoJSON (public domain) + UNEP MARS
  (30-day embargo). Carbon Mapper: link only (NC + revocable).
- `emitters`: Climate TRACE `/v7` pinned in config; GEM ownership as versioned static files.
- `world_pulse`: OWID grapher CSV + World Bank v2 + UN SDG + UNHCR + UCDP; per-indicator
  upstream licence recorded; every series snapshotted locally with licence metadata.
- **US federal sources are the durability risk** → every source has a configured substitute.

## Milestones

**M1 — Memory + pulse** (zero-key, fully offline-testable) ← *current*
- `src/ledger/jcs.ts` (RFC 8785) · `merkle.ts` (RFC 6962 + tlog-tiles) · `checkpoint.ts`
  (signed note, Ed25519) · `schema.ts` (events, statement, envelope, status machine, tiers)
  · `store.ts` (append, fold, query, verify) · tests incl. tampering + RFC vectors
- Dashboard: `/api/ledger*`, `/feed.json`, `/feed.geojson`, `/ledger/checkpoint`,
  `/ledger/tile/*`; `finding` + `worldpulse` card types; **Watch** tab
- `world_pulse` tool + `src/clients/owid.ts` registry (`betterWhen`, direction, acceleration)
- `earthdeck ledger verify|show` CLI

**M2 — The sweep** (`earthdeck watch --once`)
- watchlists + seed lists (incl. control AOIs) · kernel (journal, watermarks, `finding_key`
  UNIQUE, cooldown) · rules `forest_loss`, `fires_in_protected` · CLI + doctor + README

**M3 — Attribution + methane wedge**
- `protected_areas`, `emitters`, `methane_plumes`, `flaring` tools; rules `methane_anomaly`,
  `flaring`; `ledger_*` MCP tools (read / propose / advance — never publish a name)

**M4 — Public + around the clock**
- static export (site shell on Pages, GeoParquet + PMTiles on R2, DuckDB-WASM) ·
  scheduled Actions (watermarks, keepalive, watchdog) · Rekor + OpenTimestamps anchors ·
  `LlmStep` (Claude Code headless first; Ajv + faithfulness check) · two-clock notify/reply

**M5 — Open it up**
- `TRUST.md` (the contract above), `CONTRIBUTING.md`, `docs/{detectors,watchlists}.md`,
  system card, published per-detector error rate, issue templates (false positive / right of reply)

MVP = M1 + M2. Don't start M3 before one real sweep has opened one real case end-to-end.

## Implementation steps

- [ ] M1 `jcs.ts` + RFC 8785 vectors
- [ ] M1 `merkle.ts` (leaf/node hashing, root, inclusion + consistency proofs, tiles) + vectors
- [ ] M1 `checkpoint.ts` (signed note format, Ed25519 sign/verify, key load/generate)
- [ ] M1 `schema.ts` (zod events + envelope, transitions, tiers) + `schema/finding-event.v1.json`
- [ ] M1 `store.ts` (JSONL append, fold → findings, query, verify) + tampering tests
- [ ] M1 dashboard endpoints + feeds + card types
- [ ] M1 `world_pulse` + OWID client + fixtures
- [ ] M1 Watch tab (cases list, case page, pulse grid)
- [ ] M1 `earthdeck ledger verify|show`
- [ ] M2 … (see milestones)

## Files to create / modify

| File | Change |
| --- | --- |
| `src/ledger/{jcs,merkle,checkpoint,schema,store}.ts` | the ledger |
| `schema/finding-event.v1.json` | JSON Schema 2020-12 contract |
| `src/clients/owid.ts`, `src/tools/worldpulse.ts` | world pulse |
| `src/dashboard/server.ts`, `src/types.ts` | endpoints, feeds, card types |
| `web/src/{watch,cards,main}.ts`, `web/index.html`, `web/src/styles.css` | Watch tab |
| `src/cli.ts`, `src/config.ts` | `ledger` subcommand; `EARTHDECK_LEDGER_DIR`, `EARTHDECK_LEDGER_KEY` |
| `test/{jcs,merkle,checkpoint,ledger,owid}.test.ts` | offline tests |
| M2+: `src/watch/**`, `watchlists/*.json`, `src/tools/{attribution,methane,ledger}.ts`, `.github/workflows/watch.yml`, `TRUST.md` | later milestones |

## Testing

- Offline: RFC 8785 test vectors; RFC 6962 vectors (empty tree, sizes 1–8 roots, inclusion
  + consistency proofs from Go `sumdb/tlog` examples); checkpoint round-trip + bad
  signature; store: append 3 → verify ok; edit line 2 on disk → verify fails at leaf 1;
  invalid transition throws; missing evidence throws; `attributed` with a party and < 2
  reviewers throws; same reviewer twice throws; OWID CSV parse + direction/acceleration.
- Live (when network): `world_pulse` against OWID; dashboard Watch tab renders seeded cases.

## Risks / edge cases

- False accusations — the trust contract; err toward *not* publishing.
- Verify-live items from the research: CDSE quotas, MARS API, Climate TRACE auth, GFW
  tiers, OWID rate limits, Protected Planet API version, Armored Witness onboarding.
- Ledger growth: one tree; shard by year (`…/findings/2027`) only if it gets unwieldy.
- Node ≥ 20: no `node:sqlite`; journal is files + in-memory index until v2 (Temporal/SQLite).

## Definition of done (M1)

- [ ] builds + typechecks; offline tests green; CI green
- [ ] `earthdeck ledger verify` passes on a seeded ledger and fails on a tampered one
- [ ] Watch tab shows cases with evidence + the world pulse; feeds + checkpoint + tiles served
- [ ] CONTINUITY.md + PROGRESS.md + ROADMAP.md updated

## Notes / log

- 2026-09-26: rev. 1 drafted from the brainstorm (hash-chained JSONL, "every 6 h" cron).
- 2026-09-26: rev. 2 after the five-stream architecture research. Seven changes: witnessed
  Merkle log instead of hash chain; event-sourced findings + new states + four-eyes naming;
  watermark scheduling; R2/Parquet/PMTiles publishing; analyst narrates but never confirms;
  data-source licence rules; Art. 50 disclosure + two-clock TRUST.md. M1 started.
