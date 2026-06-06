// A structured provenance block attached to every Copernicus result so the output is
// decision-support, not a bare number (VISION §5.4: "verification by default"). It records
// where the pixels came from, how they were composited, what the cloud mask removed, how
// many pixels survived, and which scenes contributed — enough for the model (or a human) to
// reason about trust and to reproduce the result.

import type { SceneInfo } from "./clients/copernicus.js";
import { maskedClassesFor } from "./evalscripts.js";
import type { BBox } from "./types.js";
import { nowIso } from "./util.js";

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

const STATS_DISCLAIMER =
  "Decision-support, not decision. Statistics are computed over a least-cloudy composite " +
  "with cloud/shadow/cirrus pixels removed via the Sentinel-2 SCL mask; check the % valid " +
  "and the contributing scenes before acting on this result.";

const IMAGE_DISCLAIMER =
  "Decision-support, not decision. This is a least-cloudy mosaic of the window (not a single " +
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
  index?: string;
  validPct?: number;
  scenes?: SceneInfo[];
}): Provenance {
  const masked = opts.kind === "stats";
  const cloudMask = masked
    ? {
        method: "Sentinel-2 Scene Classification (SCL) per-pixel mask",
        excludedClasses: maskedClassesFor(opts.index ?? "NDVI"),
        ...(opts.validPct != null ? { validPct: opts.validPct } : {}),
      }
    : {
        method: "least-cloudy mosaic (mosaickingOrder=leastCC); no per-pixel cloud mask",
        excludedClasses: [] as string[],
      };
  const prov: Provenance = {
    dataSource: DATA_SOURCE,
    sensor: SENSOR,
    collection: COLLECTION,
    composite: { from: opts.from, to: opts.to, mosaicking: "leastCC" },
    cloudMask,
    bbox: opts.bbox,
    retrievedAt: nowIso(),
    disclaimer: masked ? STATS_DISCLAIMER : IMAGE_DISCLAIMER,
  };
  if (opts.scenes && opts.scenes.length > 0) prov.scenes = opts.scenes;
  return prov;
}
