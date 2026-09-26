# earthdeck

**Give Claude eyes on Earth.** An [MCP](https://modelcontextprotocol.io) server plus a live
mission-control dashboard — **the data layer for the Earth system**, over free, open data.
Ask Claude to look at a place and it pulls satellite imagery, computes vegetation/water/burn
indices, surfaces live wildfires and disasters, and diffs a location across time to detect
deforestation, flooding, or burn scars. Ask it about the planet and it tracks El Niño,
ocean temperatures since 1981, CO₂ since 1958, the global temperature record since 1880,
polar sea ice, earthquakes, air quality, and per-place climate history since 1940 — with
trends, because the historic record is where the signal lives. As it works, a browser
dashboard lights up with what it's seeing.

> Claude is the brain; the dashboard is the canvas. The MCP best-effort streams every
> result to a local dashboard you watch live — but it works perfectly with the dashboard
> off too.

## Try it in 30 seconds (zero keys, zero config)

```bash
npx -y earthdeck demo
```

That's it. A dashboard opens in your browser and fills with the planet, live: CO₂, global
temperature, El Niño state, Arctic sea ice, this week's earthquakes, and every open natural
disaster — charts, markers, and a vital-signs grid on a satellite map. No account, no key,
no config file. (Needs Node ≥ 20.)

## Use it from Claude (one command)

```bash
claude mcp add earthdeck -- npx -y earthdeck
```

Then just ask: *"What's the state of the planet right now?"* · *"Is El Niño coming?"* ·
*"How has Berlin's climate changed since 1950?"* · *"Any big earthquakes this week?"*

## What it can do

| Tool | What it does | Needs |
| --- | --- | --- |
| `eo_snapshot` | Quick satellite image of a bbox (NASA Worldview/GIBS, MODIS/VIIRS) — true-color, false-color, or fire overlay | — |
| `events` | Live natural-disaster events worldwide (NASA EONET): wildfires, storms, volcanoes, floods | — |
| `geo_resolve` | Turn a place name into a bounding box (OpenStreetMap) | — |
| `stac_search` | Search open satellite archives (Sentinel-2/-1, Landsat) for scenes + COG asset URLs (Earth Search STAC) | — |
| `narrate` | Stream rich text notes/interpretations to the dashboard alongside the data — update one note in place as the story develops | — |
| `eo_similar` | "Find everywhere that looks like this": AlphaEarth 64-d embedding similarity over a search area (2017–2025, 10 m source) | — |
| `protected_areas` | Protected areas + Indigenous/community lands intersecting a bbox (or point + radius): name, designation, licence, id, approx. area, coarse (0.1°) centroid, and whether each contains the AOI centre. OSM Overpass (ODbL) + LandMark (CC BY-SA 4.0) and WDPA (IDs + stats only) when `GFW_API_KEY` is set. No geometry | — (LandMark/WDPA: `GFW_API_KEY`) |
| `emitters` | Emitting assets in a bbox (or point + radius) from Climate TRACE v7 (CC BY 4.0): name, sector, country, lat/lon, latest annual t CO2e + CH4, source id; plus area-wide aggregates for the municipalities touched. Optional sector filter | — |
| `fires_in` | Active fire / thermal-anomaly detections (NASA FIRMS), near-real-time | `FIRMS_MAP_KEY` |
| `flaring` | Gas flaring: night-time VIIRS heat clusters (~1 km) persisting across nights (NOAA-20/21 via FIRMS), matched to the EOG VIIRS Nightfire annual flare summary (per-site BCM, zero-key) | `FIRMS_MAP_KEY` |
| `forest_alerts` | Integrated deforestation alerts (GLAD-L + GLAD-S2 + RADD via Global Forest Watch) — daily, 10 m, tropics | `GFW_API_KEY` |
| `eo_render` | High-res (10 m) Sentinel-2 imagery — trueColor / falseColor / NDVI ramp; `composite: median` for a cloud-free temporal-median composite | CDSE |
| `sar_render` | All-weather Sentinel-1 SAR backscatter (sees through cloud/smoke/night) — VV / VH / false-color | CDSE |
| `sar_water` | All-weather water / flood extent from Sentinel-1 (water % of the AOI via low VV backscatter) | CDSE |
| `sar_flood` | Flood onset: SAR water extent before vs after an event, and the change (Δ water %) | CDSE |
| `methane_plumes` | Methane: Sentinel-5P CH₄ column anomaly (recent window vs ~90-day baseline, ppb + z + % valid) and NASA JPL EMIT plume complexes in the bbox (rate, location, link; public domain). UNEP MARS reported unavailable (no public API); Carbon Mapper link-only | CDSE (S5P part) |
| `eo_index` | NDVI / NDWI / NBR statistics over a least-cloudy or temporal-median Sentinel-2 composite | CDSE |
| `eo_search` | Search the Sentinel-2 archive for scenes + cloud cover | CDSE |
| `eo_compare` | Change detection: render two dates + the index delta (deforestation/flood/burn); `composite: median` suppresses residual-cloud noise | CDSE |

### Planetary indicators — the Earth system over time (all zero-key)

| Tool | What it does | History |
| --- | --- | --- |
| `planet_pulse` | The planet's vital signs in one call: CO₂, global temp, ENSO, sea ice, quakes, open disasters | now |
| `enso` | El Niño / La Niña tracking via NOAA's official Oceanic Niño Index, with phase + event rule | 1950→ |
| `ocean_temp` | Daily sea-surface temperature for any ocean point (NOAA OISST 0.25°), with °C/decade trend | 1981→ |
| `co2` | Atmospheric CO₂ at Mauna Loa (the Keeling curve) — latest, YoY growth, decadal trend | 1958→ |
| `global_temp` | NASA GISTEMP global temperature anomaly — latest, warmest years, warming rate | 1880→ |
| `sea_ice` | Arctic / Antarctic daily sea-ice extent (NSIDC) vs the 1981–2010 climatology | 1978→ |
| `quakes` | Recent earthquakes (USGS): magnitude, depth, tsunami flag, PAGER alert | real-time |
| `climate_history` | How a place's climate changed: ERA5 temperature/precip/wind, annual trend per decade | 1940→ |
| `air_quality` | PM2.5 / PM10 / O₃ / NO₂ / US AQI for any point (Copernicus CAMS), WHO-guideline flags | 48 h |
| `river_discharge` | Daily river flow at any point (GloFAS) — flood/drought signal vs the period mean | 1984→ |
| `earthdata_search` | Discover datasets across NASA's full Earth-science archive (~50k collections, CMR) by topic/bbox/time | catalog |
| `world_pulse` | Vital signs in three groups — civilization, life (Living Planet Index, Red List Index, fish stocks, protected areas, tree cover loss), planet (ocean pH, nitrogen, pesticides, water, plastic, ozone) — each improving/worsening/flat | per indicator |

### Life — biodiversity, species, reefs (all zero-key)

Everything that lives here matters on a global scale — animals, plants, and **fungi as a
first-class kingdom**, not an afterthought.

| Tool | What it does | Source |
| --- | --- | --- |
| `biodiversity` | What lives in a bbox/place: records by kingdom (Animalia, Plantae, **Fungi**, …), distinct and top species, IUCN-threatened species present, licence mix, recent records as map markers, and a 0–100 **score** with components + method | GBIF |
| `species` | Any animal, plant or fungus by scientific name: taxonomy breadcrumb (kingdom → species), common name, IUCN category, GBIF records worldwide / in a bbox, Open Tree of Life OTT id | GBIF + OpenTree |
| `coral_bleaching` | Reef heat stress at a point: Degree Heating Weeks, SST + anomaly, Bleaching Alert level, peak in the window, optional box stats | NOAA Coral Reef Watch |

The `biodiversity` score is deliberately small and explainable — 0.4·richness (log species)
+ 0.2·record density (log records/km²) + 0.2·share of IUCN CR/EN/VU records + 0.2·kingdom
evenness (Animalia/Plantae/Fungi/other). It is **sampling-effort dependent**: GBIF records
cluster near roads, cities and birders, and fungi/insects are under-recorded — so it tells
you how well-documented and conservation-relevant a place is, not how healthy it is. Every
result carries the full `method` block with its blind spots. For global *trends*, use
`world_pulse` (Living Planet Index −73 % since 1970; Red List Index falling).

### Valuing living nature

| Tool | What it does | Source |
| --- | --- | --- |
| `natural_value` | What a bbox/place's living ecosystems are worth per year **alive** (low/mid/high, 2020 USD), over a horizon (undiscounted + NPV, default 100 yr @ 2 %), by biome and by service, from its measured land-cover mix; plus reference values for a great whale, a forest elephant and a tree | Costanza et al. 2014 / de Groot et al. 2012 unit values · CLMS 10 m land cover 2020 via CDSE (optional; else a stated assumption) |

The financial system prices nature once it is dead — timber, gold, pasture. `natural_value`
puts a number on the work it does while it is alive: regulating climate and water, holding
soil, feeding people, sheltering species. Read the number plainly:

- **Order of magnitude, not a price.** It is *benefit transfer*: global per-biome average
  values (USD/ha/yr) applied to this place without local calibration. The true local value
  can be several times higher or lower; the band says so.
- **Shown so that "alive" has a number next to "cleared"** — so a forest-loss finding can say
  what the lost hectares were doing, and a mine can be weighed against the people downstream.
  It is not a price tag for sale, and nobody will pay it for the land.
- **A floor for one kind of value.** Sacred, relational and intrinsic values (IPBES 2022) and
  who actually benefits vs. who pays are not in the dollar column; every result lists these
  blind spots. Forest-loss findings in the ledger carry the same figure as `living_value_*`
  evidence values and a context note. Research and every number's source:
  [`docs/research/2026-09-26_valuing-living-nature.md`](docs/research/2026-09-26_valuing-living-nature.md).

The Earth is one interconnected system — and these tools are built to be cross-referenced:
ENSO ↔ fires, floods and SST anomalies; river discharge ↔ SAR flood mapping; climate trends
↔ what the imagery shows on the ground.

Every Copernicus result (`eo_render`/`eo_index`/`eo_compare`) carries a **provenance block**
— data source, sensor, composite window, cloud-mask method + masked classes, % valid pixels,
contributing scene IDs — so the output is decision-support you can audit, not a bare number.
Every indicator result names its source and carries the series, so claims are checkable.

The zero-key tools (`eo_snapshot`, `events`, `geo_resolve`, `stac_search`, all the
planetary-indicator tools and the life tools) work with no setup at all.

## Earth Watch — the public accountability ledger (new, M1)

earthdeck is growing from a monitoring toolkit into a **standing, public, evidence-first
watch on the planet** (plan: [`.plans/2026-09-26_earth-watch.md`](.plans/2026-09-26_earth-watch.md),
research: [`docs/research/`](docs/research/)). The loop is
**detect → verify → attribute → route → track the response**, and the memory of that loop
is a ledger anyone can verify:

- **Event-sourced findings** as in-toto Statements in DSSE envelopes (RFC 8785 canonical
  JSON), in an **RFC 6962 Merkle log** with the C2SP `tlog-tiles` static layout and
  Ed25519 **signed checkpoints**. `earthdeck ledger verify` re-derives everything and
  catches edits, deletions, reordering and forged entries. Zero new dependencies.
- **The trust contract is code** (`src/ledger/schema.ts`; plain language: [TRUST.md](TRUST.md)):
  no finding without evidence; a candidate is *confirmed* only by an **independent second
  signal** (never an LLM judge); **publishing is autonomous and verified afterwards**
  (policy `2026-09-26-autonomous`): a narration plus a *publish* verdict from a **different
  identity** than the narrator, tier ≤ 2 (tier 3 needs a human), with the gates recorded
  on the publish event and re-checked by the ledger; **two distinct reviewers and a 72 h
  private notice to name a party**; a 30-day public right-of-reply clock; retractions and
  false positives are kept forever as our published error rate; subjects are assets,
  places and institutions — never people.
- **`world_pulse`** (tool #27, zero-key): civilization's vital signs from Our World in
  Data, each with an honest *improving / worsening / flat* direction and pace — good news
  and bad, not a news feed.
- **Dashboard → Watch tab**: case list, case page (evidence, timeline, response, verify
  links); `GET /feed.json`, `/feed.geojson` (public cases), `/ledger/checkpoint`,
  `/ledger/pub`, `/ledger/entries.jsonl`, `/ledger/tile/*`.

```bash
earthdeck watch --once     # sweep watchlists/*.json with the real tools → findings in the ledger
earthdeck watch --once --dry-run   # what would happen, writes nothing (works with zero keys: skips)
earthdeck ledger seed      # demo cases into an empty ledger (data/ledger by default)
earthdeck ledger verify    # ✓ OK — every entry is signed, canonical, rule-abiding…
earthdeck ledger show      # list cases; `show <id>` prints events
earthdeck dashboard        # → open the Watch tab
```

**The sweep (M2)** — `src/watch/`: a deterministic **Watch Kernel** (no LLM) runs every
AOI × rule in `watchlists/*.json`, journals every tool call, opens a *candidate* with the
primary signal, and marks it *confirmed* only when the rule's **independent second signal**
agrees (`forest_loss`: GFW alerts → NDVI drop in a Sentinel-2 median composite;
`fires_in_protected`: VIIRS cluster → EONET event or re-detection on a later pass;
`flaring`: night-time heat persisting ≥ N nights → a VNF annual flare site or a later pass).
`methane_anomaly` (tier 2): Sentinel-5P CH₄ anomaly vs 90 days → EMIT plume in the AOI).
Every rule must declare its **blind spots** and keeps a **regional baseline** (the AOI vs
its neighbourhood ring — "did it stop, or did it move?"); every finding carries **context**
(ENSO phase, nearby EONET events). Watermarks make late or missed runs self-heal; failures
are recorded as coverage gaps, never silence. **Control AOIs** (expected quiet) measure our
own false-positive rate. Needs `GFW_API_KEY` + CDSE creds (forest) and `FIRMS_MAP_KEY`
(fires); pairs whose keys are missing are skipped, not failed.

**Triage from Claude** — `ledger_list`, `ledger_get`, `ledger_verify` (read) and
`ledger_advance`, `ledger_narrate`, `ledger_review`, `ledger_propose_attribution` (append)
expose the ledger over MCP. Every write goes through the trust contract, which alone
decides: `ledger_advance` publishes when the gates hold (it computes `gates` via
`publishGates` if the model omits them) and retracts with a reason; `ledger_review` records
a `publish | hold | reject` verdict; naming a party still needs tier ≥ 2, two distinct
reviewer identities and the private-notice clock.
`earthdeck doctor` has a **Watch** section (ledger verify, each rule's keys, watchlists,
generated watchlists and their age, last sweep heartbeat).

**Discovery: watchlists from data** — `earthdeck discover --out watchlists/generated
[--max-per-list N] [--only a,b] [--budget 200]` (`src/watch/discover/`) writes five
watchlists plus `_summary.json` (counts, sources, dataset versions, request count). One
run is ~19 requests and under a minute (no CDSE, no FIRMS); it needs `GFW_API_KEY`.

| File | Source (open data) | Default N | What becomes an AOI | Rules |
| --- | --- | --- | --- | --- |
| `forest-hotspots.json` | GFW `gadm__integrated_alerts__adm2_daily_alerts` (high+ confidence, primary forest, last 30 days) + GADM 4.1 boxes | 150 districts | GADM level-2 box, tiled to ≤ 4 deg² / ≤ 2° a side (`<iso>-<adm1>-<adm2>-<i>`) | `forest_loss`, `minHa = max(25, ⌈100 ha/deg² × tile⌉)`, `minAlerts = 10 × minHa`, 90 d |
| `flaring-fields.json` | EOG VIIRS Nightfire annual flare sites (~14k) | 60 fields | sites chained within 15 km, box + 10 km, ≤ 25 deg² | `flaring`, 30 d, `minNights` 5 |
| `methane-basins.json` | Climate TRACE v7 oil & gas CH₄ (production, refining, transport) | 40 basins | sources chained within 50 km, box + ~0.5°, ≤ 2° a side | `methane_anomaly` (defaults) |
| `protected-fires.json` | WDPA via GFW (IDs/stats only) + GFW alerts per protected area | 80 areas | tropical areas > 2,000 km² with primary forest, IUCN Ia–IV first, tiled ≤ 4 deg² | `fires_in_protected` + `forest_loss` (60 d, `minHa = max(5, ⌈40 ha/deg² × tile⌉)`), cooldown 14 d |
| `controls-generated.json` | Intact Forest Landscapes 2020 via GFW | 20 cores | ≤ 0.5° box on each IFL's deepest interior point (maximum inscribed circle), clear of hotspot tiles | `controls.json` thresholds, `control: true` |

Why the thresholds look like that: a São Félix-level frontier runs ≈ 930 ha/deg² per 90 days
and the control cores' noise is ≈ 60–76 ha/deg² — `100 ha/deg²` is the controls' 25 ha /
0.25 deg² floor scaled to the tile, so the bar depends only on geometry and does not move
between runs. Ids come from dataset ids (GADM, VNF site position, Climate TRACE source id,
WDPA site id, IFL id), so watermarks and cooldowns persist across re-runs; output is
byte-identical for the same data. Choices and their costs: the forest ranking counts only
primary-forest alerts (otherwise Sahel dryland alerts top the list; secondary forest and
cerrado frontiers rank lower); `protected-or-indigenous` marks districts with ≥ 25 % of
their alerts in IUCN Ia/Ib/II areas or LandMark lands; Climate TRACE places basin-level
estimates at a basin centroid, so a methane box is a window around that point; national
"OtherBasins" residuals and offshore basins are dropped. Sweep with
`earthdeck watch --once --watchlist watchlists/generated` (`--max` caps pairs; lists are in
rank order). Re-run weekly — `doctor` flags output older than 14 days.

**Analyst (autonomous publishing)** — `src/analyst/`: `earthdeck analyst --once` takes
confirmed findings (newest first, `--max` default 5) through three steps, each journaled
(`analyst_*` in `<ledger>/watch/journal.jsonl`, with token usage and a cost estimate per call):

1. **Narrate** (default `claude-opus-5`): the full finding — evidence with values, the
   confirming signal, baseline ring, ENSO, nearby events, blind spots, AOI tags incl.
   `control` — in; strict JSON out (`headline`, plain-language `narrative`, `keyNumbers`
   citing evidence ids, `confidence`, `caveats`). A **faithfulness check** rejects any key
   number that is not verbatim in its cited evidence, any other number not in the finding,
   and anything that looks like a person's name — then retries once, quoting the violation.
2. **Review** by a *different* model (default `claude-sonnet-5`): `publish | hold | reject`
   plus checks. Deterministic overrides: control AOI ⇒ reject, an identifiable individual
   ⇒ hold, `publish` contradicting its own checks ⇒ hold.
3. **Append**: `narrated` → `reviewed` → on publish (tier ≤ 2, gates pass)
   `status_changed confirmed → published` with `gates`; hold stays `confirmed` for a human;
   reject → `false_positive`. Tier 3 is never auto-published.

```bash
ANTHROPIC_API_KEY=… earthdeck analyst --once              # narrate + review + publish
earthdeck analyst --once --dry-run --max 2                # one narration call per finding, nothing appended
earthdeck analyst --once --model-narrator claude-opus-5 --model-reviewer claude-sonnet-5
```

Rough cost: ~$0.10–0.25 per finding (Opus narration + Sonnet review; a faithfulness retry
adds one narration). The API is called with native `fetch` (no SDK dependency);
`ANTHROPIC_BASE_URL` overrides the endpoint.

**The contract as JSON Schema** — [`schema/finding-event.v1.json`](schema/finding-event.v1.json)
(JSON Schema 2020-12: the event, the in-toto Statement and the DSSE Envelope), generated
from the zod schemas with `pnpm schema`; a test fails if it drifts. It covers each event's
shape; the state rules (transitions, reviewers, publishability) live in `checkAppend`.

Env: `EARTHDECK_LEDGER_DIR` (default `data/ledger`), `EARTHDECK_LEDGER_KEY` (base64
Ed25519 seed; otherwise `ledger.key` is generated — **never commit it**; `ledger.pub` is
what you publish). Next: attribution + methane tools (M3), a scheduled public site with
Rekor/OpenTimestamps witnessing (M4), TRUST.md (M5).

## Hosting

Earth Watch runs unattended on AWS from one CloudFormation stack: EventBridge Scheduler
fires staggered sweeps every 6 h into a Lambda that pulls the ledger from S3, runs
`earthdeck watch --once`, and pushes it back only after `ledger verify` passes; the static
export is served by CloudFront. Deploy with `scripts/deploy.sh` — see
[infra/README.md](infra/README.md) for the architecture, first-deploy walkthrough, costs
(low single-digit USD/month), key rotation and tear-down.

## Setup details

Want the dashboard alongside Claude? Run `npx -y earthdeck dashboard`
in a second terminal and watch the map light up as Claude works (it's optional — tools
behave identically without it).

<details>
<summary>Claude Desktop / other MCP clients (JSON config)</summary>

```json
{
  "mcpServers": {
    "earthdeck": {
      "command": "npx",
      "args": ["-y", "earthdeck"]
    }
  }
}
```

</details>

## Unlock the satellite tools (2 free keys, ~5 minutes)

17 of the 26 tools need nothing. The rest want free credentials:

| Key | Unlocks | How to get it |
| --- | --- | --- |
| `FIRMS_MAP_KEY` | `fires_in` (live wildfire detections), `flaring` | Enter your email at [firms.modaps.eosdis.nasa.gov/api/map_key](https://firms.modaps.eosdis.nasa.gov/api/map_key/) — emailed instantly |
| `CDSE_CLIENT_ID` + `CDSE_CLIENT_SECRET` | `eo_render`, `eo_index`, `eo_search`, `eo_compare`, `sar_render`, `sar_water`, `sar_flood`, `methane_plumes`, `natural_value` land-cover mix (optional) (10 m Sentinel imagery + radar, Sentinel-5P CH₄) | Free account at [dataspace.copernicus.eu](https://dataspace.copernicus.eu/) → User Settings → **OAuth clients** → Create (copy the secret immediately — it's shown once) |
| `GFW_API_KEY` | `forest_alerts` (integrated deforestation alerts) | Free [GFW account](https://www.globalforestwatch.org/), then mint a key per the [API-key guide](https://www.globalforestwatch.org/help/developers/guides/create-and-use-an-api-key/) |

Pass them where your MCP client expects env vars, e.g.:

```bash
claude mcp add earthdeck -e FIRMS_MAP_KEY=xxx -e CDSE_CLIENT_ID=xxx -e CDSE_CLIENT_SECRET=xxx \
  -- npx -y earthdeck
```

Then verify everything in one shot:

```bash
npx -y earthdeck doctor
```

```
  Zero-key data sources: ✓ ✓ ✓ ✓ ✓ ✓ ✓ ✓ ✓
  Optional keys:
    ✓ Copernicus CDSE   OAuth token OK
    ✓ NASA FIRMS        key valid (0/5000 transactions used)
  All zero-key sources reachable — 26/26 tools ready to use.
```

`doctor` checks every upstream source and tells you exactly what's ready and what's missing
(with the link to fix it). See [.env.example](.env.example) for all variables.

### Goes well with: NASA's Earthdata MCP

earthdeck's `earthdata_search` discovers datasets across NASA's catalog; for granule-level
file search, variables, and citations, NASA hosts its own MCP server over the same catalog —
the two compose nicely (NASA's finds the files, earthdeck analyzes the world):

```bash
claude mcp add --transport http earthdata https://cmr.earthdata.nasa.gov/mcp/v1
```

## The dashboard

Each tool posts a "card" — imagery overlays and NDVI/index panels render on a MapLibre map
(NASA Blue Marble basemap), events/fires/earthquakes plot as markers, time-series tools draw
charts (the Keeling curve, ONI, sea-ice vs climatology…), `planet_pulse` shows a vital-signs
grid, and `eo_compare` shows a before/after pair with the delta. The push is best-effort: if
the dashboard isn't running, tools behave exactly the same.

## Example sessions

> **You:** What's the NDVI around Manaus, and how has the forest changed since 2019?

Claude calls `geo_resolve("Manaus, Brazil")` → bbox, then `eo_index(bbox, "NDVI")` →
mean ≈ 0.28, then `eo_compare(bbox, "2019-08-01", "2026-06-01", "NDVI")` → renders both
dates and reports the NDVI delta. Meanwhile the dashboard shows the imagery, the index
panel, and the before/after comparison.

> **You:** Is the Rio Negro flooding right now?

Claude calls `river_discharge(-3.1, -60)` → latest flow 2.5× the 2-year mean (rising-water
season), then confirms from orbit with `sar_flood` → water extent +2 pts since April. Two
independent instruments, one answer — that's the point of having the whole Earth system in
one toolbox.

> **You:** What's the state of the planet?

One `planet_pulse` call: CO₂ 432 ppm (+1.8 YoY), global anomaly +1.12 °C, ENSO neutral,
both poles' sea ice below the 10th percentile, 70 quakes M5+ this week, 200 open disasters
— each with its source named.

## Develop

```bash
pnpm install
pnpm build            # tsc (server -> dist/) + vite build (web -> dist/web/)
pnpm typecheck
pnpm test             # offline test suite (node:test) — no network or API keys needed
pnpm dev              # MCP server on stdio (from source)
pnpm dev:dashboard    # dashboard server (from source)
pnpm dev:web          # vite dev server for the dashboard UI
```

Tests mock the network, so the whole suite runs with zero credentials — CI
(`.github/workflows/ci.yml`) runs typecheck + test + build on every push.

## Data sources & attribution

- NASA EOSDIS GIBS / Worldview, FIRMS, EONET, GISTEMP (NASA open data).
- Copernicus Sentinel-1/-2 via the Copernicus Data Space Ecosystem (ESA / European Union);
  Copernicus CAMS air quality and ERA5 / GloFAS via [Open-Meteo](https://open-meteo.com/) (CC-BY 4.0).
- NOAA: CPC Oceanic Niño Index, GML Mauna Loa CO₂, OISST via CoastWatch ERDDAP.
- NSIDC Sea Ice Index (G02135) · USGS Earthquake Hazards Program.
- [GBIF.org](https://www.gbif.org/) occurrence data (per-dataset CC0 1.0 / CC BY 4.0 / CC BY-NC 4.0 —
  the `biodiversity` result reports the licence mix) · IUCN Red List categories as mirrored by GBIF ·
  [Open Tree of Life](https://tree.opentreeoflife.org/) taxonomy (CC0).
- NOAA Coral Reef Watch CoralTemp v3.1 5 km products via CoastWatch / PacIOOS ERDDAP (free; credit NOAA CRW).
- Our World in Data (CC BY 4.0) for `world_pulse`; upstream producers and licences are listed per indicator.
- `natural_value`: CLMS Global Land Cover 2020, 10 m (© European Union, Copernicus Land Monitoring Service; DOI 10.2909/602507b2-96c7-47bb-b79d-7ba25e97d0a9; free and open, attribute and state modifications); ecosystem-service unit values from Costanza et al. (2014) and de Groot et al. (2012), organism values from Chami et al. (IMF) — cited per entry in the result.
- Basemap & geocoding: NASA Blue Marble; OpenStreetMap Nominatim.
- Attribution: protected areas © OpenStreetMap contributors (ODbL) via Overpass; LandMark
  Indigenous & community lands (CC BY-SA 4.0) via the GFW Data API; emissions from
  [Climate TRACE](https://climatetrace.org/) (CC BY 4.0), API pinned to `/v7`
  (`EARTHDECK_CLIMATETRACE_BASE`; Overpass mirror: `EARTHDECK_OVERPASS_URL`). WDPA /
  Protected Planet (UNEP-WCMC & IUCN) via the GFW Data API: IDs + intersection stats only,
  never geometry.

## Notes

This wraps documented, public, open APIs and is scoped to your own (free) credentials. It is
**observation only** — there is no satellite tasking or control here. Respect each provider's
terms and rate limits (Copernicus processing-unit quotas, FIRMS transaction limits,
Nominatim ≤1 req/s).

## License

MIT — see [LICENSE](LICENSE).
