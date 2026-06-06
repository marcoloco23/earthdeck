import { test } from "node:test";
import assert from "node:assert/strict";
import { events, fires, parseFiresCsv, snapshot } from "../src/clients/nasa.js";
import type { BBox } from "../src/types.js";
import { binaryResponse, jsonResponse, mockFetch, textResponse } from "./helpers.js";

const BBOX: BBox = [-10, -20, 10, 20]; // [west, south, east, north]

const VIIRS_CSV = [
  "latitude,longitude,bright_ti4,scan,track,acq_date,acq_time,satellite,instrument,confidence,version,bright_ti5,frp,daynight",
  "-3.1,-60.0,320.5,0.5,0.5,2024-06-01,1330,N,VIIRS,n,2.0NRT,290.1,15.3,D",
  "-3.2,-60.1,341.0,0.5,0.5,2024-06-01,1330,N,VIIRS,h,2.0NRT,300.0,42.0,D",
].join("\n");

const MODIS_CSV = [
  "latitude,longitude,brightness,scan,track,acq_date,acq_time,satellite,instrument,confidence,version,bright_t31,frp,daynight",
  "-3.3,-60.2,330.1,1.0,1.0,2024-06-01,1335,Terra,MODIS,85,6.1NRT,295.0,22.0,D",
].join("\n");

test("parseFiresCsv handles VIIRS (bright_ti4 + letter confidence)", () => {
  const fires = parseFiresCsv(VIIRS_CSV);
  assert.equal(fires.length, 2);
  assert.deepEqual(
    { lat: fires[0]!.lat, lon: fires[0]!.lon, brightness: fires[0]!.brightness },
    { lat: -3.1, lon: -60.0, brightness: 320.5 },
  );
  assert.equal(fires[0]!.confidence, "nominal"); // n → nominal
  assert.equal(fires[1]!.confidence, "high"); // h → high
  assert.equal(fires[0]!.frp, 15.3);
  assert.equal(fires[0]!.satellite, "N");
});

test("parseFiresCsv handles MODIS (brightness + numeric confidence)", () => {
  const fires = parseFiresCsv(MODIS_CSV);
  assert.equal(fires.length, 1);
  assert.equal(fires[0]!.brightness, 330.1);
  assert.equal(fires[0]!.confidence, 85); // numeric kept as number
});

test("parseFiresCsv throws on a FIRMS plain-text error and skips bad rows", () => {
  assert.throws(() => parseFiresCsv("Invalid MAP_KEY. ..."), /unexpected FIRMS response/);
  // A row with non-numeric coords is skipped, not thrown.
  const csv = "latitude,longitude,frp\n-3.0,-60.0,1.0\nNA,NA,2.0\n";
  assert.equal(parseFiresCsv(csv).length, 1);
  assert.deepEqual(parseFiresCsv("").length, 0);
});

test("snapshot builds the Worldview URL with BBOX as south,west,north,east", async (t) => {
  const fetchMock = mockFetch(() => binaryResponse(Buffer.from([1, 2, 3]), "image/jpeg"));
  t.after(() => fetchMock.restore());

  const res = await snapshot(BBOX, "2024-06-01", "trueColor", 512);
  const url = new URL(fetchMock.calls[0]!.url);
  assert.equal(url.searchParams.get("BBOX"), "-20,-10,20,10"); // S,W,N,E
  assert.equal(url.searchParams.get("TIME"), "2024-06-01");
  assert.equal(url.searchParams.get("CRS"), "EPSG:4326");
  assert.ok(url.searchParams.get("LAYERS")!.includes("VIIRS_SNPP_CorrectedReflectance_TrueColor"));
  assert.equal(res.mimeType, "image/jpeg");
  assert.equal(res.dataBase64, Buffer.from([1, 2, 3]).toString("base64"));
});

test("snapshot rejects an unknown layer and a non-image response", async (t) => {
  await assert.rejects(() => snapshot(BBOX, "2024-06-01", "nope"), /unknown layer 'nope'/);

  const fetchMock = mockFetch(() => textResponse("rate limited", { status: 429 }));
  t.after(() => fetchMock.restore());
  await assert.rejects(() => snapshot(BBOX, "2024-06-01", "trueColor"), /Worldview snapshot failed \(429/);
});

test("events sends bbox as west,north,east,south and normalizes the payload", async (t) => {
  const fetchMock = mockFetch(() =>
    jsonResponse({
      events: [
        {
          id: "EV1",
          title: "Tropical Storm Amanda",
          link: "https://x/EV1",
          categories: [{ id: "severeStorms", title: "Severe Storms" }],
          geometry: [{ date: "2024-05-30T00:00:00Z", type: "Point", coordinates: [-90.1, 13.2] }],
        },
      ],
    }),
  );
  t.after(() => fetchMock.restore());

  const out = await events({ bbox: BBOX, days: 20, status: "open" });
  const url = new URL(fetchMock.calls[0]!.url);
  assert.equal(url.searchParams.get("bbox"), "-10,20,10,-20"); // W,N,E,S
  assert.equal(url.searchParams.get("days"), "20");
  assert.equal(url.searchParams.get("status"), "open");

  assert.equal(out.length, 1);
  assert.equal(out[0]!.category, "Severe Storms");
  assert.deepEqual(out[0]!.coordinates, [-90.1, 13.2]);
  assert.equal(out[0]!.closed, false);
});

test("fires builds the FIRMS area URL (west,south,east,north) and clamps dayRange", async (t) => {
  const fetchMock = mockFetch(() => textResponse(VIIRS_CSV));
  t.after(() => fetchMock.restore());

  const out = await fires("MAPKEY", BBOX, { source: "VIIRS_SNPP_NRT", dayRange: 99 });
  const url = fetchMock.calls[0]!.url;
  assert.ok(url.includes("/MAPKEY/VIIRS_SNPP_NRT/-10,-20,10,20/10"), `dayRange clamped to 10: ${url}`);
  assert.equal(out.length, 2);
});

test("fires surfaces an HTTP error", async (t) => {
  const fetchMock = mockFetch(() => textResponse("Invalid MAP_KEY", { status: 401 }));
  t.after(() => fetchMock.restore());
  await assert.rejects(() => fires("BAD", BBOX), /FIRMS request failed \(401\)/);
});
