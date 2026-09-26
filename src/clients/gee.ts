// Google Earth Engine REST client — no SDK, no new deps.
//
// Auth: OAuth2 service-account flow (RFC 7523 JWT bearer). We sign an RS256 JWT with the
// key's PEM via node:crypto and trade it at https://oauth2.googleapis.com/token for a 1 h
// access token (cached, concurrent refreshes de-duped, one retry on 401).
//
// Compute: POST {base}/projects/{project}/value:compute  body {expression}  → {result}.
// `expression` is EE's serialized computation graph (the same thing the Python/JS clients
// send; see python/ee/serializer.py in google/earthengine-api):
//
//   Expression = { result: "<key>", values: { "<key>": ValueNode, ... } }
//   ValueNode  = { constantValue: <JSON> }
//              | { functionInvocationValue: { functionName: "<Algorithm>", arguments: { <name>: ValueNode } } }
//              | { arrayValue: { values: ValueNode[] } }
//              | { dictionaryValue: { values: { <k>: ValueNode } } }
//              | { valueReference: "<key>" }          (shared sub-graphs; we inline instead)
//
// We emit one inlined tree under key "0" — simpler than the client's de-duplicated form and
// equally valid. Algorithm names/argument names follow the public client serialization
// (ImageCollection.load, Collection.filter, Filter.dateRangeContains, Filter.intersects,
// Filter.equals, reduce.mode, ImageCollection.mosaic, Image.select, Image.reduceRegion,
// Reducer.frequencyHistogram/mean/sum, GeometryConstructors.Rectangle).
// UNCONFIRMED against the live API (no credentials on the build machine, 2026-09-26).

import { createSign } from "node:crypto";
import { geeApiBase, geeCreds, USER_AGENT, type GeeCreds } from "../config.js";
import { OverviewError } from "../errors.js";
import type { BBox } from "../types.js";
import { assertBBox } from "../util.js";
import { bboxAreaKm2 } from "./protected.js";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GEE_SCOPE = "https://www.googleapis.com/auth/earthengine";

// ------------------------------------------------------------------------------ auth

const b64url = (s: string | Buffer) => Buffer.from(s).toString("base64url");

/** Pure: the signed service-account assertion (header.claims.signature, RS256). */
export function buildJwt(creds: Pick<GeeCreds, "clientEmail" | "privateKey">, nowSec: number, scope = GEE_SCOPE): string {
  const header = { alg: "RS256", typ: "JWT" };
  const claims = { iss: creds.clientEmail, scope, aud: TOKEN_URL, iat: nowSec, exp: nowSec + 3600 };
  const unsigned = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
  const sig = createSign("RSA-SHA256").update(unsigned).sign(creds.privateKey);
  return `${unsigned}.${b64url(sig)}`;
}

// ------------------------------------------------------------------ expression graph

export type ValueNode =
  | { constantValue: unknown }
  | { functionInvocationValue: { functionName: string; arguments: Record<string, ValueNode> } }
  | { arrayValue: { values: ValueNode[] } }
  | { dictionaryValue: { values: Record<string, ValueNode> } }
  | { valueReference: string };

export interface Expression {
  result: string;
  values: Record<string, ValueNode>;
}

export const k = (v: unknown): ValueNode => ({ constantValue: v });
export const call = (functionName: string, args: Record<string, ValueNode> = {}): ValueNode => ({
  functionInvocationValue: { functionName, arguments: args },
});
export const expression = (root: ValueNode): Expression => ({ result: "0", values: { "0": root } });

export const ee = {
  rect: ([w, s, e, n]: BBox) =>
    call("GeometryConstructors.Rectangle", { coordinates: k([[w, s], [e, n]]), geodesic: k(false) }),
  image: (id: string) => call("Image.load", { id: k(id) }),
  collection: (id: string) => call("ImageCollection.load", { id: k(id) }),
  filter: (collection: ValueNode, filter: ValueNode) => call("Collection.filter", { collection, filter }),
  dateFilter: (start: string, end: string) =>
    call("Filter.dateRangeContains", {
      leftValue: call("DateRange", { start: k(start), end: k(end) }),
      rightField: k("system:time_start"),
    }),
  boundsFilter: (geometry: ValueNode) =>
    call("Filter.intersects", { leftField: k(".all"), rightValue: call("Feature", { geometry }) }),
  eqFilter: (name: string, value: unknown) => call("Filter.equals", { leftField: k(name), rightValue: k(value) }),
  mode: (collection: ValueNode) => call("reduce.mode", { collection }),
  mosaic: (collection: ValueNode) => call("ImageCollection.mosaic", { collection }),
  select: (input: ValueNode, bands: string[]) => call("Image.select", { input, bandSelectors: k(bands) }),
  reducer: (name: "frequencyHistogram" | "mean" | "sum") => call(`Reducer.${name}`),
  reduceRegion: (image: ValueNode, reducer: ValueNode, geometry: ValueNode, scale: number, bestEffort: boolean) =>
    call("Image.reduceRegion", {
      image,
      reducer,
      geometry,
      scale: k(scale),
      maxPixels: k(1e10),
      bestEffort: k(bestEffort),
    }),
};

