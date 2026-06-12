import { test } from "node:test";
import assert from "node:assert/strict";
import { lonLatToUtm, utmToLonLat, utmZone, utmZoneLabel } from "../src/utm.js";

// Truth table generated with pyproj/PROJ (EPSG:326xx/327xx, always_xy):
// [lon, lat, zone, south, easting, northing]
const TRUTH: Array<[number, number, number, boolean, number, number]> = [
  [13.41, 52.52, 33, false, 392118.4866, 5820064.6751], // Berlin
  [-60.0, -3.1, 21, true, 166507.7979, 9656881.0216], // Manaus
  [-52.0, -6.6, 22, true, 389452.093, 9270358.4894], // São Félix do Xingu
  [151.21, -33.87, 56, true, 334435.7061, 6250816.3978], // Sydney
  [-122.42, 37.77, 10, false, 551081.2998, 4180454.9025], // San Francisco
  [0.01, 0.01, 31, false, 167135.73, 1106.8174], // near equator/Greenwich
  [-179.9, 65.0, 1, false, 363283.2171, 7211591.2522], // near antimeridian
];

test("lonLatToUtm matches PROJ to < 1 cm", () => {
  for (const [lon, lat, zone, south, e, n] of TRUTH) {
    const u = lonLatToUtm(lon, lat);
    assert.equal(u.zone, zone, `${lon},${lat} zone`);
    assert.equal(u.south, south);
    assert.ok(Math.abs(u.easting - e) < 0.01, `${lon},${lat} easting ${u.easting} vs ${e}`);
    assert.ok(Math.abs(u.northing - n) < 0.01, `${lon},${lat} northing ${u.northing} vs ${n}`);
  }
});

test("utmToLonLat matches PROJ to < 1e-7 degrees", () => {
  for (const [lon, lat, zone, south, e, n] of TRUTH) {
    const g = utmToLonLat(e, n, zone, south);
    assert.ok(Math.abs(g.lon - lon) < 1e-7, `${e},${n} lon ${g.lon} vs ${lon}`);
    assert.ok(Math.abs(g.lat - lat) < 1e-7, `${e},${n} lat ${g.lat} vs ${lat}`);
  }
});

test("round-trip is stable across the globe", () => {
  for (let lon = -177; lon < 180; lon += 13.7) {
    for (let lat = -79; lat <= 79; lat += 9.3) {
      const u = lonLatToUtm(lon, lat);
      const g = utmToLonLat(u.easting, u.northing, u.zone, u.south);
      assert.ok(Math.abs(g.lon - lon) < 1e-8 && Math.abs(g.lat - lat) < 1e-8, `${lon},${lat}`);
    }
  }
});

test("central meridian maps to easting 500000 exactly", () => {
  const u = lonLatToUtm(-123, 45, 10); // zone 10 central meridian
  assert.ok(Math.abs(u.easting - 500_000) < 1e-6);
});

test("zone helpers", () => {
  assert.equal(utmZone(-180), 1);
  assert.equal(utmZone(179.9999), 60);
  assert.equal(utmZone(0), 31);
  assert.equal(utmZoneLabel(-60, -3), "21S");
  assert.equal(utmZoneLabel(13.4, 52.5), "33N");
});
