// Pure geometry for the wind-arrow layer (no DOM, no MapLibre) — unit-tested in Node.

export interface LineFC {
  type: "FeatureCollection";
  features: Array<{ type: "Feature"; properties: { speed: number }; geometry: { type: "MultiLineString"; coordinates: Array<Array<[number, number]>> } }>;
}

/** Grid of sample points over a view, kept off the poles. */
export function windGrid(bounds: [number, number, number, number], cols: number, rows: number): Array<[number, number]> {
  const [w, s, e, n] = [Math.max(-180, bounds[0]), Math.max(-75, bounds[1]), Math.min(180, bounds[2]), Math.min(75, bounds[3])];
  const pts: Array<[number, number]> = [];
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) pts.push([Math.round((w + ((c + 0.5) * (e - w)) / cols) * 100) / 100, Math.round((s + ((r + 0.5) * (n - s)) / rows) * 100) / 100]);
  return pts;
}

/**
 * One arrow per sample: meteorological direction is where wind comes FROM, so the arrow points
 * to dir+180°. Length scales with speed (capped), relative to the grid cell.
 */
export function windArrows(samples: Array<{ lon: number; lat: number; speedKmh: number; dirDeg: number }>, cellDeg: number): LineFC {
  const features: LineFC["features"] = [];
  for (const s of samples) {
    const len = cellDeg * 0.45 * Math.min(1, 0.25 + s.speedKmh / 60);
    const to = ((s.dirDeg + 180) * Math.PI) / 180;
    const k = 1 / Math.max(0.2, Math.cos((s.lat * Math.PI) / 180)); // keep arrows visually straight
    const tip: [number, number] = [s.lon + Math.sin(to) * len * k, s.lat + Math.cos(to) * len];
    const tail: [number, number] = [s.lon - Math.sin(to) * len * k * 0.5, s.lat - Math.cos(to) * len * 0.5];
    const head = (off: number): [number, number] => [tip[0] - Math.sin(to + off) * len * 0.35 * k, tip[1] - Math.cos(to + off) * len * 0.35];
    features.push({
      type: "Feature",
      properties: { speed: Math.round(s.speedKmh) },
      geometry: { type: "MultiLineString", coordinates: [[tail, tip], [head(0.5), tip, head(-0.5)]] },
    });
  }
  return { type: "FeatureCollection", features };
}