// ---------------------------------------------------------------------------- client

export class GeeClient {
  private token: string | null = null;
  private expiresAt = 0;
  private inflight: Promise<string> | null = null;

  constructor(
    private readonly creds: GeeCreds,
    private readonly base = geeApiBase(),
  ) {}

  private async getToken(force = false): Promise<string> {
    if (!force && this.token && Date.now() < this.expiresAt - 60_000) return this.token;
    if (this.inflight) return this.inflight;
    this.inflight = this.fetchToken().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async fetchToken(): Promise<string> {
    const assertion = buildJwt(this.creds, Math.floor(Date.now() / 1000));
    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "user-agent": USER_AGENT },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }).toString(),
    });
    const text = await res.text();
    if (!res.ok) throw new OverviewError(`Earth Engine auth failed (${res.status})`, res.status, text.slice(0, 300));
    const j = JSON.parse(text) as { access_token: string; expires_in?: number };
    this.token = j.access_token;
    this.expiresAt = Date.now() + (j.expires_in ?? 3600) * 1000;
    return this.token;
  }

  /** POST value:compute and return the `result` JSON. */
  async computeValue(expr: Expression): Promise<unknown> {
    const url = `${this.base}/projects/${encodeURIComponent(this.creds.project)}/value:compute`;
    const send = async (token: string) =>
      fetch(url, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "user-agent": USER_AGENT },
        body: JSON.stringify({ expression: expr }),
      });
    let res = await send(await this.getToken());
    if (res.status === 401) res = await send(await this.getToken(true));
    const text = await res.text();
    if (res.status === 429) {
      throw new OverviewError("Earth Engine quota/rate limit hit (429) — wait, or check the project's EECU tier", 429, text.slice(0, 300));
    }
    if (!res.ok) {
      // EE errors are {error: {code, message, status}} — surface the message (e.g. "Image.load: asset not found").
      let msg = text.slice(0, 300);
      try {
        msg = (JSON.parse(text) as { error?: { message?: string } }).error?.message ?? msg;
      } catch {
        /* non-JSON body */
      }
      throw new OverviewError(`Earth Engine compute failed (${res.status}): ${msg}`, res.status, text.slice(0, 500));
    }
    return (JSON.parse(text) as { result?: unknown }).result;
  }
}

let shared: GeeClient | null = null;

/** Lazily-built client from env; clean "not configured" error when keys are absent. */
export function geeClient(): GeeClient {
  if (shared) return shared;
  const creds = geeCreds();
  if (!creds) {
    throw new OverviewError(
      "Google Earth Engine not configured — set GEE_SERVICE_ACCOUNT_JSON (key file path or inline JSON) and GEE_PROJECT (a Cloud project registered for Earth Engine)",
    );
  }
  shared = new GeeClient(creds);
  return shared;
}

// --------------------------------------------------------------------------- datasets

export type LandCoverDataset = "dynamic-world" | "mapbiomas" | "worldcover";

interface ClassDef {
  name: string;
  natural?: boolean; // MapBiomas only: native vegetation / natural non-forest vs. anthropic use
}

export const DW_CLASSES: Record<number, ClassDef> = {
  0: { name: "water" }, 1: { name: "trees" }, 2: { name: "grass" }, 3: { name: "flooded_vegetation" },
  4: { name: "crops" }, 5: { name: "shrub_and_scrub" }, 6: { name: "built" }, 7: { name: "bare" }, 8: { name: "snow_and_ice" },
};

export const WORLDCOVER_CLASSES: Record<number, ClassDef> = {
  10: { name: "tree_cover" }, 20: { name: "shrubland" }, 30: { name: "grassland" }, 40: { name: "cropland" },
  50: { name: "built_up" }, 60: { name: "bare_sparse_vegetation" }, 70: { name: "snow_and_ice" }, 80: { name: "permanent_water" },
  90: { name: "herbaceous_wetland" }, 95: { name: "mangroves" }, 100: { name: "moss_and_lichen" },
};

