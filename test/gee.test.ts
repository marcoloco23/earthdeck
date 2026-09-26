// Google Earth Engine client — offline. Response shapes are hand-made from the documented
// REST contract (value:compute → {result}; reduceRegion → {band: value|histogram}); they are
// UNCONFIRMED against the live API (no GEE credentials on the build machine, 2026-09-26).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createVerify, generateKeyPairSync } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bandNumber,
  biomassExpression,
  buildJwt,
  classShares,
  DW_CLASSES,
  GEE_SCOPE,
  GeeClient,
  landCoverExpression,
  landCoverMix,
  MAPBIOMAS_CLASSES,
  pickScale,
  population,
  populationExpression,
} from "../src/clients/gee.js";
import { geeCreds } from "../src/config.js";
import { geeDoctorLine } from "../src/doctor.js";
import { OverviewError } from "../src/errors.js";
import type { BBox } from "../src/types.js";
import { jsonResponse, mockFetch } from "./helpers.js";

const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
const creds = { clientEmail: "vital@proj.iam.gserviceaccount.com", privateKey, project: "vital-ee" };
const decode = (s: string) => JSON.parse(Buffer.from(s, "base64url").toString("utf8"));

test("gee: JWT header/claims shape and a verifiable RS256 signature", () => {
  const jwt = buildJwt(creds, 1_700_000_000);
  const [h, c, sig] = jwt.split(".");
  assert.deepEqual(decode(h!), { alg: "RS256", typ: "JWT" });
  assert.deepEqual(decode(c!), {
    iss: creds.clientEmail,
    scope: GEE_SCOPE,
    aud: "https://oauth2.googleapis.com/token",
    iat: 1_700_000_000,
    exp: 1_700_003_600,
  });
  const ok = createVerify("RSA-SHA256").update(`${h}.${c}`).verify(publicKey, Buffer.from(sig!, "base64url"));
  assert.equal(ok, true);
});

test("gee: config — inline JSON, file path, GEE_PROJECT override, absent, broken", () => {
  const key = JSON.stringify({ client_email: creds.clientEmail, private_key: privateKey, project_id: "from-key" });
  assert.equal(geeCreds({ GEE_SERVICE_ACCOUNT_JSON: key })?.project, "from-key");
  const dir = mkdtempSync(join(tmpdir(), "gee-"));
  writeFileSync(join(dir, "k.json"), key);
  assert.equal(geeCreds({ GEE_SERVICE_ACCOUNT_JSON: join(dir, "k.json"), GEE_PROJECT: "override" })?.project, "override");
  assert.equal(geeCreds({}), null);
  assert.throws(() => geeCreds({ GEE_SERVICE_ACCOUNT_JSON: "{not json" }), /GEE_SERVICE_ACCOUNT_JSON/);
  assert.match(geeDoctorLine({}), /Google Earth Engine \(gee_query\)\s+not configured/);
  assert.match(geeDoctorLine({ GEE_SERVICE_ACCOUNT_JSON: key }), /Google Earth Engine \(gee_query\)\s+configured/);
});

test("gee: land-cover expression graph (MapBiomas)", () => {
  const expr = landCoverExpression([-52, -8, -51.5, -7.5], "mapbiomas", { year: 2023 }, 30);
  assert.equal(expr.result, "0");
  const rr = (expr.values["0"] as any).functionInvocationValue;
  assert.equal(rr.functionName, "Image.reduceRegion");
  assert.deepEqual(rr.arguments.scale, { constantValue: 30 });
  assert.deepEqual(rr.arguments.bestEffort, { constantValue: true });
  assert.equal(rr.arguments.reducer.functionInvocationValue.functionName, "Reducer.frequencyHistogram");
  assert.deepEqual(rr.arguments.geometry, {
    functionInvocationValue: {
      functionName: "GeometryConstructors.Rectangle",
      arguments: { coordinates: { constantValue: [[-52, -8], [-51.5, -7.5]] }, geodesic: { constantValue: false } },
    },
  });
  const sel = rr.arguments.image.functionInvocationValue;
  assert.equal(sel.functionName, "Image.select");
  assert.deepEqual(sel.arguments.bandSelectors, { constantValue: ["classification"] });
  const json = JSON.stringify(expr);
  assert.match(json, /"projects\/mapbiomas-public\/assets\/brazil\/lulc\/v1"/);
  assert.match(json, /"leftField":\{"constantValue":"year"\},"rightValue":\{"constantValue":2023\}/);
  assert.match(json, /"leftField":\{"constantValue":"collection_id"\},"rightValue":\{"constantValue":10\}/);
});

test("gee: Dynamic World expression filters bounds + date and takes the mode", () => {
  const json = JSON.stringify(landCoverExpression([0, 0, 0.1, 0.1], "dynamic-world", { dateFrom: "2026-06-01", dateTo: "2026-09-01" }));
  assert.match(json, /"GOOGLE\/DYNAMICWORLD\/V1"/);
  assert.match(json, /"Filter.dateRangeContains"/);
  assert.match(json, /"start":\{"constantValue":"2026-06-01"\},"end":\{"constantValue":"2026-09-01"\}/);
  assert.match(json, /"Filter.intersects"/);
  assert.match(json, /"reduce.mode"/);
  assert.match(json, /"bandSelectors":\{"constantValue":\["label"\]\}/);
});

