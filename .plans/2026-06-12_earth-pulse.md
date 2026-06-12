# Plan — Earth Pulse: the planetary indicators layer

**Date**: 2026-06-12 · **Status**: in progress

## Goal

Grow earthdeck from "satellite imagery + events" into the **data layer for the Earth
system**: ocean temperatures over time (El Niño tracking), CO₂, the global temperature
record, sea ice, earthquakes, air quality, river discharge, and per-place climate history —
all free/no-key, all with **historic time series** (trends matter), all visualized on the
dashboard via a new time-series chart card. VISION §6 pillar 1 ("Observe — fuse with
non-satellite feeds") pulled forward; the agent gets the *interconnected system*, not pixels.

## Data sources (all live-grounded 2026-06-12, zero keys)

| Source | Endpoint | Coverage |
| --- | --- | --- |
| ENSO / ONI | `cpc.ncep.noaa.gov/data/indices/oni.ascii.txt` | 1950→now, seasonal (official El Niño index) |
| Ocean SST | ERDDAP griddap `coastwatch.pfeg.noaa.gov/erddap/griddap/ncdcOisst21Agg_LonPM180.json` | 1981-09→now−~2wk, daily 0.25°, stride + `(last)` |
| CO₂ | `gml.noaa.gov/webdata/ccgg/trends/co2/co2_mm_mlo.txt` | 1958→now (432 ppm May 2026) |
| Global temp | `data.giss.nasa.gov/gistemp/tabledata_v4/GLB.Ts+dSST.csv` | 1880→now monthly anomaly (`***` = missing) |
| Sea ice | NSIDC G02135 **v4.0** daily CSV + 1981–2010 climatology CSV (north/south) | 1978→yesterday |
| Earthquakes | USGS FDSN `earthquake.usgs.gov/fdsnws/event/1/query?format=geojson` | real-time |
| Climate history | Open-Meteo `archive-api.open-meteo.com/v1/archive` (ERA5) | 1940→now daily, any point |
| Air quality | Open-Meteo `air-quality-api.open-meteo.com/v1/air-quality` | hourly PM2.5/PM10/O₃/NO₂ |
| River discharge | Open-Meteo `flood-api.open-meteo.com/v1/flood` (GloFAS) | 1984→now daily |

Notes: Open-Meteo marine SST history only reaches ~2022 → use ERDDAP OISST for long series.
ONI phase rule: ≥5 consecutive overlapping seasons at ≥+0.5 °C (El Niño) / ≤−0.5 (La Niña).

## Approach

- **Shared series model** `{ label, unit, points: [{t, v|null}] }` in `src/types.ts` +
  `src/series.ts` pure helpers: `linearTrend` (per decade), `decimate(maxN)`,
  `monthlyMean`, `annualMean`, `summarize`. All offline-testable.
- **Clients** (parsers pure + exported for tests): `clients/indicators.ts` (ONI + ensoPhase,
  CO₂, GISTEMP, NSIDC sea ice + climatology), `clients/erddap.ts` (OISST point series,
  auto-stride to ≤400 pts, clamp end to dataset `(last)`), `clients/openmeteo.ts` (archive /
  air-quality / flood), `clients/usgs.ts` (quake GeoJSON → normalized).
- **Tools** (10 new, → 22 total): `tools/ocean.ts` → `enso`, `ocean_temp`;
  `tools/indicators.ts` → `co2`, `global_temp`, `sea_ice`, `planet_pulse` (composite
  state-of-the-planet); `tools/climate.ts` → `climate_history`, `air_quality`,
  `river_discharge`; `tools/quakes.ts` → `quakes`. Every result carries `source` +
  attribution + period + trend where meaningful.
- **Dashboard**: 3 new card types — `series` (hand-rolled SVG line chart in
  `web/src/chart.ts`, no new deps; multi-line + threshold lines), `quakes` (map circle
  layer scaled by magnitude + list), `pulse` (headline metric grid). Extend server
  `CARD_TYPES` allow-list, web types, cards.ts, map.ts, main.ts dispatch.
- **Caps**: series decimated ≤400 points/line before card push and before tool return;
  bounded request windows; graceful 429/error messages; descriptive User-Agent everywhere.

## Steps

1. ✅ Live-ground all endpoints (curl) — shapes recorded above.
2. `src/series.ts` + types; offline tests.
3. Clients + parsers; offline tests with real-shaped fixtures.
4. Tools ×10; register in `index.ts`; update server instructions text.
5. Dashboard: chart.ts, card renderers, quake layer, pulse card, CARD_TYPES.
6. `pnpm build && pnpm typecheck && pnpm test`; live-drive all 10 via MCP client; screenshot dashboard.
7. Docs (README tool table, ROADMAP contract, CONTINUITY, PROGRESS) + commit.

## Files

- new: `src/series.ts`, `src/clients/{indicators,erddap,openmeteo,usgs}.ts`,
  `src/tools/{ocean,indicators,climate,quakes}.ts`, `web/src/chart.ts`,
  `test/{series,indicators,erddap,openmeteo,usgs}.test.ts`
- edit: `src/types.ts`, `src/index.ts`, `src/dashboard/server.ts` (CARD_TYPES),
  `web/src/{types,cards,map,main,styles.css}`, README/ROADMAP/CONTINUITY/PROGRESS
