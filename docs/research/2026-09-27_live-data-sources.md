# Live data sources for a planetary-health watch — catalogue (2026-09-27)

**Question.** God's Eye View (GEV, `bilawalsidhu/gods-eye-view`, MIT code, per-source data
terms) puts ~40 live feeds on one globe. Which of them — plus what earthdeck already has —
belong in TerraKeep, whose job is *keeping Earth within its limits*, not tracking people or
planes? For each source: endpoint, key, licence, refresh, and a verdict:

- **layer** — context on the map (no finding, no ledger entry);
- **rule** — drives or confirms a watch rule (threshold/event + an independent second signal);
- **skip** — with the reason: *privacy* (cameras, plate readers), *irrelevance* (flights,
  transit), *cost/licence* (paid, non-commercial or no-redistribution terms).

Sources: GEV `README.md`, `DATA_SOURCES.md`, `THIRD_PARTY_NOTICES.md`, `server/providers/*`
(ideas, endpoints and licence facts only — no code or bundled data copied). Every endpoint
marked ✓ was called live on 2026-09-27. Anything not verified is marked UNCONFIRMED.

## 1. Weather (first, because heat, storms and floods are where people die first)

| Source | Endpoint | Key | Licence / terms | Refresh | Verdict |
| --- | --- | --- | --- | --- | --- |
| **Open-Meteo forecast** (ECMWF IFS, DWD ICON, NOAA GFS blend) ✓ | `api.open-meteo.com/v1/forecast` | no | Data CC BY 4.0; free API is non-commercial, ~10k calls/day, >2 weeks or >10 vars count as several calls | 15 min current, hourly models | **rule + layer — built.** `weather_now`; heat (≥ abs °C or ≥ +anomaly for ≥ N days) and extreme rain (≥ mm/day) in `weather_extreme@1.0`; wind-arrow layer (multi-location `current=`, CORS `*` ✓) |
| **ERA5 via Open-Meteo archive** ✓ (have) | `archive-api.open-meteo.com/v1/archive?models=era5` | no | CC BY 4.0 (Copernicus C3S) | daily, ~6-day latency | **rule — built.** 1991–2020 normals (30 one-year windows, ±3 d) and the heat *confirmation*. Finding: the default `best_match` back-fills the last days with forecast data, so it is **not** independent — `models=era5` returns honest nulls instead |
| **ECMWF Open Data** (IFS 0.25° GRIB2) | `data.ecmwf.int/forecasts` | no | CC BY 4.0 + ECMWF terms (attribution, modification notice, liability disclaimer) | 6-hourly | **skip for now** — needs a GRIB decoder (new dep); Open-Meteo already serves IFS as JSON |
| **NOAA GFS** on AWS Open Data | `noaa-gfs-bdp-pds.s3.amazonaws.com` | no | U.S. public domain | 6-hourly | **skip for now** — same reason (GRIB byte ranges + ecCodes WASM in GEV) |
| **NOAA NHC / CPHC** ✓ | `www.nhc.noaa.gov/CurrentStorms.json` + `mapservices.weather.noaa.gov/tropical/rest/services/tropical/NHC_tropical_weather_summary/MapServer/{5 points,7 cone}/query?f=geojson` | no | U.S. public data, weather.gov disclaimer; no CORS on nhc.noaa.gov → server-side | per advisory (3–6 h) | **rule + layer — built.** `storms`; cyclone cone ∩ AOI → candidate. `maxAllowableOffset=0.05` keeps a basin's cones ≈4 KB. Atlantic + E/C Pacific only |
| **GDACS** (UN OCHA / EC JRC) ✓ | `gdacs.org/gdacsapi/api/events/geteventlist/SEARCH?eventlist=TC` + `…/polygons/getgeometry` (`Class=Poly_Cones`) | no | "as is", automatic, not human-reviewed; no explicit reuse licence found — UNCONFIRMED | per advisory | **rule + layer — built.** Fills NHC's gap (Bay of Bengal, NW Pacific, S Indian Ocean, Australia). Winds may be 10-min (reads ~1 category low) — a stated blind spot |
| **NASA EONET "Severe Storms"** ✓ (have) | `eonet.gsfc.nasa.gov/api/v3/events?category=severeStorms` | no | NASA open data | hours | **rule — built.** Cyclone *confirmation*. Honest caveat: EONET republishes NHC/JTWC, so it is an independent pipeline, not an independent observation |
| **JTWC** | `metoc.navy.mil/jtwc` | no | U.S. military site, no licence statement, access flaky | per warning | **skip** — GDACS + EONET already carry JTWC tracks |
| **NASA GIBS VIIRS true colour** ✓ (have as basemap/snapshots) | `gibs.earthdata.nasa.gov/wmts/epsg3857/best/VIIRS_SNPP_CorrectedReflectance_TrueColor/default/default/…Level9` | no | NASA public domain; acknowledgement requested | daily | **layer — built** ("Satellite clouds"; `default` time = latest day) |
| **NASA GIBS GPM IMERG** ✓ | `…/IMERG_Precipitation_Rate_30min/default/default/…Level6` | no | NASA public domain | 30 min, ~4 h latency | **layer — built** (global satellite rain; the public-site-safe radar substitute) |
| **NASA GIBS geostationary IR** (GOES-East/West, Himawari Band 13) ✓ | `…/GOES-East_ABI_Band13_Clean_Infrared/…`, `…/Himawari_AHI_Band13_Clean_Infrared/…` | no | public domain | 10 min | **layer — next** (near-live clouds; no Meteosat layer found in the 3857 set — UNCONFIRMED) |
| **RainViewer** radar ✓ | `api.rainviewer.com/public/weather-maps.json` → `tilecache.rainviewer.com/v2/radar/{path}/256/{z}/{x}/{y}/2/1_1.png` | no | "free for personal or educational use"; credit "Weather data by RainViewer" + link; not for high-volume commercial | 10 min | **layer — local dashboard only** (`publicSafe: false`); a public site needs their written OK |
| **NOAA nowCOAST** radar (MRMS), GOES IR, lightning density | `nowcoast.noaa.gov/geoserver/observations/{weather_radar,satellite,lightning_detection}/ows` (WMS 1.1.1) | no | NOAA disclaimer; lightning is a NOAA Level-5 derived product whose public distribution is permitted (not raw Vaisala strikes) | 2–15 min | **layer — next.** Americas/Pacific only; lightning density is the only keyless lightning with clear redistribution terms |
| **Blitzortung** lightning | community network, no official API | — | data for private, non-commercial use; redistribution not permitted | seconds | **skip — licence** |
| **Soil moisture / drought** (Open-Meteo `soil_moisture_0_to_7cm…`, ERA5-Land) | same Open-Meteo APIs | no | CC BY 4.0 | hourly / daily | **rule — next.** Soil-moisture anomaly vs 1991–2020 for ≥ N weeks; confirm with GloFAS low flow or Sentinel-2 NDVI drop (have both) |
| **GloFAS** discharge ✓ (have) | `flood-api.open-meteo.com/v1/flood` | no | CC BY 4.0 (Copernicus EMS) | daily, +7 d forecast | **rule — built** as the rain confirmation (≥ 2× 2-year mean); a standalone flood rule is cheap next |
| **CAMS air quality** (have) | `air-quality-api.open-meteo.com` | no | CC BY 4.0 | hourly | **rule — next** (PM2.5 ≫ WHO for days; confirm with FIRMS smoke source or a second city station) |

