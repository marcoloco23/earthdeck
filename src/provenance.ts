// A structured provenance block attached to every Copernicus result so the output is
// decision-support, not a bare number (VISION §5.4: "verification by default"). It records
// where the pixels came from, how they were composited, what the cloud mask removed, how
// many pixels survived, and which scenes contributed — enough for the model (or a human) to
// reason about trust and to reproduce the result.

import type { SceneInfo } from "./clients/copernicus.js";
import { maskedClassesFor, maskedClassLabels, STAT_MASK_METHOD } from "./evalscripts.js";
import type { BBox } from "./types.js";
import { nowIso } from "./util.js";

/** How a multi-scene window is collapsed into one result. */
export type CompositeMethod = "leastCC" | "median";

const MOSAICKING_TEXT: Record<CompositeMethod, string> = {
  leastCC: "leastCC",
  median: "ORBIT per-pixel median of clear observations",
};

export interface Provenance {
  /** Free, open data provider. */
  dataSource: string;
  /** Sensor + product level + native resolution. */
  sensor: string;
  /** Sentinel Hub collection id. */
  collection: string;
  /** The time window mosaicked and the ordering used to pick pixels. */
  composite: { from: string; to: string; mosaicking: string };
  /** How cloud/shadow/etc. were handled and what survived. */
  cloudMask: {
    method: string;
    /** SCL classes excluded (empty for un-masked rendered imagery). */
    excludedClasses: string[];
    /** % of pixels that survived the mask — only present for statistics. */
    validPct?: number;
  };
  /** Best-effort list of contributing scenes (ids/dates/cloud %). Omitted on lookup failure. */
  scenes?: SceneInfo[];
  bbox: BBox;
  retrievedAt: string;
  /** Decision-support framing — these outputs inform a decision, they are not the decision. */
  disclaimer: string;
}

const DATA_SOURCE = "Copernicus Data Space Ecosystem (Sentinel Hub)";
const SENSOR = "Sentinel-2 MSI, Level-2A surface reflectance, 10 m";
const COLLECTION = "sentinel-2-l2a";

const statsDisclaimer = (composite: CompositeMethod): string =>
  "Decision-support, not decision. Statistics are computed over a " +
  (composite === "median"
    ? "per-pixel temporal-median composite of all clear observations"
    : "least-cloudy composite") +
  " with cloud/shadow/cirrus pixels removed via the Sentinel-2 SCL + s2cloudless masks; check " +
  "the % valid and the contributing scenes before acting on this result.";

const imageDisclaimer = (composite: CompositeMethod): string =>
  composite === "median"
    ? "Decision-support, not decision. This is a per-pixel temporal median of the clear " +
      "observations in the window (not a single acquisition); residual cloud/haze is strongly " +
      "suppressed, but pixels with no clear observation fall back to an unmasked median. Use " +
      "eo_index for quantitative values."
    : "Decision-support, not decision. This is a least-cloudy mosaic of the window (not a single " +
      "acquisition) and rendered pixels are not per-pixel cloud-masked; residual cloud/haze may " +
      "remain. Use eo_index for masked, quantitative values.";

/**
 * Build the provenance block for a Sentinel-2 result.
 *
 * `kind: "stats"` describes a masked statistical composite (eo_index/eo_compare): it lists
 * the excluded SCL classes and the % valid. `kind: "image"` describes a rendered mosaic
 * (eo_render): pixels are not per-pixel masked, so no excluded classes / validPct.
 */
export function s2Provenance(opts: {
  bbox: BBox;
  from: string;
  to: string;
  kind: "stats" | "image";
  composite?: CompositeMethod;
  index?: string;
  validPct?: number;
  scenes?: SceneInfo[];
}): Provenance {
  const masked = opts.kind === "stats";
  const composite = opts.composite ?? "leastCC";
  const cloudMask = masked
    ? {
        method: STAT_MASK_METHOD,
        excludedClasses: maskedClassesFor(opts.index ?? "NDVI"),
        ...(opts.validPct != null ? { validPct: opts.validPct } : {}),
      }
    : composite === "median"
      ? {
          // Median renders ARE per-pixel masked (water kept — it belongs in imagery);
          // pixels with no clear observation fall back to an unmasked median.
          method:
            STAT_MASK_METHOD + " applied before the per-pixel median (open water kept); " +
            "no-clear-observation pixels fall back to an unmasked median",
          excludedClasses: maskedClassLabels(false),
        }
      : {
          method: "least-cloudy mosaic (mosaickingOrder=leastCC); no per-pixel cloud mask",
          excludedClasses: [] as string[],
        };
  const prov: Provenance = {
    dataSource: DATA_SOURCE,
    sensor: SENSOR,
    collection: COLLECTION,
    composite: { from: opts.from, to: opts.to, mosaicking: MOSAICKING_TEXT[composite] },
    cloudMask,
    bbox: opts.bbox,
    retrievedAt: nowIso(),
    disclaimer: masked ? statsDisclaimer(composite) : imageDisclaimer(composite),
  };
  if (opts.scenes && opts.scenes.length > 0) prov.scenes = opts.scenes;
  return prov;
}

const SAR_DISCLAIMER =
  "Decision-support, not decision. Sentinel-1 γ⁰ (GAMMA0, terrain-corrected) backscatter is " +
  "all-weather but speckle-prone and sensitive to incidence angle and orbit direction; compare " +
  "only like orbit directions, and treat single-scene brightness qualitatively.";

/**
 * Provenance for a Sentinel-1 SAR result. SAR is all-weather (sees through cloud/smoke/night),
 * so there is no cloud mask — `cloudMask.method` records that explicitly as the key advantage.
 */
export function sarProvenance(opts: {
  bbox: BBox;
  from: string;
  to: string;
  polarization: string;
  orbitDirection?: string;
}): Provenance {
  const method =
    `n/a — Sentinel-1 SAR is all-weather (penetrates cloud, smoke, night)` +
    `; polarization ${opts.polarization}` +
    (opts.orbitDirection ? `, ${opts.orbitDirection} orbit` : "");
  return {
    dataSource: DATA_SOURCE,
    sensor: "Sentinel-1 C-band SAR (GRD), GAMMA0 terrain-corrected, ~10 m",
    collection: "sentinel-1-grd",
    composite: { from: opts.from, to: opts.to, mosaicking: "mostRecent" },
    cloudMask: { method, excludedClasses: [] },
    bbox: opts.bbox,
    retrievedAt: nowIso(),
    disclaimer: SAR_DISCLAIMER,
  };
}
