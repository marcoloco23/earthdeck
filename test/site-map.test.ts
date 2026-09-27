// The public site's interactive map, pure parts: view state ⇄ URL hash (fail-closed, clamped),
// the time-window + layer filter and window stats, keyless search (coordinates + bundled places),
// the fly-to easing, and the export-side api/map.json projection.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_VIEW,
  EASE_IN_OUT,
  decodeView,
  encodeView,
  endMsOf,
  firstDay,
  inWindow,
  isVisible,
  parseCoords,
  search,
  windowStats,
  type MapCase,
  type MapPlace,
  type View,
} from "../web/src/site/map/model.js";
import { groupOf, mapData } from "../src/watch/map-data.js";
import type { Finding } from "../src/ledger/schema.js";

const mk = (id: string, observedAt: string, over: Partial<MapCase> = {}): MapCase => ({
  id,
  title: `Case ${id}`,
  status: "published",
  statusLabel: "Published",
  group: "published",
  kind: "forest",
  place: null,
  meta: "",
  lon: 0,
  lat: 0,
  bbox: [0, 0, 0, 0],
  observedAt,
  firstSeen: observedAt,
  geometry: { type: "Point", coordinates: [0, 0] },
  ...over,
});

test("URL state: round-trips, omits defaults, restores only what it holds", () => {
  const v: View = {
    ...DEFAULT_VIEW,
    center: [-52.07, -6.67],
    zoom: 9.5,
    pitch: 40,
    bearing: -30,
    groups: ["published", "dropped"],
    kinds: ["forest", "methane"],
    win: 90,
    end: "2026-09-01",
    sel: "01994a2e-0000-7000-8000-00000000d001",
    overlays: ["imagery"],
  };
  const h = encodeView(v);
  assert.ok(h.startsWith("#map:v=1&"));
  assert.deepEqual({ ...DEFAULT_VIEW, ...decodeView(h) }, v);
  // Defaults stay out of the link.
  assert.equal(encodeView(DEFAULT_VIEW), "#map:v=1&c=-20,12&z=1.35");
  assert.deepEqual(decodeView("#map:v=1&z=3"), { zoom: 3 });
});