// MapBiomas Brazil Collection 10 legend (level-3/4 codes). Pasture (15) is separate from
// natural Grassland (12) — the distinction a generic LULC map cannot make. Rarer codes UNCONFIRMED.
export const MAPBIOMAS_CLASSES: Record<number, ClassDef> = {
  3: { name: "forest_formation", natural: true }, 4: { name: "savanna_formation", natural: true },
  5: { name: "mangrove", natural: true }, 6: { name: "floodable_forest", natural: true },
  49: { name: "wooded_sandbank_vegetation", natural: true }, 11: { name: "wetland", natural: true },
  12: { name: "grassland", natural: true }, 32: { name: "hypersaline_tidal_flat", natural: true },
  29: { name: "rocky_outcrop", natural: true }, 50: { name: "herbaceous_sandbank_vegetation", natural: true },
  13: { name: "other_non_forest_formation", natural: true },
  15: { name: "pasture", natural: false }, 9: { name: "forest_plantation", natural: false },
  19: { name: "temporary_crop", natural: false }, 39: { name: "soybean", natural: false },
  20: { name: "sugar_cane", natural: false }, 40: { name: "rice", natural: false }, 62: { name: "cotton", natural: false },
  41: { name: "other_temporary_crops", natural: false }, 36: { name: "perennial_crop", natural: false },
  46: { name: "coffee", natural: false }, 47: { name: "citrus", natural: false }, 35: { name: "palm_oil", natural: false },
  48: { name: "other_perennial_crops", natural: false }, 21: { name: "mosaic_of_uses", natural: false },
  23: { name: "beach_dune_sand", natural: true }, 24: { name: "urban_area", natural: false },
  30: { name: "mining", natural: false }, 75: { name: "photovoltaic_power_plant", natural: false },
  25: { name: "other_non_vegetated", natural: false }, 33: { name: "river_lake_ocean" },
  31: { name: "aquaculture", natural: false }, 27: { name: "not_observed" },
};

export const GEE_SOURCES = {
  "dynamic-world": "Dynamic World V1 (GOOGLE/DYNAMICWORLD/V1), Google + WRI, 10 m, CC-BY 4.0 — contains modified Copernicus Sentinel data",
  mapbiomas: "MapBiomas Brazil Collection 10 (projects/mapbiomas-public/assets/brazil/lulc/v1), 30 m, CC-BY 4.0",
  worldcover: "ESA WorldCover 10 m 2021 v200 (ESA/WorldCover/v200), CC-BY 4.0 — © ESA WorldCover project / Copernicus",
  biomass: "GEDI L4B gridded aboveground biomass density v2 (LARSE/GEDI/GEDI04_B_002), 1 km, 2019-04→2021-08, public domain (NASA/UMD)",
  population: "WorldPop Global Project 100 m (WorldPop/GP/100m/pop), CC-BY 4.0",
} as const;

const NATIVE_SCALE: Record<LandCoverDataset, number> = { "dynamic-world": 10, mapbiomas: 30, worldcover: 10 };
const MAX_PIXELS = 1e7; // per interactive reduceRegion — keeps EECU cost small and under the 5-min online limit

/** Pure: smallest scale (m) ≥ native that keeps the bbox under `maxPixels`. */
export function pickScale(bbox: BBox, native: number, maxPixels = MAX_PIXELS): number {
  const areaM2 = bboxAreaKm2(bbox) * 1e6;
  return Math.max(native, Math.ceil(Math.sqrt(areaM2 / maxPixels)));
}

export interface LandCoverOpts {
  year?: number; // mapbiomas (1985–2024, default 2024)
  dateFrom?: string; // dynamic-world window (default: last 90 days)
  dateTo?: string;
}

/** Pure: the reduceRegion(frequencyHistogram) expression for one land-cover dataset. */
export function landCoverExpression(bbox: BBox, dataset: LandCoverDataset, opts: LandCoverOpts = {}, scale = pickScale(bbox, NATIVE_SCALE[dataset])): Expression {
  const geom = ee.rect(bbox);
  let img: ValueNode;
  if (dataset === "dynamic-world") {
    const to = opts.dateTo ?? new Date().toISOString().slice(0, 10);
    const from = opts.dateFrom ?? new Date(Date.parse(to) - 90 * 86_400_000).toISOString().slice(0, 10);
    const coll = ee.filter(ee.filter(ee.collection("GOOGLE/DYNAMICWORLD/V1"), ee.boundsFilter(geom)), ee.dateFilter(from, to));
    // Per-pixel most-common label over the window (standard DW compositing).
    img = ee.select(ee.mode(coll), ["label"]);
  } else if (dataset === "mapbiomas") {
    const year = opts.year ?? 2024;
    const coll = ee.filter(
      ee.filter(ee.collection("projects/mapbiomas-public/assets/brazil/lulc/v1"), ee.eqFilter("collection_id", 10)),
      ee.eqFilter("year", year),
    );
    img = ee.select(ee.mosaic(coll), ["classification"]);
  } else {
    img = ee.select(ee.mosaic(ee.collection("ESA/WorldCover/v200")), ["Map"]);
  }
  return expression(ee.reduceRegion(img, ee.reducer("frequencyHistogram"), geom, scale, true));
}

export interface ClassShare {
  code: number;
  name: string;
  sharePct: number;
  natural?: boolean;
}