## 2. Everything else GEV carries

| Source | Endpoint | Key | Licence / terms | Refresh | Verdict |
| --- | --- | --- | --- | --- | --- |
| **Global Fishing Watch API** | `gateway.api.globalfishingwatch.org` | free token | CC BY-NC 4.0 data; API terms non-commercial | ~3-day lag | **rule — later, high value:** apparent fishing inside a no-take MPA (protected_areas, have) → confirm with GFW SAR vessel detections or a later pass. Beware the name clash with Global *Forest* Watch (`src/clients/gfw.ts`) |
| **AISStream.io** (live AIS) | `wss://stream.aisstream.io` | free key | beta, no formal ToS; AIS is public broadcast | seconds | **later** — ship context for oil-spill cases (Sentinel-1 slick + nearest tanker track); WebSocket collector = real effort |
| **CelesTrak** TLEs | `celestrak.org/NORAD/elements/gp.php?GROUP=…` | no | U.S.-government origin, citation requested | daily | **layer/case context — later:** "Sentinel-2 passes here at hh:mm" on a case page. Needs SGP4 (dep) — ESA's published S1/S2 acquisition plans (KML) may be cheaper, UNCONFIRMED |
| **USGS earthquakes** (have) | `earthquake.usgs.gov/…/summary/*.geojson` | no | public domain | minutes | have (`quakes`) |
| **NASA FIRMS** (have) | `firms.modaps.eosdis.nasa.gov/api/area/csv/{key}/…` | free key | public domain | ~3 h | have (fire rules) |
| **NIFC WFIGS** fire perimeters | ArcGIS feature service (`data-nifc.opendata.arcgis.com`) | no | U.S. public domain | 5 min | **layer — next** (US only; perimeters beside FIRMS points) |
| **InciWeb** | `inciweb.wildfire.gov` | no | U.S. public incident info | hours | skip — narrative links, US only |
| **OSM dams** (OpenInfraMap) | Overpass (live) | no | ODbL (attribution + share-alike on the derived DB) | live | **layer — later** (flood/drought context; GRanD/GDW are better global dam sets, UNCONFIRMED licence) |
| **OSM datacenters** | Overpass (live) | no | ODbL | live | **layer — later, low** (energy/water demand context) |
| **Natural Earth** regions | naturalearthdata.com | no | public domain | static | **layer/text — later, cheap:** plain-language place names in titles ("Mozambique Channel") |
| **GDELT DOC 2.0** | `api.gdeltproject.org/api/v2/doc/doc` | no | free with citation + link | 15 min | **later** — news corroboration on a case, never a confirmation |
| **Google News RSS** | news.google.com/rss | no | personal, non-commercial only | — | **skip — licence** |
| **OpenSky / adsb.lol / adsbdb** flights, military flights | various | opt. | OpenSky non-commercial; adsb.lol ODbL; adsbdb route data "may not be copied" | seconds | **skip — irrelevance** (aviation emissions are better from Climate TRACE, have) |
| **Launch Library 2** | `ll.thespacedevs.com/2.3.0` | opt. | use/share, 15 calls/h anon | 15 min | **skip — irrelevance** |
| **CCTV packs** (Austin, TxDOT, Caltrans, TfL, Ontario 511, Fintraffic, DriveBC, Calgary, NSW, Tallinn, DelDOT …) | city APIs | mostly no | mixed OGL / CC BY / "public" | 10 s–10 min | **skip — privacy** (people and plates in frame) and irrelevance |
| **ALPR locations** (OSM `surveillance:type=ALPR`) | Overpass | no | ODbL | live | **skip — privacy/surveillance** is outside the mission |
| **OSM military installations** | Overpass | no | ODbL | live | **skip — irrelevance** |
| **Traffic** (TomTom), **transit** GTFS-RT, **bikeshare** GBFS, **OSRM** routing, **Radio Browser** | various | TomTom key | TomTom paid tier; others open | seconds | **skip — irrelevance/cost** |
| **Esri World Imagery**, **Google 3D Tiles / Places**, **Cesium ion** | ArcGIS / Google / Cesium | Google/ion keys | proprietary; Google content may not be cached | — | **skip — cost/licence** (GIBS + Sentinel-2 already free) |
| **TeleGeography cables**, **Bhote Koshi pack** | bundled in GEV | — | CC BY-NC(-SA) | static | **skip — licence** (non-commercial) and irrelevance |
| **Re:Earth terrain**, **Photon** geocoder | keyless | no | CC BY 4.0 / ODbL fair use | — | skip — we have Nominatim; no 3D terrain need |

