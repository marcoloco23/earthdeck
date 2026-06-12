# Plan: `eo_similar` — AlphaEarth embeddings, "find everywhere that looks like this"

**Date**: 2026-06-13
**Status**: COMPLETED
**Phase**: Horizon 2 — the planet becomes searchable (item 1)

## Goal

`eo_similar(refLon, refLat, searchBbox, …)`: take the AlphaEarth Foundations 64-d embedding
at a reference location and rank every cell of a search area by cosine similarity —
zero-key, no GEE account, no GPU — with a similarity-heatmap card on the dashboard.

## Background (all grounded live, 2026-06-13)

ROADMAP Horizon 2: "AlphaEarth Satellite Embedding (CC-BY, no GPU) → eo_similar".
The GEE-only story is over: the full dataset (2017–2025) is mirrored as **open COGs on
Source Cooperative** (`https://data.source.coop/tge-labs/aef/v1/annual/…`, CC-BY 4.0,
no auth; also AWS Open Data `s3://aef-source`). Verified by direct probing:

- **Files**: `{year}/{zone}/{eeImageName}-{yOff}-{xOff}.tiff` — 8192×8192 px, 10 m, UTM
  per-zone CRS. BigTIFF, **bottom-up** (ModelTransformation y-scale +10 — handle via the
  matrix, never assume top-down; GDAL chokes, hence the provided .vrt sidecars).
- **Bands**: 64 (A00–A63), int8, **planar=2** (band-separate tiles), tiles 1024×1024,
  **compression 50000 = ZSTD**. NoData −128. Dequantize: `sign(v)·(v/127.5)²` → unit-norm
  64-vectors.
- **Overviews**: 4096² → … → 1×1; overview pixels are **mean embeddings renormalized to
  unit length** — i.e. every overview pixel is itself a valid embedding. Coarse similarity
  search comes for free; no need to touch 10 m data.
- **Index**: `aef_index.csv` (798 MB — too big to download) lists every file with path,
  crs, UTM + WGS84 bounds. Verified row order: **zone-major (1N…60N, 1S…60S, numeric),
  year ascending within zone** → a (zone, year) section can be located by **binary search
  with HTTP range requests** (~15 × 32 KB reads), then stream that section (~0.7–4 MB)
  once and cache in-process. Zero new "index" deps; the giant WKT column is skipped
  (numeric wgs84_* columns suffice).
- **License**: CC-BY 4.0 — provenance must carry "The AlphaEarth Foundations Satellite
  Embedding dataset is produced by Google and Google DeepMind."

## Approach

Option A: GEE REST API (`computePixels`) — needs a Google Cloud project + service account
+ EE registration per user. Heavy setup, against the zero-key ethos.
Option B: read the Source Cooperative COGs directly — zero keys, HTTP range reads only.
**Decision**: B. One new pinned dep: `fzstd` (pure-JS zstd *decompress*, tiny) because
node:zlib only gained zstd in Node 22.15+ and we support Node ≥20. A purpose-built
mini-BigTIFF reader (~250 lines, asserts this dataset's exact invariants, fails loud on
anything else) instead of geotiff.js — geotiff is a big dep and its handling of bottom-up
COGs is exactly what the dataset README warns about.

Search shape (v1):
- Default cell ≈ 320 m (overview level 256²; 8192/256=32× downsample). `cellM` selectable
  {160, 320, 640}. Reference embedding read at the same level → robust "this place" vector.
- Search bbox capped (≤ ~2.5 deg² and ≤4 COG files per year) — clear tile-your-AOI error.
- Similarity = dot product (unit vectors) → [−1, 1]. Return top-k cells (lon/lat centers,
  similarity, file provenance), full-grid stats (mean/p95), and push a `similar` card:
  GeoJSON circle layer, color-ramped by similarity, plus the ref marker.
- WGS84↔UTM math hand-rolled (`src/utm.ts`, Krüger series both directions, unit-tested
  against epsg.io truth) — zero proj dependency.

## Implementation steps

- [x] `src/utm.ts` — Krüger both directions; matches PROJ to <1 cm (truth table in test)
- [x] `src/clients/aef.ts` — as designed; plus coalesced tile range reads, 5xx retry with
      backoff, bounded-concurrency pool (mirror dislikes bursts)
- [x] `src/tools/similar.ts` — eo_similar (tool #26); spatial-thinned top-k; 8-file cap
- [x] dashboard: `similar` card (renderer + color-ramped heatmap layer + ref ring)
- [x] tests: 15 new (utm ×5, aef ×10 incl. synthetic in-memory bottom-up BigTIFF) → 130 green
- [x] README (tool row + CC-BY attribution) + `fzstd@0.1.1` pinned
- [x] LIVE VERIFIED (2026-06-13): urban ref (-60.02,-3.10) → all top-10 on the Manaus city
      grid, ref cell sim = 1.0, area mean 0.42 (8 files, 43 694 cells, 42 s cold);
      river ref (-60.25,-3.18) → top-8 all along the Rio Negro. Heatmap card pushed.

## Files to create / modify

| File | Change |
| --- | --- |
| `src/utm.ts` | WGS84↔UTM (new) |
| `src/clients/aef.ts` | index lookup + COG reader (new) |
| `src/tools/similar.ts` | eo_similar (new, tool #26) |
| `src/index.ts`, `src/dashboard/server.ts`, `src/types.ts` | register + card type |
| `web/src/{types,cards,map,main}.ts`, `styles.css` | similar card + heatmap layer |
| `test/utm.test.ts`, `test/aef.test.ts` | new suites |
| `package.json` | `fzstd` (pinned) |

## Risks / edge cases

- Tile bytes at coarse overviews are small, but 64 bands × N tiles must be pooled/parallel
  and capped; per-call budget documented in the tool description.
- Search bboxes spanning UTM zones / >4 files → v1 rejects with a clear message.
- Quantization noise on overview "unit" vectors → renormalize after dequantize, always.
- Ref point in masked (nodata) pixels → clear error suggesting a nearby point/larger cell.
- Antimeridian bboxes unsupported (index polygons are zone-clipped anyway).

## Definition of done

- [ ] builds + typechecks; offline suite green (synthetic fixture, no network)
- [ ] live: a real similarity search over Manaus with sensible ranking + dashboard heatmap
- [ ] CONTINUITY/PROGRESS/ROADMAP updated

## Notes / log

- 2026-06-13: dataset fully grounded (layout, IFDs, transform, ordering of the 798 MB
  index CSV). Plan written; implementation started.
- 2026-06-13 (later): shipped + live-verified. Found live: mirror 5xx under parallel
  multi-MB bursts (→ retry + pool(3)); corner bboxes legitimately touch 8 files (cap raised
  4→8); index sections ~40-70 s cold per zone pair, cached per-process after.
