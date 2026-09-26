// The dashboard's read-only ledger surface: feeds only show public statuses, the
// checkpoint and tiles are served as static files, and proofs come back per finding.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ledger } from "../src/ledger/store.js";
import { seedDemo } from "../src/ledger/cli.js";
import { LedgerView } from "../src/dashboard/ledger-view.js";

test("ledger view: api, feeds, checkpoint, tiles", async () => {
  const dir = mkdtempSync(join(tmpdir(), "earthdeck-view-"));
  const view = new LedgerView(dir);
  // No ledger yet → empty, not an error.
  assert.deepEqual(JSON.parse(String((await view.handle("/api/ledger")).body)).findings, []);
  assert.equal((await view.handle("/ledger/checkpoint")).status, 404);

  const n = seedDemo(Ledger.open(dir));
  assert.equal(n, 8);
  const all = JSON.parse(String((await view.handle("/api/ledger")).body));
  assert.equal(all.size, 8);
  assert.equal(all.findings.length, 3);
  const byStatus = JSON.parse(String((await view.handle("/api/ledger?status=candidate")).body));
  assert.equal(byStatus.findings.length, 1);

  // Only the published/notified finding is in the public feeds.
  const feed = JSON.parse(String((await view.handle("/feed.json")).body));
  assert.equal(feed.count, 1);
  assert.equal(feed.findings[0].status, "notified");
  assert.ok(feed.checkpoint.startsWith("earthdeck.dev/findings/v1\n8\n"));
  const geo = JSON.parse(String((await view.handle("/feed.geojson")).body));
  assert.equal(geo.type, "FeatureCollection");
  assert.equal(geo.features.length, 1);
  assert.equal(geo.features[0].geometry.type, "Polygon");

  // One finding with events + an inclusion proof that verifies against the root.
  const one = JSON.parse(String((await view.handle(`/api/ledger/${feed.findings[0].findingId}`)).body));
  assert.equal(one.events.length, 5);
  assert.equal(one.inclusion.index, 4);
  assert.equal(one.inclusion.size, 8);
  assert.equal((await view.handle("/api/ledger/nope")).status, 404);

  // Static verification surface.
  assert.equal((await view.handle("/ledger/pub")).status, 200);
  assert.equal((await view.handle("/ledger/entries.jsonl")).status, 200);
  const tile = await view.handle("/ledger/tile/0/000.p/8");
  assert.equal(tile.status, 200);
  assert.equal((tile.body as Buffer).length, 8 * 32);
  assert.equal(tile.headers?.["cache-control"], "no-cache");
  assert.equal((await view.handle("/ledger/tile/../ledger.key")).status, 404);
  assert.equal((await view.handle("/ledger/tile/0/999")).status, 404);
});
