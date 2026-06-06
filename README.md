# overview-mcp

**Give Claude eyes on Earth.** An [MCP](https://modelcontextprotocol.io) server plus a live
mission-control dashboard for satellite Earth observation — over free, open NASA and
Copernicus data. Ask Claude to look at a place and it pulls satellite imagery, computes
vegetation/water/burn indices, surfaces live wildfires and disasters, and diffs a location
across time to detect deforestation, flooding, or burn scars. As it works, a browser
dashboard lights up with what it's seeing.

> Claude is the brain; the dashboard is the canvas. The MCP best-effort streams every
> result to a local dashboard you watch live — but it works perfectly with the dashboard
> off too.

## What it can do

| Tool | What it does | Needs |
| --- | --- | --- |
| `eo_snapshot` | Quick satellite image of a bbox (NASA Worldview/GIBS, MODIS/VIIRS) — true-color, false-color, or fire overlay | — |
| `events` | Live natural-disaster events worldwide (NASA EONET): wildfires, storms, volcanoes, floods | — |
| `geo_resolve` | Turn a place name into a bounding box (OpenStreetMap) | — |
| `stac_search` | Search open satellite archives (Sentinel-2/-1, Landsat) for scenes + COG asset URLs (Earth Search STAC) | — |
| `fires_in` | Active fire / thermal-anomaly detections (NASA FIRMS), near-real-time | `FIRMS_MAP_KEY` |
| `eo_render` | High-res (10 m) Sentinel-2 imagery — trueColor / falseColor / NDVI ramp | CDSE |
| `eo_index` | NDVI / NDWI / NBR statistics over a least-cloudy Sentinel-2 composite | CDSE |
| `eo_search` | Search the Sentinel-2 archive for scenes + cloud cover | CDSE |
| `eo_compare` | Change detection: render two dates + the index delta (deforestation/flood/burn) | CDSE |

Every Copernicus result (`eo_render`/`eo_index`/`eo_compare`) carries a **provenance block**
— data source, sensor, composite window, cloud-mask method + masked classes, % valid pixels,
contributing scene IDs — so the output is decision-support you can audit, not a bare number.

The zero-key tools (`eo_snapshot`, `events`, `geo_resolve`, `stac_search`) work with no setup
at all.

## Install (Claude Code)

Add to your `.mcp.json` (or `claude mcp add`):

```json
{
  "mcpServers": {
    "overview": {
      "command": "npx",
      "args": ["-y", "github:marcoloco23/overview-mcp"],
      "env": {
        "FIRMS_MAP_KEY": "optional-firms-key",
        "CDSE_CLIENT_ID": "optional-copernicus-client-id",
        "CDSE_CLIENT_SECRET": "optional-copernicus-client-secret"
      }
    }
  }
}
```

Omit the `env` keys you don't have — the zero-key tools still work.

## The dashboard

```bash
npx -y github:marcoloco23/overview-mcp dashboard   # opens on http://localhost:5005
```

Open it in a browser, then drive the MCP from Claude. Each tool posts a "card" — imagery
overlays and the NDVI/index panels render on a MapLibre map (NASA Blue Marble basemap),
events and fires plot as markers, and `eo_compare` shows a before/after pair with the delta.
The push is best-effort: if the dashboard isn't running, tools behave exactly the same.

## Getting the free keys

- **NASA FIRMS** (`fires_in`): request a key with your email at
  <https://firms.modaps.eosdis.nasa.gov/api/map_key/> — emailed instantly.
- **Copernicus** (`eo_*`): create a free account at <https://dataspace.copernicus.eu/>, then
  Dashboard → User Settings → **OAuth clients** → Create. Copy the **client secret
  immediately** (shown once); choose "Never expire" or rotate every 90 days.

See [.env.example](.env.example) for all variables.

## Example session

> **You:** What's the NDVI around Manaus, and how has the forest changed since 2019?

Claude calls `geo_resolve("Manaus, Brazil")` → bbox, then `eo_index(bbox, "NDVI")` →
mean ≈ 0.28, then `eo_compare(bbox, "2019-08-01", "2026-06-01", "NDVI")` → renders both
dates and reports the NDVI delta. Meanwhile the dashboard shows the imagery, the index
panel, and the before/after comparison.

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

- NASA EOSDIS GIBS / Worldview, FIRMS, EONET (NASA open data).
- Copernicus Sentinel-2, via the Copernicus Data Space Ecosystem (ESA / European Union).
- Basemap & geocoding: NASA Blue Marble; OpenStreetMap Nominatim.

## Notes

This wraps documented, public, open APIs and is scoped to your own (free) credentials. It is
**observation only** — there is no satellite tasking or control here. Respect each provider's
terms and rate limits (Copernicus processing-unit quotas, FIRMS transaction limits,
Nominatim ≤1 req/s).

## License

MIT — see [LICENSE](LICENSE).