test("gee: biomass/population expressions", () => {
  const b = JSON.stringify(biomassExpression([0, 0, 1, 1]));
  assert.match(b, /LARSE\/GEDI\/GEDI04_B_002/);
  assert.match(b, /"Reducer.mean"/);
  const p = JSON.stringify(populationExpression([0, 0, 1, 1], 2019));
  assert.match(p, /WorldPop\/GP\/100m\/pop/);
  assert.match(p, /"Reducer.sum"/);
  assert.match(p, /"bestEffort":\{"constantValue":false\}/);
});

test("gee: pickScale keeps native for small boxes and coarsens big ones", () => {
  assert.equal(pickScale([0, 0, 0.05, 0.05], 10), 10);
  const s = pickScale([0, 0, 2, 2], 10); // ~49,000 km² → ≥ 70 m to stay under 1e7 px
  assert.ok(s > 60 && s < 80, String(s));
});

test("gee: class-share math from a frequencyHistogram", () => {
  const shares = classShares({ classification: { "3": 600.5, "15": 299.5, "12": 100, "999": 0 } }, "classification", MAPBIOMAS_CLASSES);
  assert.deepEqual(shares, [
    { code: 3, name: "forest_formation", sharePct: 60.1, natural: true },
    { code: 15, name: "pasture", sharePct: 30, natural: false },
    { code: 12, name: "grassland", sharePct: 10, natural: true },
  ]);
  assert.deepEqual(classShares({ label: { "42": 1 } }, "label", DW_CLASSES), [{ code: 42, name: "class_42", sharePct: 100 }]);
  assert.deepEqual(classShares({}, "label", DW_CLASSES), []);
  assert.equal(bandNumber({ MU: 123.45 }, "MU"), 123.45);
  assert.equal(bandNumber({ MU: null }, "MU"), null);
});

test("gee: client exchanges a JWT for a token, caches it, parses value:compute", async (t) => {
  const m = mockFetch((url) =>
    url.startsWith("https://oauth2.googleapis.com/token")
      ? jsonResponse({ access_token: "tok-1", expires_in: 3599, token_type: "Bearer" })
      : jsonResponse({ result: { classification: { "3": 75, "15": 25 } } }),
  );
  t.after(m.restore);
  const client = new GeeClient(creds, "https://ee.test/v1");
  const bbox: BBox = [-52, -8, -51.9, -7.9];
  const mix = await landCoverMix(bbox, "mapbiomas", {}, client);
  await landCoverMix(bbox, "mapbiomas", {}, client);
  assert.equal(mix.naturalSharePct, 75);
  assert.equal(mix.classes[1]!.name, "pasture");
  const tokenCalls = m.calls.filter((c) => c.url.includes("oauth2"));
  assert.equal(tokenCalls.length, 1);
  const form = new URLSearchParams(tokenCalls[0]!.body!);
  assert.equal(form.get("grant_type"), "urn:ietf:params:oauth:grant-type:jwt-bearer");
  assert.equal(form.get("assertion")!.split(".").length, 3);
  const compute = m.calls.find((c) => c.url.includes("value:compute"))!;
  assert.equal(compute.url, "https://ee.test/v1/projects/vital-ee/value:compute");
  assert.equal(compute.headers.authorization, "Bearer tok-1");
  assert.ok(JSON.parse(compute.body!).expression.values["0"]);
});

test("gee: refreshes once on 401 and surfaces EE error messages", async (t) => {
  let tokens = 0;
  let computes = 0;
  const m = mockFetch((url) => {
    if (url.includes("oauth2")) return jsonResponse({ access_token: `tok-${++tokens}`, expires_in: 3600 });
    computes++;
    if (computes === 1) return jsonResponse({ error: { code: 401, message: "expired" } }, { status: 401 });
    return jsonResponse({ error: { code: 400, message: "Image.load: Asset 'X' not found." } }, { status: 400 });
  });
  t.after(m.restore);
  const client = new GeeClient(creds, "https://ee.test/v1");
  await assert.rejects(client.computeValue({ result: "0", values: { "0": { constantValue: 1 } } }), (e: unknown) => {
    assert.ok(e instanceof OverviewError);
    assert.match(e.message, /Asset 'X' not found/);
    return true;
  });
  assert.equal(tokens, 2);
  assert.equal(m.calls.at(-1)!.headers.authorization, "Bearer tok-2");
});

test("gee: not configured → clean error; population bbox cap", async () => {
  const saved = process.env.GEE_SERVICE_ACCOUNT_JSON;
  delete process.env.GEE_SERVICE_ACCOUNT_JSON;
  try {
    await assert.rejects(population([0, 0, 1, 1]), /Google Earth Engine not configured/);
  } finally {
    if (saved !== undefined) process.env.GEE_SERVICE_ACCOUNT_JSON = saved;
  }
  const client = new GeeClient(creds, "https://ee.test/v1");
  await assert.rejects(population([0, 0, 3, 1], 2020, client), /≤2°/);
});