/**
 * Pure: turn a reduceRegion frequencyHistogram result ({band: {"<code>": weightedCount}})
 * into sorted class shares. Weights are fractional (partial-pixel coverage); unknown codes
 * are kept as "class_<code>".
 */
export function classShares(result: unknown, band: string, classes: Record<number, ClassDef>): ClassShare[] {
  const hist = (result as Record<string, unknown> | null)?.[band];
  if (!hist || typeof hist !== "object") return [];
  const entries = Object.entries(hist as Record<string, unknown>)
    .map(([c, v]) => [Number(c), Number(v)] as const)
    .filter(([c, v]) => Number.isFinite(c) && Number.isFinite(v) && v > 0);
  const total = entries.reduce((a, [, v]) => a + v, 0);
  if (total === 0) return [];
  return entries
    .map(([code, v]) => {
      const def = classes[code];
      const share: ClassShare = { code, name: def?.name ?? `class_${code}`, sharePct: Math.round((v / total) * 1000) / 10 };
      if (def?.natural !== undefined) share.natural = def.natural;
      return share;
    })
    .sort((a, b) => b.sharePct - a.sharePct);
}

const BAND: Record<LandCoverDataset, string> = { "dynamic-world": "label", mapbiomas: "classification", worldcover: "Map" };
const CLASSES: Record<LandCoverDataset, Record<number, ClassDef>> = {
  "dynamic-world": DW_CLASSES,
  mapbiomas: MAPBIOMAS_CLASSES,
  worldcover: WORLDCOVER_CLASSES,
};

export interface LandCoverMix {
  dataset: LandCoverDataset;
  scaleM: number;
  classes: ClassShare[];
  naturalSharePct: number | null; // MapBiomas only
  source: string;
}

export async function landCoverMix(bbox: BBox, dataset: LandCoverDataset, opts: LandCoverOpts = {}, client = geeClient()): Promise<LandCoverMix> {
  assertBBox(bbox);
  const scaleM = pickScale(bbox, NATIVE_SCALE[dataset]);
  const result = await client.computeValue(landCoverExpression(bbox, dataset, opts, scaleM));
  const classes = classShares(result, BAND[dataset], CLASSES[dataset]);
  if (classes.length === 0) throw new OverviewError(`${dataset}: no classified pixels in the bbox (outside coverage, or no scenes in the window)`);
  const naturalSharePct =
    dataset === "mapbiomas"
      ? Math.round(classes.filter((c) => c.natural).reduce((a, c) => a + c.sharePct, 0) * 10) / 10
      : null;
  return { dataset, scaleM, classes, naturalSharePct, source: GEE_SOURCES[dataset] };
}

/** Pure: GEDI L4B mean AGBD (band MU, Mg/ha = t/ha) over the bbox at its 1 km grid. */
export function biomassExpression(bbox: BBox): Expression {
  const img = ee.select(ee.image("LARSE/GEDI/GEDI04_B_002"), ["MU"]);
  return expression(ee.reduceRegion(img, ee.reducer("mean"), ee.rect(bbox), 1000, true));
}

/** Pure: WorldPop count summed at native ~92.77 m (no bestEffort: coarsening would bias a sum). */
export function populationExpression(bbox: BBox, year = 2020): Expression {
  const coll = ee.filter(ee.collection("WorldPop/GP/100m/pop"), ee.eqFilter("year", year));
  const img = ee.select(ee.mosaic(coll), ["population"]);
  return expression(ee.reduceRegion(img, ee.reducer("sum"), ee.rect(bbox), 92.77, false));
}

/** Pure: pull one numeric band value out of a reduceRegion result dict. */
export function bandNumber(result: unknown, band: string): number | null {
  const v = (result as Record<string, unknown> | null)?.[band];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

export async function biomass(bbox: BBox, client = geeClient()) {
  assertBBox(bbox);
  const meanAgbTHa = bandNumber(await client.computeValue(biomassExpression(bbox)), "MU");
  return { meanAgbTHa: meanAgbTHa === null ? null : Math.round(meanAgbTHa * 10) / 10, scaleM: 1000, source: GEE_SOURCES.biomass };
}

export const POPULATION_MAX_DEG = 2;

export async function population(bbox: BBox, year = 2020, client = geeClient()) {
  assertBBox(bbox);
  if (bbox[2] - bbox[0] > POPULATION_MAX_DEG || bbox[3] - bbox[1] > POPULATION_MAX_DEG) {
    throw new OverviewError(`population: bbox must be ≤${POPULATION_MAX_DEG}° per side (summed at native 100 m)`);
  }
  const sum = bandNumber(await client.computeValue(populationExpression(bbox, year)), "population");
  return { year, people: sum === null ? null : Math.round(sum), scaleM: 92.77, source: GEE_SOURCES.population };
}
