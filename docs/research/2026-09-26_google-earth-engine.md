# Google Earth Engine for Vital — access, datasets, recommendation (2026-09-26)

> Scope: Marc asked to "explore" the [EE data catalog](https://developers.google.com/earth-engine/datasets/)
> and the [EE API](https://developers.google.com/earth-engine/#api). This note covers how we would
> get access in 2026, which catalog datasets matter for "the value of living nature", which of
> them are better read from an open mirror, and what the `gee_query` prototype
> (`src/clients/gee.ts`, `src/tools/gee.ts`) does. Items not verified against a live call are
> marked **UNCONFIRMED** — there are no EE credentials on the build machine.

## TL;DR

- EE is **free for noncommercial use** on a verified Cloud project, with a monthly compute quota
  (Community 150 EECU-h, Contributor 1,000, Partner 100,000). Commercial use starts at a paid
  subscription (reported $500/month "Basic"). Vital as an open public-good watchdog should
  qualify as noncommercial; **if Vital ever charges, the EE path becomes a paid dependency.**
- We can call it from Node with **zero new deps**: RS256-sign a service-account JWT with
  `node:crypto`, exchange it for an OAuth token, POST a serialized expression graph to
  `v1/projects/{p}/value:compute`. That is what the prototype does.
- Most of the headline datasets (Hansen, WorldCover, MapBiomas, WorldPop, AlphaEarth) have
  **zero-key open mirrors** as tiled GeoTIFFs we can range-read exactly like `aef.ts` already does.
  EE is only *necessary* for **Dynamic World** (computed on the fly, no mirror), and it is
  *convenient* for zonal stats (server-side reduceRegion vs. us decoding hundreds of tiles).
- First integrations: Dynamic World (EE), MapBiomas (mirror; EE fallback), GEDI L4B biomass (EE
  or NASA ORNL), Hansen GFC v1.13 (mirror), WorldPop/GHSL population (mirror or EE), Global
  Pasture Watch (EE; the global answer to "pasture ≠ grassland").

## 1. Access model (2026)

**Cloud-project model.** Since 2024 every EE request runs against a Google Cloud project that is
registered for Earth Engine and has the Earth Engine API enabled. Registration is at
[console.cloud.google.com/earth-engine](https://console.cloud.google.com/earth-engine), where you
choose commercial or noncommercial use ([Access guide](https://developers.google.com/earth-engine/guides/access)).

**Noncommercial eligibility & verification.** Unpaid access requires Google to verify each
noncommercial project; projects registered before 15 April 2025 had to complete an eligibility
questionnaire by 26 September 2025 or risk an access hold, and all noncommercial projects must
**re-verify periodically** ([Access guide](https://developers.google.com/earth-engine/guides/access)).
Noncommercial covers academia, nonprofits, research, education, government-for-public-good and
personal use; revenue-generating use by for-profits is commercial (**UNCONFIRMED**: exact wording
of the questionnaire for a solo founder building an open-source public-good tool — Marc should
answer honestly; if a paid Vital tier is planned, register commercial for that project).

**Noncommercial quota tiers** — enforced since **27 April 2026**, monthly EECU-hour budgets that
reset on the 1st (Pacific time) ([Noncommercial tiers](https://developers.google.com/earth-engine/guides/noncommercial_tiers)):

| Tier | EECU-h / month | Requirement |
| --- | --- | --- |
| Community (default) | 150 | verified noncommercial project |
| Contributor | 1,000 | active billing account attached (EE usage still not charged) |
| Partner | 100,000 | separate application; high-impact climate/biodiversity work; weeks to approve |

After the quota is used you keep computing in a slower **"restricted mode"** until reset.
Splitting work across several noncommercial projects to farm quota is prohibited.

**Commercial.** Subscription plus EECU usage. Reported list prices: **Basic $500/month** (2 seats,
100 batch + 10 online EECU-h, 100 GB), **Professional $2,000/month** (500 batch + 50 online EECU-h,
1 TB), Premium by quote ([Sanborn FAQ](https://sanborn.com/blog/google-earth-engine-frequently-asked-questions/),
[Google pricing page](https://cloud.google.com/earth-engine/pricing)). Overage per-EECU-hour rates
**UNCONFIRMED** (the pricing page did not render for us).

**Quotas & limits** ([Usage guide](https://developers.google.com/earth-engine/guides/usage)):
40 concurrent interactive requests/project, 100 requests/s, 2 concurrent batch tasks, 250 GB
asset storage, 10 MB max request payload, 100 MiB cached aggregation results, per-request memory
cap ("User memory limit exceeded"). Interactive calls time out after ~5 minutes (**UNCONFIRMED**
exact figure in 2026) — hence the prototype caps each reduceRegion at ~10⁷ pixels.

**What an EECU-hour buys us.** A 10 m land-cover histogram over a ~10×10 km box is on the order
of seconds of EECU; 150 EECU-h/month is ample for interactive `gee_query` use and a daily watch
sweep over tens of AOIs (**UNCONFIRMED** — measure with `workloadTag` + Cloud Monitoring once live).

### Authentication for a server

1. Create a **service account** in the EE-registered project; grant it **Earth Engine Resource
   Viewer** (compute) — add **Service Usage Consumer** if calls fail with a
   `serviceusage.services.use` permission error
   ([Service accounts](https://developers.google.com/earth-engine/guides/service_account)).
2. Create a **JSON key** (or, on GCP/GitHub Actions, prefer workload identity federation — no
   long-lived key; we don't need it on Marc's laptop).
3. OAuth2 JWT-bearer flow ([Google server-to-server OAuth](https://developers.google.com/identity/protocols/oauth2/service-account)):
   header `{"alg":"RS256","typ":"JWT"}`, claims `{iss: client_email, scope, aud:
   "https://oauth2.googleapis.com/token", iat, exp ≤ iat+3600}`, POST
   `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=<jwt>` to
   `https://oauth2.googleapis.com/token` → `{access_token, expires_in, token_type}`. Scope:
   `https://www.googleapis.com/auth/earthengine` (or `cloud-platform`).

### REST API surface (`https://earthengine.googleapis.com/v1`)

| Method | Use for Vital |
| --- | --- |
| `POST projects/{p}/value:compute` `{expression}` → `{result}` | Any scalar/dict result: reduceRegion stats, histograms, counts. **Our workhorse.** |
| `POST projects/{p}/image:computePixels` `{expression, fileFormat, grid}` | Raw pixels (GeoTIFF/NPY/PNG) of a computed image; response capped (~48 MB, **UNCONFIRMED**) — for dashboard thumbnails. |
| `POST projects/{p}/table:computeFeatures` `{expression}` | Computed FeatureCollections as GeoJSON pages — e.g. per-basin stats over HydroBASINS. |
| `projects/{p}/assets/*` (`getPixels`, `listAssets`, `listImages`) | Read stored assets directly without an expression. |

The `expression` is the serialized EE computation graph — exactly what the Python/JS clients
send ([`serializer.py`](https://github.com/google/earthengine-api/blob/master/python/ee/serializer.py),
[`data.py` computeValue](https://github.com/google/earthengine-api/blob/master/python/ee/data.py)):

```jsonc
{ "result": "0",
  "values": { "0": { "functionInvocationValue": {
      "functionName": "Image.reduceRegion",
      "arguments": {
        "image":    { "functionInvocationValue": { "functionName": "Image.select", "arguments": {
                        "input": { "functionInvocationValue": { "functionName": "Image.load",
                                   "arguments": { "id": { "constantValue": "LARSE/GEDI/GEDI04_B_002" } } } },
                        "bandSelectors": { "constantValue": ["MU"] } } } },
        "reducer":  { "functionInvocationValue": { "functionName": "Reducer.mean", "arguments": {} } },
        "geometry": { "functionInvocationValue": { "functionName": "GeometryConstructors.Rectangle",
                      "arguments": { "coordinates": { "constantValue": [[-60,-3],[-59.9,-2.9]] },
                                     "geodesic": { "constantValue": false } } } },
        "scale": { "constantValue": 1000 }, "maxPixels": { "constantValue": 1e10 },
        "bestEffort": { "constantValue": true } } } } } }
```

Other `ValueNode` kinds: `arrayValue {values}`, `dictionaryValue {values}`, `valueReference`
(the official client de-duplicates shared sub-graphs into `values` and references them; we inline
a single tree under `"0"`, which is equally valid). Filters follow the client serialization:
`Collection.filter {collection, filter}`, `Filter.dateRangeContains {leftValue: DateRange{start,end},
rightField: "system:time_start"}`, `Filter.intersects {leftField: ".all", rightValue: Feature{geometry}}`,
`Filter.equals {leftField, rightValue}` ([`filter.py`](https://github.com/google/earthengine-api/blob/master/python/ee/filter.py)).
**UNCONFIRMED live:** `reduce.mode` (collection mode that keeps band names) and the exact
`Rectangle` coordinate nesting — both are the first things to check on the first real call
(`POST v1/projects/{p}/algorithms` lists every algorithm and its argument names).

### Client library vs. raw REST

`@google/earthengine` (npm) is the official JS client, v1.7.45 published 2026-09-21, Apache-2.0,
deps `googleapis ^92` + `xmlhttprequest` (npm registry). It works in Node
(`ee.data.authenticateViaPrivateKey(key)` → `ee.initialize(null, null, cb, err, null, project)`)
and gives the fluent `ee.Image(...).reduceRegion(...)` API. Against it: it pulls the entire
`googleapis` tree (hundreds of packages), callback-style init, caret ranges that fight our
exact-pin rule, and global mutable state. **Recommendation: raw REST.** The prototype is ~150
lines including auth, and every request is inspectable JSON — which suits Vital's
"re-runnable recipe" rule: a finding can store the exact expression it computed.

## 2. Datasets that matter for Vital

"Mirror" = a zero-key public copy we can range-read (tiled GeoTIFF/COG) without EE. Mirror
checks: HTTP 200 on 2026-09-26 unless noted.

| Dataset (EE id) | Res. / cadence / coverage | Licence | What it solves for Vital | Mirror? |
| --- | --- | --- | --- | --- |
| **MapBiomas Brazil C10** `projects/mapbiomas-public/assets/brazil/lulc/v1` (filter `collection_id`=10, `year`) | 30 m, annual 1985–2024, Brazil | CC-BY 4.0 | **Pasture (15) vs. natural grassland (12)** plus crops, plantation, mining, urban — fixes "pasture counted as grassland" in `natural_value` for Brazil; 40-year history for "since when was this cleared" ([catalog](https://developers.google.com/earth-engine/datasets/catalog/projects_mapbiomas-public_assets_brazil_lulc_v1)) | **Yes**: `storage.googleapis.com/mapbiomas-public/initiatives/brasil/collection_10/lulc/coverage/brazil_coverage_{year}.tif` — 802 MB BigTIFF, 256² tiles, LZW+predictor, uint8, EPSG:4326 (probed). Other MapBiomas countries (Amazonia, Chaco, Indonesia…) have their own collections. |
| **Global Pasture Watch** `projects/global-pasture-watch/assets/ggc-30m/v1/grassland_c` (+ `cultiv-grassland_p`, `nat-semi-grassland_p`) | 30 m, annual 2000–2022, global | CC-BY 4.0 (**UNCONFIRMED**) | **The global pasture fix**: cultivated vs. natural/semi-natural grassland everywhere, not just Brazil ([catalog](https://developers.google.com/earth-engine/datasets/catalog/projects_global-pasture-watch_assets_ggc-30m_v1_grassland_c), [paper](https://pmc.ncbi.nlm.nih.gov/articles/PMC11634896/)) | Zenodo downloads (**UNCONFIRMED** COG layout) |
| **Dynamic World V1** `GOOGLE/DYNAMICWORLD/V1` | 10 m, every S2 scene (2–5 d), 2015-06→now, global | CC-BY 4.0 | Near-real-time land cover **change** — "this was trees in June, bare in September"; class probabilities give confidence. The only dataset here that **requires EE** ([catalog](https://developers.google.com/earth-engine/datasets/catalog/GOOGLE_DYNAMICWORLD_V1)) | No (computed per scene) |
| **ESA WorldCover v200** `ESA/WorldCover/v200` | 10 m, 2021 (v100 2020), global | CC-BY 4.0 | Stable global baseline land cover (11 classes incl. mangroves, wetlands) | **Yes**: `esa-worldcover.s3.eu-central-1.amazonaws.com/v200/2021/map/…_Map.tif` (3°×3° COGs) |
| **Hansen GFC v1.13** `UMD/hansen/global_forest_change_2025_v1_13` | 30 m, annual loss 2001–2025, global | CC-BY 4.0 | Canonical tree-cover-loss year; EUDR baseline cross-check for `forest_alerts` ([catalog](https://developers.google.com/earth-engine/datasets/catalog/UMD_hansen_global_forest_change_2024_v1_12)) | **Yes**: `storage.googleapis.com/earthenginepartners-hansen/GFC-2025-v1.13/…` 10°×10° tiles |
| **Natural Forests of the World 2020** `projects/nature-trace/assets/forest_typology/natural_forest_2020_v1_0_collection` | 10 m, 2020, global | CC-BY-SA 4.0 | Natural vs. planted forest probability — **EUDR** "was it natural forest on 31 Dec 2020" ([catalog](https://developers.google.com/earth-engine/datasets/catalog/projects_nature-trace_assets_forest_typology_natural_forest_2020_v1_0_collection)) | **UNCONFIRMED** |
| **GEDI L4B v2** `LARSE/GEDI/GEDI04_B_002` (L4A footprints: `LARSE/GEDI/GEDI04_A_002_MONTHLY`) | 1 km grid, 2019-04→2021-08, ±51.6° lat | Public domain | **Carbon value**: mean aboveground biomass density (band `MU`, Mg/ha) → tC ≈ 0.47×AGB → tCO₂e ([catalog](https://developers.google.com/earth-engine/datasets/catalog/LARSE_GEDI_GEDI04_B_002)). Newer L4B v2.1 through 2023 exists at ORNL DAAC (**UNCONFIRMED** in EE) | NASA ORNL DAAC (Earthdata login) |
| **JRC Global Surface Water 1.4** `JRC/GSW1_4/GlobalSurfaceWater` (+ `MonthlyHistory`) | 30 m, 1984–2021 | CC-BY 4.0 (**UNCONFIRMED**) | Wetland/river dynamics, permanent vs. seasonal water, drying lakes | GCS downloads exist; path we tried 404'd (**UNCONFIRMED**) |
| **MODIS/VIIRS fire** `MODIS/061/MOD14A1`, `MODIS/061/MCD64A1` (burned area), `FIRMS` | 1 km / 500 m daily–monthly | public | Burned-area history; we already have live FIRMS via API | NASA (keyed API already integrated) |
| **Sentinel-2 / -1** `COPERNICUS/S2_SR_HARMONIZED`, `COPERNICUS/S1_GRD` | 10 m, 5 d / 6–12 d | Copernicus free | Same data as CDSE; EE is faster for multi-year per-pixel composites, CDSE Sentinel Hub gives us rendering + statistics already | CDSE / Earth Search (in use) |
| **ERA5-Land** `ECMWF/ERA5_LAND/HOURLY`, `…/MONTHLY_AGGR` | ~9 km, hourly, 1950→ | Copernicus | Already covered via Open-Meteo (`climate_history`); EE only for area-mean climate over large AOIs | Open-Meteo (in use) |
| **WorldPop** `WorldPop/GP/100m/pop` | ~93 m, annual 2000–2020(21), global | CC-BY 4.0 | **Downstream beneficiaries**: people in a catchment/buffer ([catalog](https://developers.google.com/earth-engine/datasets/catalog/WorldPop_GP_100m_pop)) | **Yes**: `data.worldpop.org/GIS/Population/Global_2000_2020/{year}/{ISO3}/…tif` |
| **GHSL population** `JRC/GHSL/P2023A/GHS_POP` | 100 m, 5-yearly 1975–2030 | CC-BY 4.0 | Consistent multi-decade population + projections | JRC FTP (**UNCONFIRMED** COG) |
| **HydroSHEDS / HydroBASINS** `WWF/HydroSHEDS/v1/Basins/hybas_{1..12}`, `WWF/HydroSHEDS/15ACC` | vector basins, 15 arc-s rasters | free w/ attribution (non-commercial clauses in older versions — **check**) | **Downstream catchment**: nested basins with `NEXT_DOWN` → walk downstream from an AOI, then sum WorldPop in those basins | hydrosheds.org downloads |
| **Biodiversity Intactness Index** `projects/ebx-data/assets/earthblox/IO/BII_V1_1` (community catalog) | 100 m, annual 2017–2025 | CC-BY 4.0 | Newbold/PREDICTS-model intactness (0–1) — a *method-stated* biodiversity metric, complements GBIF's effort-biased counts ([community catalog](https://gee-community-catalog.org/projects/bii/)) | **Yes**: Planetary Computer `io-biodiversity` (2017–2020) |
| **Global Mangrove Watch v4** `projects/sat-io/open-datasets/GMW/annual-extent/GMW_MNG_2020` (community) | ~10–25 m, 1996–2020 annual | CC-BY 4.0 | Mangrove extent/loss — blue carbon | Zenodo / DE Africa on AWS |
| **Allen Coral Atlas v2** `ACA/reef_habitat/v2_0` | 5 m, 2018–2021 | CC-BY 4.0 | Reef geomorphic/benthic maps → which reef area `coral_bleaching` is actually stressing | allencoralatlas.org downloads |
| **NICFI Planet basemaps** `projects/planet-nicfi/assets/basemaps/{africa,americas,asia}` | 4.77 m, monthly 2020-09→2025-01, tropics | **NICFI licence — noncommercial, attribution, no redistribution of imagery** | Sub-5 m visual verification of clearing | **Dead end**: contract ended 23 Jan 2025, next phase cancelled Sept 2025; access being phased out ([NICFI](https://www.nicfi.no/2025/01/28/nicfi-satellite-data-program-enters-new-phase/), [Nimbo](https://nimbo.earth/stories/end-nicfi-satellite-tropical-forest-monitoring-alternative/)). Do not build on it. |
| **AlphaEarth Satellite Embedding** `GOOGLE/SATELLITE_EMBEDDING/V1/ANNUAL` | 10 m, 64-d, annual 2017–2024(+2025) | CC-BY 4.0 | Similarity search / change (`eo_similar`) ([catalog](https://developers.google.com/earth-engine/datasets/catalog/GOOGLE_SATELLITE_EMBEDDING_V1_ANNUAL)). **Keep Source Cooperative** (zero key, already built); EE adds server-side similarity over huge areas and the regenerated v1.1 2017 layer — mirror parity **UNCONFIRMED** | **Yes** (in use, `aef.ts`) |
| **Soil organic carbon** SoilGrids `projects/soilgrids-isric/soc_mean` (community), `OpenLandMap/SOL/SOL_ORGANIC-CARBON_USDA-6A1C_M/v02` | 250 m, static | CC-BY 4.0 | Below-ground carbon stock — often larger than AGB in grasslands/peat | **Yes**: ISRIC WebDAV/COG |
| **Peatlands / wetlands** (e.g. Global Peatland Map, GLWD v2 in community catalog) | ~1 km / 500 m | varies | Irrecoverable carbon; drainage risk | **UNCONFIRMED** ids |
| **WDPA** `WCMC/WDPA/current/polygons` | vector, monthly | **No commercial use without UNEP-WCMC permission** ([catalog](https://developers.google.com/earth-engine/datasets/catalog/WCMC_WDPA_current_polygons)) | Protected areas — we already have WDPA via GFW + OSM in `protected_areas` | GFW Data API (in use) |
| **VIIRS night lights** `NOAA/VIIRS/DNB/MONTHLY_V1/VCMSLCFG`, Black Marble | ~460 m monthly | public | Encroachment/settlement growth, gas-flare cross-check for `flaring` | NASA Black Marble (Earthdata) |

## 3. Recommendation

Principle (VISION §5, CLAUDE.md "open data only"): **zero-key mirror first; EE only where it is
the only practical path or where server-side aggregation saves us from reinventing a raster
engine.** Every EE-backed tool must degrade to a clean "not configured" error, and the watch
kernel must not *depend* on EE (a revoked noncommercial verification would otherwise stop the
ledger).

| # | Dataset | Path | Why this path | Cost |
| --- | --- | --- | --- | --- |
| 1 | **MapBiomas Brazil C10** (pasture) | **Mirror** (GCS BigTIFF range reads; needs a small LZW decoder next to `fzstd`) — `gee_query dataset=mapbiomas` as fallback/cross-check | Zero-key, 30 m, fixes the pasture flaw for the country where it matters most | $0 |
| 2 | **Dynamic World** | **EE** (`gee_query land_cover dynamic-world`) | No mirror exists; near-real-time 10 m change is the unique capability | Noncommercial quota (Community tier) |
| 3 | **GEDI L4B biomass** | **EE** (`gee_query biomass`) now; ORNL DAAC via Earthdata later | 1 km grid → one reduceRegion; turns hectares into tCO₂e | Quota; ~free |
| 4 | **Global Pasture Watch** | **EE** | Global cultivated-vs-natural grassland; the non-Brazil half of the pasture fix | Quota |
| 5 | **Hansen GFC v1.13** | **Mirror** (GCS tiles) | Zero-key; loss-year baseline for `forest_alerts` / EUDR | $0 |
| 6 | **WorldPop + HydroBASINS** (downstream beneficiaries) | **EE** for the combined basin-walk + zonal sum (`table:computeFeatures`); mirror for WorldPop-only | One server-side query vs. vector+raster plumbing locally | Quota |

Deliberately *not* now: NICFI (programme dead), WDPA via EE (licence; we have it), S2/S1/ERA5 via
EE (duplicates CDSE/Open-Meteo), AlphaEarth via EE (mirror works).

**Money.** Noncommercial Community tier: $0, 150 EECU-h/month — enough for the prototype and
interactive use. Contributor tier (1,000 EECU-h) needs only a billing account attached; still $0
for EE. If Vital becomes a paid product, EE is ≥ $500/month — another reason to keep EE on the
optional path.

### What Marc must do once (≈15 minutes)

1. **Create a Cloud project** (e.g. `vital-ee`) at <https://console.cloud.google.com/projectcreate>.
2. **Register it for Earth Engine**: <https://console.cloud.google.com/earth-engine> → choose
   *Noncommercial* (unpaid) → answer the eligibility questionnaire truthfully (open-source public-good
   environmental monitoring, no revenue). Keep the default *Community* tier; optionally attach a
   billing account to get *Contributor*.
3. **Enable the Earth Engine API**: <https://console.cloud.google.com/apis/library/earthengine.googleapis.com>.
4. **Create a service account**: IAM & Admin → Service Accounts → *Create* (e.g. `vital-gee`),
   grant roles **Earth Engine Resource Viewer** and **Service Usage Consumer**.
5. **Create a JSON key** for it (Keys → Add key → JSON), save outside the repo, e.g.
   `~/.config/vital/gee-key.json` (`chmod 600`).
6. Add to `/Users/marcsperzel/code/tools/earthdeck/.env`:
   `GEE_SERVICE_ACCOUNT_JSON=/Users/marcsperzel/.config/vital/gee-key.json` and `GEE_PROJECT=vital-ee`.
7. Run `earthdeck doctor` → expect `✓ Google Earth Engine (gee_query) configured`; then one live
   `gee_query` (e.g. `biomass` over `[-60,-3,-59.9,-2.9]`) to retire the UNCONFIRMED items below.

## 4. The prototype (`src/clients/gee.ts`, `src/tools/gee.ts`)

- **Auth**: `buildJwt()` → RS256 via `createSign("RSA-SHA256")`, 1 h assertion; token cached until
  60 s before expiry, concurrent refreshes de-duped, one retry on 401 (same pattern as
  `copernicus.ts`).
- **Compute**: `GeeClient.computeValue(expr)` → `POST {base}/projects/{p}/value:compute`,
  returns `result`; EE `error.message` surfaced in an `OverviewError`; 429 → quota message.
- **Expression builder** (`ee.*`): `rect`, `image`, `collection`, `filter` + `dateFilter`/
  `boundsFilter`/`eqFilter`, `mode`, `mosaic`, `select`, `reducer`, `reduceRegion`.
- **Helpers**: `landCoverMix(bbox, "dynamic-world"|"mapbiomas"|"worldcover")` →
  `frequencyHistogram` → sorted class shares (+ `naturalSharePct` for MapBiomas, where pasture is
  anthropic); scale auto-coarsened to keep ≤10⁷ px and reported as `scaleM`. `biomass(bbox)` →
  GEDI L4B mean `MU` (t/ha). `population(bbox, year)` → WorldPop sum at native 92.77 m, no
  `bestEffort` (coarsening would bias a sum), bbox ≤2°/side.
- **Tool**: `gee_query {query: land_cover|biomass|population, bbox, dataset?, year?, dateFrom?, dateTo?}`,
  `safe()`, JSON output, best-effort `pulse` card. **Doctor**: offline config line.
- **Config**: `GEE_SERVICE_ACCOUNT_JSON` (path or inline JSON), `GEE_PROJECT` (overrides key's
  `project_id`), optional `EARTHDECK_GEE_API_BASE`.
- **Tests** (`test/gee.test.ts`, offline): JWT header/claims + signature verified with a
  test-generated RSA key; config parsing; expression graphs; scale picking; class-share math;
  token exchange/caching; 401 refresh; EE error surfacing; not-configured path.

## UNCONFIRMED (retire on the first live call)

1. Algorithm names `reduce.mode`, `ImageCollection.mosaic`, `GeometryConstructors.Rectangle`
   coordinate nesting `[[w,s],[e,n]]`, `Filter.equals` on a DOUBLE `collection_id` with integer 10.
2. `value:compute` response for reduceRegion is `{result: {band: …}}` with histogram keys as
   strings of the class code (fixtures are hand-made to that shape).
3. Whether Earth Engine Resource Viewer alone suffices, or Service Usage Consumer is also needed.
4. Commercial overage rates; interactive timeout and computePixels size cap figures.
5. EECU cost per `gee_query` (measure; set a `workloadTag`).
6. MapBiomas C10 rarer legend codes; GPW / JRC GSW licences; Natural Forests / GSW / GHSL mirror layouts.
7. Noncommercial eligibility for Vital as run by Marc (Google decides at verification).
