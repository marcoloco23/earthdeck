import { test } from "node:test";
import assert from "node:assert/strict";
import { geocode } from "../src/clients/geo.js";
import { jsonResponse, mockFetch, textResponse } from "./helpers.js";

test("geocode maps Nominatim boundingbox [S,N,W,E] to our bbox [W,S,E,N]", async (t) => {
  const fetchMock = mockFetch(() =>
    jsonResponse([
      {
        display_name: "Manaus, Amazonas, Brazil",
        lat: "-3.1",
        lon: "-60.0",
        boundingbox: ["-3.3", "-2.9", "-60.2", "-59.8"], // S, N, W, E
      },
    ]),
  );
  t.after(() => fetchMock.restore());

  const place = await geocode("Manaus, Brazil");
  assert.deepEqual(place.bbox, [-60.2, -3.3, -59.8, -2.9]); // W, S, E, N
  assert.deepEqual(place.center, [-60.0, -3.1]); // lon, lat
  assert.equal(place.displayName, "Manaus, Amazonas, Brazil");

  // Sends a descriptive User-Agent (Nominatim ToS) and limit=1.
  const call = fetchMock.calls[0]!;
  assert.match(call.headers["user-agent"] ?? "", /overview-mcp/);
  assert.ok(new URL(call.url).searchParams.get("q") === "Manaus, Brazil");
  assert.equal(new URL(call.url).searchParams.get("limit"), "1");
});

test("geocode throws when there is no match", async (t) => {
  const fetchMock = mockFetch(() => jsonResponse([]));
  t.after(() => fetchMock.restore());
  await assert.rejects(() => geocode("asdfqwer"), /No match for "asdfqwer"/);
});

test("geocode surfaces an HTTP error", async (t) => {
  const fetchMock = mockFetch(() => textResponse("nope", { status: 503 }));
  t.after(() => fetchMock.restore());
  await assert.rejects(() => geocode("Manaus"), /Nominatim geocoding failed \(503\)/);
});