test("URL state: fail closed and clamped — hostile or foreign hashes never half-apply", () => {
  assert.equal(decodeView("#challenge"), null, "anchors on the page are not map state");
  assert.equal(decodeView(""), null);
  assert.equal(decodeView("#map:v=2&z=3"), null, "unknown version");
  assert.equal(decodeView(`#map:v=1&s=${"a".repeat(500)}`), null, "length cap");
  const d = decodeView("#map:v=1&c=Infinity,1&z=99&p=90&b=270&g=px&k=ff&w=45&t=2026-13-40&s=<script>&o=z")!;
  assert.equal(d.center, undefined, "non-finite centre drops the camera");
  assert.equal(d.zoom, 18);
  assert.equal(d.pitch, 60);
  assert.equal(d.bearing, -90, "bearing wraps");
  for (const k of ["groups", "kinds", "win", "end", "sel", "overlays"] as const) assert.equal(d[k], undefined, `${k} with a bad token is dropped whole`);
  assert.deepEqual(decodeView("#map:v=1&c=190,89")!.center, [-170, 85], "lon wraps, lat clamps to the globe's range");
  assert.deepEqual(decodeView("#map:v=1&g=")!.groups, [], "an explicitly empty layer set is valid");
  // Writing clamps too.
  assert.match(encodeView({ ...DEFAULT_VIEW, zoom: 40, pitch: -5, sel: "../../etc" }), /^#map:v=1&c=-20,12&z=18$/);
});

test("time window + layer filter", () => {
  const end = endMsOf({ end: null }, "2026-09-27T08:00:00Z");
  assert.equal(end, Date.parse("2026-09-27T08:00:00Z"));
  assert.equal(endMsOf({ end: "2026-09-01" }, "2026-09-27T08:00:00Z"), Date.parse("2026-09-02T00:00:00Z") - 1, "a chosen day includes all of it");
  assert.ok(inWindow("2026-09-20T00:00:00Z", 30, end));
  assert.ok(!inWindow("2026-08-01T00:00:00Z", 30, end));
  assert.ok(inWindow("2026-08-01T00:00:00Z", 90, end));
  assert.ok(inWindow("2020-01-01T00:00:00Z", 0, end), "window 0 = everything up to the end");
  assert.ok(!inWindow("2026-09-28T00:00:00Z", 0, end), "nothing from after the end");
  assert.ok(!inWindow("not a date", 0, end));

  const c = mk("a", "2026-09-20T00:00:00Z", { group: "checking", kind: "fire" });
  const v = { groups: DEFAULT_VIEW.groups, kinds: DEFAULT_VIEW.kinds, win: 30 as const };
  assert.ok(isVisible(c, v, end));
  assert.ok(!isVisible(c, { ...v, groups: ["published"] }, end), "status layer off");
  assert.ok(!isVisible(c, { ...v, kinds: ["forest"] }, end), "case type off");
  assert.ok(!isVisible(mk("b", "2026-09-20T00:00:00Z", { group: "dropped" }), v, end), "false alarms are off by default");
});

test("window stats: published, false alarms of decided, per window", () => {
  const cases = [
    mk("p1", "2026-09-20T00:00:00Z"),
    mk("p2", "2026-05-01T00:00:00Z"),
    mk("fp", "2026-09-10T00:00:00Z", { status: "false_positive", group: "dropped" }),
    mk("cand", "2026-09-25T00:00:00Z", { status: "candidate", group: "checking" }),
    mk("conf", "2026-09-26T00:00:00Z", { status: "confirmed", group: "checking" }),
    mk("exp", "2026-09-26T00:00:00Z", { status: "expired", group: "dropped" }),
  ];
  const end = Date.parse("2026-09-27T00:00:00Z");
  assert.deepEqual(windowStats(cases, 30, end), { published: 1, falsePositives: 1, decided: 3, total: 5 });
  assert.deepEqual(windowStats(cases, 0, end), { published: 2, falsePositives: 1, decided: 4, total: 6 });
  assert.equal(firstDay(cases), "2026-05-01");
  assert.equal(firstDay([]), null);
});

test("coordinate parsing: decimal degrees, signs or hemisphere letters, strict", () => {
  assert.deepEqual(parseCoords("-6.6, -51.9"), { lat: -6.6, lon: -51.9 });
  assert.deepEqual(parseCoords("-6.6 -51.9"), { lat: -6.6, lon: -51.9 });
  assert.deepEqual(parseCoords("−6.6; −51.9"), { lat: -6.6, lon: -51.9 }, "unicode minus");
  assert.deepEqual(parseCoords("6.6S 51.9W"), { lat: -6.6, lon: -51.9 });
  assert.deepEqual(parseCoords("6.6°S, 51.9°W"), { lat: -6.6, lon: -51.9 });
  assert.deepEqual(parseCoords("W51.9 S6.6"), { lat: -6.6, lon: -51.9 }, "letters make any order unambiguous");
  assert.deepEqual(parseCoords("51.9E 6.6"), { lat: 6.6, lon: 51.9 });
  for (const bad of ["", "xingu", "6.6", "1 2 3", "-6.6S 51.9W", "6.6N 7.1N", "95, 10", "10, 190", "6.6, 51.9 km", "1e3, 2"]) assert.equal(parseCoords(bad), null, bad);
});

test("keyless search: coordinates, then watched places, then cases — diacritics folded", () => {
  const places: MapPlace[] = [
    { id: "br-sfx", name: "São Félix do Xingu", lon: -52, lat: -6.7, bbox: [-52.2, -6.8, -51.9, -6.6] },
    { id: "br-kayapo", name: "TI Kayapó", lon: -52.9, lat: -7.9, bbox: [-53, -8, -52.8, -7.8] },
  ];
  const cases = [mk("c1", "2026-09-01T00:00:00Z", { title: "Forest loss, São Félix do Xingu", place: "São Félix do Xingu" })];
  assert.deepEqual(search("4.43N 7.17E", places, cases).map((h) => [h.kind, h.label]), [["coord", "4.4300° N, 7.1700° E"]]);
  const hits = search("sao felix", places, cases);
  assert.deepEqual(hits.map((h) => h.kind), ["place", "case"], "places rank above cases of the same name");
  assert.equal(hits[1]!.id, "c1");
  assert.deepEqual(search("kayapo", places, cases).map((h) => h.label), ["TI Kayapó"]);
  assert.deepEqual(search("x", places, cases), [], "one letter is not a query");
  assert.deepEqual(search("nowhere", places, cases), []);
});

test("fly-to easing matches the site's --ease-in-out", () => {
  assert.equal(EASE_IN_OUT(0), 0);
  assert.equal(EASE_IN_OUT(1), 1);
  let prev = 0;
  for (let t = 0.05; t <= 1; t += 0.05) {
    assert.ok(EASE_IN_OUT(t) >= prev, "monotonic");
    prev = EASE_IN_OUT(t);
  }
  assert.ok(EASE_IN_OUT(0.2) < 0.05 && EASE_IN_OUT(0.8) > 0.95, "strong in-out: slow start, long settle");
  assert.ok(Math.abs(EASE_IN_OUT(0.5) - 0.596) < 0.01, "cubic-bezier(0.77, 0, 0.175, 1) at the midpoint");
});

test("export side: api/map.json projection — groups, types, coarse fires, public points only", () => {
  const base = {
    tier: 1,
    summary: "s",
    evidence: [] as Finding["evidence"],
    confirmed: null,
    aoi: { id: "a1", name: "Somewhere" },
  };
  const f = (id: string, rule: string, status: string, extra: Partial<Finding> = {}) =>
    ({
      ...base,
      findingId: id,
      rule: { name: rule, version: "1.0" },
      status,
      title: `T ${id}`,
      geometry: { type: "Point", coordinates: [10, 10] },
      bbox: [9, 9, 11, 11],
      observedAt: "2026-09-01T00:00:00Z",
      ...extra,
    }) as unknown as Finding;
  const stopped = f("s", "flaring_stopped", "candidate", {
    evidence: [
      {
        id: "e",
        kind: "alert",
        source: "firms",
        datetime: "2026-08-01T00:00:00Z",
        method: { name: "flaring_stopped", version: "1.0", params: { stoppedSites: [[1.123456, 2.5], ["x", 1]] } },
      },
    ],
  } as Partial<Finding>);
  const d = mapData([f("a", "forest_loss", "published"), f("b", "fires_in_protected", "candidate"), f("c", "methane_anomaly", "false_positive"), stopped, f("z", "whatever", "expired", { bbox: [NaN, 0, 1, 1] } as Partial<Finding>)], new Date("2026-09-27T00:00:00Z"));
  assert.equal(d.v, 1);
  assert.deepEqual(d.cases.map((c) => [c.id, c.group, c.kind]), [
    ["a", "published", "forest"],
    ["b", "checking", "fire"],
    ["c", "dropped", "methane"],
    ["s", "checking", "flaring-stopped"],
  ], "a finding without a usable bbox is left off the map");
  assert.deepEqual(d.cases.find((c) => c.id === "s")!.points, [[1.1235, 2.5]], "only well-formed registry points, rounded");
  assert.equal(d.cases.find((c) => c.id === "s")!.firstSeen, "2026-08-01T00:00:00Z");
  assert.equal(d.cases.find((c) => c.id === "b")!.points, undefined, "fire cases carry no detection points");
  assert.deepEqual(d.places, [{ id: "a1", name: "Somewhere", lon: 10, lat: 10, bbox: [9, 9, 11, 11] }]);
  assert.equal(groupOf("retracted"), "published", "a withdrawn case stays on the public record");
});
