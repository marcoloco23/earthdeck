// Place names for discovered AOIs: Nominatim `reverse` on a cluster centroid → county / state /
// country (admin levels only — see parseReverseGeocode). Results are cached by rounded point in
// `<out>/_places.json`, so a re-run asks Nominatim only for new centroids and names stay put.
// Nominatim ToS: ≤ 1 request/second with a descriptive User-Agent (DiscoverHttp sends ours);
// at most MAX_PLACE_CALLS per run. A failed or skipped lookup falls back to a coordinate name.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseReverseGeocode, reverseGeocodeUrl, type AdminPlace } from "../../clients/geo.js";
import type { DiscoverHttp } from "./http.js";

export const PLACE_ZOOM = 8;
export const MAX_PLACE_CALLS = 120;
export const PLACES_FILE = "_places.json";

export const placeKey = (lat: number, lon: number) => `${lat.toFixed(3)},${lon.toFixed(3)}`;

export class PlaceNamer {
  private last = 0;
  calls = 0;
  failures: string[] = [];
  constructor(
    private readonly http: DiscoverHttp,
    readonly cache: Record<string, AdminPlace> = {},
    private readonly opts: { delayMs?: number; maxCalls?: number } = {},
  ) {}

  static load(dir: string): Record<string, AdminPlace> {
    const f = join(dir, PLACES_FILE);
    if (!existsSync(f)) return {};
    try {
      const j = JSON.parse(readFileSync(f, "utf8")) as { places?: Record<string, AdminPlace> };
      return j.places ?? {};
    } catch {
      return {};
    }
  }

  save(dir: string): void {
    const places = Object.fromEntries(Object.entries(this.cache).sort(([a], [b]) => a.localeCompare(b)));
    const note = `Nominatim reverse (zoom ${PLACE_ZOOM}) admin levels per rounded centroid — © OpenStreetMap contributors, ODbL. Cache for \`earthdeck discover\`; delete an entry to re-ask.`;
    writeFileSync(join(dir, PLACES_FILE), JSON.stringify({ note, places }, null, 2) + "\n");
  }

  /** County/state/country at a point, or null (budget spent / lookup failed — never throws). */
  async at(lat: number, lon: number): Promise<AdminPlace | null> {
    const key = placeKey(lat, lon);
    if (key in this.cache) return this.cache[key]!;
    if (this.calls >= (this.opts.maxCalls ?? MAX_PLACE_CALLS)) return null;
    const wait = this.last + (this.opts.delayMs ?? 1100) - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    this.calls++;
    try {
      const p = parseReverseGeocode(await this.http.json("nominatim", reverseGeocodeUrl(lat, lon, PLACE_ZOOM)));
      this.cache[key] = p;
      return p;
    } catch (err) {
      this.failures.push(`${key}: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    } finally {
      this.last = Date.now();
    }
  }
}
