# VISION — earthdeck → the open AI Earth-observation analyst

> **Status:** north-star + multi-year roadmap (drafted 2026-06-05). This is the strategic
> plan we iterate against over the next 1–2 years and steer by over ~5. The near-term,
> tactical tracker lives in [ROADMAP.md](ROADMAP.md); this file is the *why* and the *where to*.
> It's grounded in a four-stream research sweep (data sources, market/users, AI/ML & architecture,
> product strategy) — sources at the bottom.

---

## 0. One line

**Build the open, agentic, free-first analyst for Earth — the tool that turns "what changed
at this place, and is it real?" into a cited, defensible answer — and let the accumulated
record of those answers become the moat.**

Today `earthdeck` is a capable demo: 8 tools that fetch imagery, indices, fires, events,
and a 2-date change comparison, streamed to a live dashboard. That's the *doorway*. The
product is the **analyst and the monitoring system of record** behind it.

---

## 1. Why now — the structural gap

Three layers exist today and **don't connect for non-experts**:

1. **The data is free / open.** Sentinel-1/2/3, Landsat, Sentinel-5P, Copernicus DEM,
   Global Forest Watch, Climate TRACE, Global Fishing Watch — all open. Commercial pixels
   (Planet, Maxar, ICEYE, Umbra) are increasingly reachable via one key (e.g. SkyFi's MCP).
2. **The models are open.** Clay, Prithvi/TerraMind, Satlas, and — pivotally — Google's
   **AlphaEarth "Satellite Embedding"** dataset: planet-wide, 10 m, 64-dim/pixel, 2017→2024+,
   **CC-BY 4.0** (commercially usable). The "AI" is a download, not a moat.
3. **The useful apps are closed and siloed.** Kayrros (energy/methane), Sylvera/Pachama
   (carbon), Sust Global (climate risk), Overstory (utilities) — expensive, single-purpose,
   and **not callable by an agent**.

The one agentic incumbent — **Microsoft "Earth Copilot"** — is Azure-locked, NASA-catalog-
scoped, and not model-agnostic or portable. **SkyFi's MCP is agent-native but is an
*acquisition* layer (buy pixels), not an *analysis* layer.** Earth Genome's *Earth Index*
proved demand for "search the planet" but is a closed web UI, Sentinel-2-only, no
quantification, not agent-callable.

**Nobody has shipped a free-first, multi-source, model-agnostic, agentic *analyst* that goes
from English question → data → analysis → quantified, cited answer — and runs inside any LLM
agent (Claude, GPT, Gemini, local) via MCP.** That is the white space. We are already
standing in it.

---

## 2. The core product (what the user actually wants)

Users do not want pixels. GEE returns rasters; Earth Index returns matches; SkyFi returns
imagery to buy. **What they want is the answer to a question about a place and time, with
enough rigor to act on it.**

> "This concession lost **1,240 ha** of forest since the 2020 cutoff — here's the monthly
> change map, **91% valid pixels**, confidence high, and the 3 Sentinel-2 + 1 Sentinel-1
> scene IDs as evidence."

That sentence — quantified, cloud-aware, cited, reproducible — is the product. Everything
else (the imagery, the dashboard, the tools) is in service of producing it and proving it.

### North star: **the AI Environmental Watchdog**

Of the four candidate theses, this is the one where *using the product builds the moat*:

| Thesis | Builds a durable asset? | Monetizes? | Free-first achievable? | Verdict |
| --- | --- | --- | --- | --- |
| Universal geospatial copilot | No (UX skin over others' data) | Weak | Yes | **Trap** — a feature, not a company |
| OSINT / verification engine | Methodology only | Hard (journalists don't pay) | Yes | **Best wedge, weak business** |
| MRV / compliance layer | Yes | Strong | No (needs auditor trust, cold-start hard) | **Best money, graduate *to* it** |
| **Environmental watchdog** | **Yes — monitoring history compounds** | **Yes** | **Yes** | **★ Winner** |

**Stated north-star:** *Continuous, agent-driven monitoring of any place on Earth, where
every alert is a verifiable, reproducible piece of evidence.*

The synthesis: **watchdog as the engine, verification as the interaction contract, MRV/
compliance as the monetization destination.** Every alert and answer ships with its
evidence (tiles, dates, detector + version, confidence, a reproducible recipe). That
"cited answer" format is what later makes the paid verticals credible — auditors and
regulators buy *evidence*, not vibes.

---

## 3. Who it's for — distribution wedge vs. monetization wedge

**Lead distribution wedge — OSINT journalists + environmental NGOs/watchdogs.** Free-first
*by necessity* (zero pricing friction), painful manual multi-tool workflows today, and they
prize exactly what an agent is good at: change detection, before/after evidence,
"find-this-pattern-elsewhere," and a citable audit trail. High virality, design-partner
friendly, credibility halo. They won't pay much — but they make us indispensable and known.

**Monetization wedges (high willingness-to-pay):**
- **EUDR deforestation-compliance** — a *legal mandate* with a hard deadline (obligations
  apply **30 Dec 2026** for large/medium operators, **30 Jun 2027** for small; ~€2B/yr
  compliance cost across 7 commodities). The deliverable *is* the watchdog: "is this plot
  deforestation-free since 2020-12-31, with evidence and a DDS-ready record?"
- **Methane / emissions monitoring** — Kayrros-proven ($20M rev, acquired 2026) on *free*
  Sentinel-5P data → EMIT/Carbon Mapper facility-scale confirmation. Energy, finance,
  regulators have budgets.
- **Parametric insurance** (fast-follow) — ~$24B→$39B by 2030, EO-driven; needs validated,
  low-false-positive triggers, which require the monitoring history + validation reputation
  we'll have by then.
- **Commodity/finance signals** (storage, frac crews, ag yields) — very high WTP; monetizes
  the install base.

**Deprioritize early:** broad carbon MRV (crowded, Sylvera/Pachama entrenched), agriculture
(fragmented, low ACV), defense/maritime OSINT (great PR, but dual-use + licensing make it a
poor *first paid* vertical).

---

## 4. The moat — two, and they reinforce each other

The data is open and the models are open (AlphaEarth is CC-BY), so **neither the imagery,
the models, nor an embeddings index is a moat** — all replicable. Defensibility comes from
what *accumulates by operating the product*:

1. **Cumulative monitoring history (primary).** The time-indexed record of *what changed
   where, when, with what evidence* across every watched area. It compounds with usage,
   **cannot be back-filled** (you can't retroactively have been watching a specific
   concession since 2021 with a versioned detector), and is exactly what MRV/insurance/EUDR
   buyers need (baseline + change history). This is the Global Forest Watch lesson: the
   durable value isn't the algorithm, it's being the *continuous system of record*.
2. **Trust / validation reputation (primary).** In EO the bottleneck is never imagery — it's
   *believability*. Sylvera and Pachama are fundamentally trust businesses. A reputation for
   "when this says deforestation happened, it happened" — built on published validation,
   confusion matrices, ground-truth feedback — is slow to build and slow to erode, and it
   accrues *on top of* the monitoring history.

Table stakes / accelerants (not moats): the embeddings index (open), the agentic UX
(copyable in a quarter), a detector marketplace (forkable recipes — but a great flywheel),
network effects (flow *through* the history and marketplace).

---

## 5. Design principles (non-negotiables)

1. **Free-first.** Default to genuinely open data (Sentinel, Landsat, S5P, GFW, Climate
   TRACE) and CC-BY assets (AlphaEarth). The core is OSS and self-hostable.
2. **Bring-your-own-keys.** Users plug their own Copernicus/FIRMS/Planet/SkyFi/commercial
   keys. We *never redistribute* licensed pixels — we fetch under the user's license and
   store only *derived* artifacts (change flags, embeddings, evidence metadata). This is also
   the structural fix for imagery-licensing risk.
3. **Model-agnostic & portable (MCP).** Runs inside any agent (Claude/GPT/Gemini/local),
   composable with the user's other tools. Not cloud-locked like Earth Copilot.
4. **Verification by default.** Every quantitative output ships with provenance (scene IDs,
   dates, sensor, processing baseline), a quality/confidence block (% valid, % synthesized,
   uncertainty), and a reproducible recipe. Output is **decision-support, not decision**.
5. **Never silently inpaint.** Cloud-removed / super-resolved / synthesized pixels are
   *always* flagged and never drive quantitative claims without validation.
6. **Open-first, escalate deliberately.** Use free data + open models for everything possible;
   reach for paid tasking (SkyFi/Planet) or GPU only when the job truly needs it — and tell
   the user the cost/benefit trade-off.

---

## 6. Capability pillars (what it must be able to do)

The product is the union of seven capabilities, each of which the roadmap grows:

1. **Observe** — pull any sensor for any place/time: optical (S2/Landsat), **all-weather SAR
   (Sentinel-1 — the cloud answer)**, thermal, hyperspectral/GHG (S5P/EMIT), nighttime lights,
   DEM. Fuse with non-satellite feeds (AIS, ADS-B, weather, OSM).
2. **Understand** — semantic comprehension via embeddings (AlphaEarth/Clay) and text-
   promptable detection/segmentation (samgeo + Grounding DINO): "find every place like this,"
   "count the oil tanks / ships / solar farms," "classify land cover."
3. **Detect change** — rigorous time-series: temporal compositing, CCDC/BFAST/LandTrendr,
   embedding-difference, SAR-coherence change.
4. **Monitor** — watchlists/AOIs, scheduling, deltas, alerting, persistent per-AOI history
   (the moat). Consume GFW integrated alerts where they exist; compute custom where they don't.
5. **Verify** — provenance, uncertainty quantification, % valid / % synthesized flags,
   validation vs. ground-truth, an auditable evidence trail.
6. **Reason** — an agentic planner that decomposes a question into a multi-step EO pipeline
   (a cheap, reliable **state-machine orchestrator**, not a free-form ReAct loop).
7. **Explain** — the dashboard + auto-generated, citation-backed reports a journalist can
   publish, an auditor can accept, a researcher can cite.

---

## 7. The multi-year roadmap — Horizons 0→5 (~5 years)

Each horizon is a coherent step in capability **and** product **and** (where relevant)
monetization. Free/open unless flagged. The first two horizons are almost entirely free,
no-GPU, and the highest-leverage upgrades.

### Horizon 0 — *Shipped: the demo* (done, 2026-06-05)
8 tools (snapshot, events, geo_resolve, fires, render, index, search, compare); live
MapLibre dashboard; SCL cloud masking + %-valid quality flag; public, MIT, npx-installable.
→ Proves the doorway. Everything below makes it an *analyst*.

### Horizon 1 — *Trustworthy analyst* (≈ months 0–6) — free, low/no GPU
Make the answers rigorous and materially fix the cloud problem.
- **Cloud handling, rung 1:** add **Cloud Score+ / s2cloudless / OmniCloudMask** (big
  reliability jump over SCL, incl. shadows). Surface % valid everywhere (done for stats; extend).
- **Sentinel-1 SAR (GRD):** all-weather backscatter + **flood mapping** + a `sar_*` toolset.
  This is the start of closing our #1 weakness; SAR sees through cloud, smoke, night.
- **Provenance block** on every numeric output (scene IDs, dates, sensor, baseline, mask
  method, % valid). Reframe outputs as decision-support.
- **Classic change-detection tools:** temporal median compositing, CCDC/BFAST/LandTrendr as
  MCP tools (richer than 2-date compare).
- **Consume GFW alerts** (GLAD-L / GLAD-S2 / RADD radar / DIST-ALERT) instead of rebuilding
  deforestation detection.
- **Internal STAC + COG data layer** (Earth Search + Planetary Computer STAC, anonymous) so
  we're not bound to one provider's API; GEE as a research compute backend (free non-commercial).

### Horizon 2 — *The planet becomes searchable* (≈ months 6–12) — free, no GPU
The single highest-leverage upgrade: embeddings.
- **Google AlphaEarth Satellite Embedding** (CC-BY, no GPU): `eo_similar` ("find everywhere
  that looks like this"), embedding-difference change detection (dot-product across years —
  labels-free, planet-scale), and few-shot classification.
- **pgvector** embedding index alongside STAC for nearest-neighbor + geo-filtered search.
- **Text-promptable detection/segmentation:** `eo_detect` via **samgeo + Grounding DINO + SAM**
  ("count solar farms / ships / oil tanks / buildings in this AOI").
- **State-machine agentic orchestrator** above the MCP tools (Geo-OLM pattern: ~100× cheaper
  than free-form agents, works with smaller/open LLMs) — turns one English question into a
  planned multi-tool analysis with a written, cited answer.

### Horizon 3 — *The Watchdog* (≈ year 1–2) — the north-star; first revenue
Continuous monitoring — where the moat starts accruing.
- **Watchlists/AOIs, scheduling, delta computation, alerting, persistent per-AOI history.**
  Integrated **optical + SAR alerts** for earliest, lowest-false-positive detection.
- **All-weather continuity:** Sentinel-1 + Sentinel-2 **fusion** and **uncertainty-aware
  cloud removal** (UnCRtainTS) — synthesized pixels always flagged. *(GPU enters here.)*
- The dashboard graduates into a real **monitoring web app** (AOIs, history, alert log).
- **Hosted monitoring tier (first paid product):** "we run the watch for you" — scheduled
  monitoring, alerting, stored history, the embeddings index. Free self-hostable core remains.

### Horizon 4 — *Verticalize* (≈ year 2–3) — margin via wedges
- **EUDR compliance pack** *(pull earlier if chasing the 2026/27 deadline wave)*: plot-list
  ingest, 2020 baseline, plot-level deforestation-free verification (optical + radar),
  DDS-ready evidence + audit trail.
- **Methane pack:** S5P daily screening → EMIT/Carbon Mapper facility confirmation →
  super-emitter alerts.
- **Self-hosted foundation models** (Clay / TerraMind via **TerraTorch**) for custom detectors
  (ships, oil tanks, solar via DOTA/xView/SpaceNet) and commercial freedom from GEE's
  non-commercial license. *(More GPU.)*
- Enterprise tier (compliance/insurance/MRV deliverables built on the monitoring history).

### Horizon 5 — *The platform / system of record* (≈ year 3–5) — network effects
- **Marketplace** of community detectors / monitoring recipes (revenue share) — densifies the
  history and trust moats.
- **The monitoring history + embeddings index as an API** (the system of record).
- **Parametric insurance** vertical (now we have validated low-FP triggers).
- **Validation reputation** productized: published accuracy, ground-truth feedback loops,
  confusion matrices → the trust moat made legible.
- Rich **multi-sensor fusion** (SAR + optical + hyperspectral + AIS + weather) for full
  "what is happening here and why" intelligence.

---

## 8. Architecture evolution (the technical spine)

```
            ┌──────────────── Agent (Claude / GPT / Gemini / local) ───────────────┐
            │  state-machine orchestrator (Geo-OLM pattern: plan → tools → report)  │
            └───────────────────────────────┬──────────────────────────────────────┘
                                            │ MCP (the portable tool boundary — already shipped)
   ┌──────────────┬───────────────┬─────────┴────────┬─────────────────┬───────────────────┐
 Observe        Understand      Detect change      Monitor           Verify              Explain
 (sensors)     (embeddings/     (CCDC/BFAST/      (watchlists/      (provenance/        (dashboard/
               detection)       embed-diff/SAR)    alerts/history)   uncertainty)        reports)
   │              │                │                  │                 │                   │
   └── Data layer: STAC + Cloud-Optimized GeoTIFF, stackstac/xarray/dask cubes,
       pgvector/Milvus embedding index, PostGIS AOIs + history ──────────────────────────────┘
   └── Compute: GEE (research, free non-commercial) · Planetary Computer / Earth Search STAC
       (commercial-safe data) · own GPU only for SAR-fusion + self-hosted FMs ───────────────┘
   └── ML: TerraTorch (Clay/Prithvi/TerraMind) · AlphaEarth embeddings · samgeo (SAM+GDINO) ──┘
```

Key engineering bets (all mature, mostly open): **STAC + COG + stackstac** internal data
cube; **pgvector** first (graduate to Milvus only at billion-vector scale); **TiTiler** for
dynamic tiling; **GEE/Planetary Computer** as serverless compute so we don't run a data
center early; a **state-machine planner** over the MCP boundary (not free-form ReAct) for
~100× cheaper, more reliable agentic analysis.

**The licensing trap to design around:** GEE is free only for non-commercial use. Prototype
on GEE, but keep a parallel **STAC+COG production path** (Earth Search / Planetary Computer /
CDSE-openEO + own compute) so a commercial launch never strands us. BYO-keys keeps us clear
of redistribution limits.

---

## 9. Data integration plan (tiered — full catalog in research appendix)

**Tier 1 — must-add (free, foundational):** Sentinel-2 ✓ · **Sentinel-1 SAR (the cloud
answer)** · Landsat 8/9 · **Sentinel-5P/TROPOMI (methane + air quality)** · Copernicus DEM ·
FIRMS ✓ · GEE + Earth Search STAC as the access layer · ERA5/GFS weather · derived via GEE
(Dynamic World, ESA WorldCover, **Hansen/GFW forest loss**, JRC Surface Water).

**Tier 2 — high-value (free/freemium):** **Umbra Open Data** (free, no-auth, 25 cm SAR) ·
**EMIT + Carbon Mapper** (facility-scale methane) · VIIRS Black Marble (economic-activity
proxy) · ALOS PALSAR L-band (see-through-canopy biomass) · **Global Fishing Watch + AIS**
(dark-vessel detection) · GHSL/WorldPop (population/exposure) · ECOSTRESS/Landsat thermal ·
OSM + OpenAQ · AlphaEarth Satellite Embedding (the searchability unlock).

**Tier 3 — specialized / BYO-key / paid:** PRISMA/EnMAP/GOSAT (hyperspectral & GHG, free w/
registration) · OCO-2/3 (column CO₂) · **Capella/ICEYE** (paid SAR tasking, BYO-key) ·
**Planet / SkyFi** (paid high-res tasking, BYO-key) · Maxar/Vantor Open Data (disaster 30 cm) ·
OpenSky ADS-B · NEXRAD radar.

> ⚠️ **Plan around two facts:** *Planet NICFI free tropical basemaps ended (2025)* — don't
> architect on them. *MethaneSAT was lost (Jun 2025)* — archive only; use S5P + EMIT +
> Carbon Mapper for methane instead.

---

## 10. Monetization — free core, BYO-keys, four phases

Learned from comparables: the free public-good layer (GFW, Climate TRACE) is grant-funded and
*not* self-sustaining; EO analytics monetizes as **enterprise verticals** (Kayrros, Sylvera,
Overstory, Sust). So:

- **Phase 0 — Free OSS core (land grab):** MCP + agent + dashboard, model-agnostic, BYO-keys.
  Become the default; seed the marketplace; start accruing monitoring history. *Charge: nothing.*
- **Phase 1 — Hosted compute & monitoring (first revenue):** "we run the watch for you" —
  scheduled monitoring, alerting, stored history, embeddings index. Usage/seat SaaS. The honest
  answer to "who pays for compute": the people who want managed continuous monitoring.
- **Phase 2 — Enterprise verticals (margin):** package the monitoring history + verification
  evidence into **EUDR / methane / insurance / MRV** deliverables. Sales-led, high ACV.
- **Phase 3 — Marketplace & API (network effects):** revenue-share on community detectors;
  metered API for the embeddings index + evidence objects.

**Rule:** charge for *managed compute, vertical packaging, and the platform* — never for the
open data or the open models. Grants can fund a public-good *research* layer, not the core.

---

## 11. Risks & ethics

| Risk | Mitigation |
| --- | --- |
| **Dual-use / surveillance** | Anchor in environmental/compliance use; resolution-limit free tiers (10 m Sentinel is non-identifying); acceptable-use policy; keep individual-tracking out of the free core. |
| **Imagery licensing / no-redistribution** | **BYO-keys is the structural fix** — fetch under the user's license, store only derived artifacts. Free tier on truly-open + CC-BY data only (attribute AlphaEarth to Google/DeepMind). |
| **Reliability / liability** (a false "deforestation" flag can wrongly accuse) | **Verification-by-default** — confidence, uncertainty, published validation, detector versioning, human-in-the-loop for high-stakes alerts. Decision-support, not decision. This *is* moat #2. |
| **Free-tier sustainability** | Don't subsidize others' compute: free core = self-hostable OSS + BYO-keys; managed monitoring is the paid product. |

---

## 12. Near-term: the next concrete steps (Horizon 1 backlog)

Tactical items roll into [ROADMAP.md](ROADMAP.md). The first moves, in order of leverage:

1. **Better cloud masking** — Cloud Score+ / s2cloudless / OmniCloudMask behind the existing
   `eo_index`/`eo_render`/`eo_compare`; keep the %-valid flag. *(free, no GPU, immediate quality jump)*
2. **Sentinel-1 SAR tool(s)** — GRD backscatter render + flood/water mapping; the start of
   all-weather. *(free)*
3. **Provenance block** — attach scene IDs/dates/sensor/mask-method to every numeric result.
4. **AlphaEarth embeddings → `eo_similar` + embedding-difference change** — the searchability
   unlock. *(free, no GPU)*
5. **`eo_detect`** (samgeo + Grounding DINO) — text-promptable object counting.
6. **Monitoring MVP** — AOI watchlist + scheduled delta + alert (start the history/moat).

Each ships the same way the v0.1 phases did: build → live-verify against real APIs → commit →
update ledgers.

---

## 13. Open questions to revisit as we iterate

- **Commercial license stance** — do we keep the *whole* product MIT, or core-MIT + a hosted
  commercial tier? (Affects GEE-commercial exposure.)
- **EUDR timing** — chase the 30 Dec 2026 deadline wave (pull Horizon 4 forward, aggressive) or
  build the watchdog properly first and serve the *ongoing* compliance demand? Likely the latter.
- **Compute backend** — how long can GEE/Planetary-Computer free tiers carry us before we must
  run our own GPU/cube? (Probably through Horizons 1–2.)
- **Hosted vs. pure-OSS** — when does "we run the watch for you" become worth building?
- **Agent framework** — adopt an existing state-machine geo-agent (Geo-OLM/GeoLLM-Squad) or
  grow our own planner over the MCP boundary?

---

## Appendix — key sources (2026-06)

- **Embeddings / models:** Google AlphaEarth Satellite Embedding (Earth Engine catalog, CC-BY) ·
  Clay v1.5 · IBM-NASA Prithvi / IBM-ESA TerraMind · IBM **TerraTorch** · Satlas · Presto · Major TOM.
- **Cloud / SAR:** Sentinel-1 (Copernicus) · Cloud Score+ / s2cloudless / OmniCloudMask ·
  SEN12MS-CR/-TS · GLF-CR / DSen2-CR · **UnCRtainTS** (uncertainty-aware) · Umbra Open Data (AWS/Radiant).
- **Change / monitoring:** CCDC/COLD · BFAST · LandTrendr · Global Forest Watch integrated
  alerts (GLAD/RADD/DIST-ALERT).
- **Detection / scale:** segment-geospatial (samgeo) + Grounding DINO · DOTA/xView/SpaceNet ·
  STAC + COG + stackstac · TiTiler · pgvector/Milvus.
- **Agents:** Geo-OLM (state-machine, ~100× cheaper) · GeoLLM-Squad · GeoBenchX.
- **Market / strategy:** EUDR (EU Official Journal 2025; obligations 30 Dec 2026 / 30 Jun 2027;
  ~€2B/yr) · Kayrros (acq. Energy Aspects 2026) · Sylvera / Pachama (carbon trust businesses) ·
  Sust Global (acq. ISS STOXX) · Overstory · Global Forest Watch / WRI · Climate TRACE ·
  Microsoft Earth Copilot · SkyFi MCP · Earth Genome "Earth Index."
- **Caveats:** vendor funding/market-size figures are directional (VCM 2030 estimates span ~5×);
  EUDR timeline, AlphaEarth licensing, and Planet/Kayrros figures are high-confidence (primary sources).
