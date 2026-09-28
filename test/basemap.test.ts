// The shared zoom-dependent basemap (web/src/layers/basemap.ts), pure parts: which layers are
// usable with the keys at hand, the zoom crossfade, the "what imagery is this" caption, the GIBS day.

import { test } from "node:test";
import assert from "node:assert/strict";
import { activeAt, availableBasemaps, basemaps, basemapStyle, captionAt, gibsDay, knockOutNoData, liveDays, opacityFor } from "../web/src/layers/basemap.js";

const NOW = new Date("2026-09-27T12:00:00Z");

test("basemap config: keyed layers are skipped without their key, filled in with it", () => {
  const all = basemaps(NOW);
  assert.deepEqual(all.map((b) => b.id), ["bm-gibs", "bm-eox", "bm-esri"]);
  assert.equal(all[2]!.requiresKey, "ARCGIS_API_KEY");
  assert.deepEqual(availableBasemaps(all).map((b) => b.id), ["bm-gibs", "bm-eox"], "keyless by default");
  assert.deepEqual(availableBasemaps(all, { ARCGIS_API_KEY: "  " }).map((b) => b.id), ["bm-gibs", "bm-eox"], "a blank key is no key");
  const withKey = availableBasemaps(all, { ARCGIS_API_KEY: "a b&c" });
  assert.deepEqual(withKey.map((b) => b.id), ["bm-gibs", "bm-eox", "bm-esri"]);
  assert.match(withKey[2]!.tiles[0]!, /token=a%20b%26c$/, "the key is URL-encoded into the template");
  assert.ok(!all.some((b) => b.tiles.some((t) => t.includes("token=a"))), "the config itself is never mutated");
});

test("basemap config: tile URLs, native max zooms and the EOX attribution", () => {
  const [gibs, eox] = basemaps(NOW);
  assert.equal(gibs!.tiles[0], "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/VIIRS_SNPP_CorrectedReflectance_TrueColor/default/2026-09-26/GoogleMapsCompatible_Level9/{z}/{y}/{x}.jpg");
  assert.equal(gibs!.maxzoom, 9, "Level9 tile matrix — overzoom past it, no 404s");
  assert.equal(eox!.tiles[0], "https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2025_3857/default/g/{z}/{y}/{x}.jpg");
  assert.equal(eox!.maxzoom, 14, "10 m Sentinel-2 ≈ z14");
  assert.match(eox!.attribution, /EOxCloudless https:\/\/cloudless\.eox\.at by EOX IT Services GmbH \(Contains modified Copernicus Sentinel data 2025\)/);
});

test("crossfade: opacity ramps over the fade span; the base is always opaque", () => {
  const [gibs, eox] = basemaps(NOW);
  assert.equal(opacityFor(gibs!), 1);
  assert.deepEqual(opacityFor(eox!), ["interpolate", ["linear"], ["zoom"], 6, 0, 8, 1]);
  const style = basemapStyle({ now: NOW });
  const layer = (id: string) => style.layers.find((l) => l.id === id)!;
  assert.equal(layer("bm-eox").minzoom, 6, "EOX is not fetched before its fade starts");
  assert.equal(layer("bm-gibs").maxzoom, 9, "GIBS stops drawing once EOX is fully opaque");
  assert.equal(layer("bm-eox").maxzoom, undefined, "no keyed layer above: EOX runs to the deepest zoom (overzoomed)");
  const keyed = basemapStyle({ now: NOW, keys: { ARCGIS_API_KEY: "k" } });
  assert.equal(keyed.layers.find((l) => l.id === "bm-eox")!.maxzoom, 16, "…or hands over to the keyed layer");
  // Imagery first, then roads, then place names on top.
  const ids = style.layers.map((l) => l.id);
  assert.ok(ids.indexOf("bm-eox") < ids.indexOf("bm-roads") && ids.indexOf("bm-roads") < ids.indexOf("bm-city"));
  assert.equal((style.sources["bm-ofm"] as { url?: string }).url, "https://tiles.openfreemap.org/planet");
  assert.equal(style.glyphs, "https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf");
});

test("caption by zoom: today-ish NASA view zoomed out, the dated mosaic zoomed in", () => {
  const list = availableBasemaps(basemaps(NOW));
  assert.equal(captionAt(2, list), "Daily satellite view, Sep 26 (NASA)");
  assert.equal(captionAt(6.9, list), "Daily satellite view, Sep 26 (NASA)");
  assert.equal(captionAt(7, list), "Cloud-free mosaic, Sentinel-2 2025 (EOX)", "switches at the middle of the fade");
  assert.equal(captionAt(13, list), "Cloud-free mosaic, Sentinel-2 2025 (EOX)");
  const keyed = availableBasemaps(basemaps(NOW), { ARCGIS_API_KEY: "k" });
  assert.equal(activeAt(15, keyed)!.id, "bm-esri");
  assert.equal(captionAt(3, []), "");
});

test("GIBS day: the last complete UTC day", () => {
  assert.equal(gibsDay(new Date("2026-09-27T12:00:00Z")), "2026-09-26");
  assert.equal(gibsDay(new Date("2026-09-27T03:00:00Z")), "2026-09-25", "early UTC: yesterday's last passes may still be processing");
  assert.equal(gibsDay(new Date("2026-03-01T08:00:00Z")), "2026-02-28");
});

test("live days: the partial days above the complete base day, oldest first", () => {
  assert.deepEqual(liveDays(new Date("2026-09-27T12:00:00Z")), ["2026-09-27"]);
  assert.deepEqual(liveDays(new Date("2026-09-27T03:00:00Z")), ["2026-09-26", "2026-09-27"], "before 06 UTC yesterday is partial too");
  assert.deepEqual(liveDays(new Date("2026-03-01T00:30:00Z")), ["2026-02-28", "2026-03-01"]);
});

test("live imagery: today's passes sit right above the base, same zoom span; caption says today", () => {
  const style = basemapStyle({ now: NOW, live: true });
  const ids = style.layers.map((l) => l.id);
  assert.deepEqual(ids.slice(0, 4), ["bm-gibs", "bm-live-2026-09-27-VIIRS_SNPP", "bm-live-2026-09-27-VIIRS_NOAA20", "bm-eox"]);
  const overlay = style.layers[1]!;
  assert.equal(overlay.maxzoom, 9, "fetched no deeper than the base");
  assert.equal(
    (style.sources[overlay.id] as { tiles: string[] }).tiles[0],
    "gibs-live://gibs.earthdata.nasa.gov/wmts/epsg3857/best/VIIRS_SNPP_CorrectedReflectance_TrueColor/default/2026-09-27/GoogleMapsCompatible_Level9/{z}/{y}/{x}.jpg",
  );
  assert.equal(captionAt(2, basemaps(NOW, true)), "Satellite view today (NASA), rest from Sep 26");
  assert.ok(!basemapStyle({ now: NOW }).layers.some((l) => l.id.startsWith("bm-live")), "off unless the browser can do it");
});

test("knockOutNoData: black (with JPEG noise) goes transparent, dark ocean stays", () => {
  const px = new Uint8ClampedArray([0, 0, 0, 255, 6, 3, 8, 255, 12, 20, 45, 255, 200, 200, 200, 255]);
  assert.equal(knockOutNoData(px), 2);
  assert.deepEqual([px[3], px[7], px[11], px[15]], [0, 0, 255, 255]);
});