## 3. Ranked by value ÷ effort

| # | Source → use | Value for the watch | Effort | Status |
| --- | --- | --- | --- | --- |
| 1 | Open-Meteo forecast + ERA5 normals → heat & rain rule, wind layer | very high (heat is the top weather killer) | low | **built** |
| 2 | NHC/CPHC + GDACS (+ EONET) → cyclone rule + cones layer | very high | low | **built** |
| 3 | GIBS VIIRS + IMERG → clouds / satellite-rain layers | high (public-site-safe) | very low | **built** |
| 4 | Open-Meteo soil moisture + ERA5-Land → drought rule | high | low (same client) | next |
| 5 | GloFAS → standalone flood rule (discharge vs return-period proxy) | high | low (have client) | next |
| 6 | GIBS geostationary IR (GOES-E/W, Himawari) → 10-min clouds | medium | very low | next |
| 7 | NOAA nowCOAST radar + lightning density → Americas layers | medium | low | next |
| 8 | Global Fishing Watch → fishing-in-MPA rule | very high | medium (key, NC licence) | later |
| 9 | CAMS → air-pollution episode rule | high | low–medium (needs a good second signal) | later |
| 10 | CelesTrak / ESA acquisition plans → "next satellite pass" on cases | medium | medium | later |

Also worth doing after these: NIFC perimeters (US fires), Natural Earth names for titles,
AISStream for oil-spill context.

## 4. What was built in this slice (2026-09-27)

- `weather_now`, `storms` tools (`src/clients/weather.ts`, `src/clients/storms.ts`,
  `src/tools/weather.ts`) with provenance blocks; `series` / `events` cards (storm cones ride
  along as `payload.stormGeoJson`).
- `weather_extreme@1.0` (`src/watch/rules/weatherExtreme.ts`, tier 0) and
  `watchlists/weather.json` (12 cities, 6 cyclone regions, per-climate thresholds).
- `web/src/layers/weather.ts` — `addLayer(map, spec)` / `mountLayerToggles(...)` for clouds,
  satellite rain, RainViewer radar (local only), wind arrows and storm cones; wired into the
  live dashboard. The public map can import the same module and pass `publicSite: true`.

Live check the same day: 7 active cyclones (Polo cat 3 and Nolo cat 1→4 forecast in the
E Pacific, Surigae cat 3 near Okinawa, Odalys cat 1, Fay, Gonzalo, TC 01B in the Bay of
Bengal) — none with a category ≥ 1 cone over the six watched regions; no city over its heat
or rain bar (closest: Kuwait City +7.0 °C today vs a +7 bar, one day only).
