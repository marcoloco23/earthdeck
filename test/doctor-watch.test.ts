// `earthdeck doctor` Watch section — offline: temp ledger, temp watchlists, injected env.

import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { watchChecks } from "../src/doctor.js";
import { seedDemo } from "../src/ledger/cli.js";
import { Ledger } from "../src/ledger/store.js";

const tmp = () => mkdtempSync(join(tmpdir(), "earthdeck-doctor-"));

test("doctor watch: empty setup — nothing created, rules report missing keys", () => {
  const root = tmp();
  const { lines, failed } = watchChecks({ ledgerDir: join(root, "ledger"), watchlistsPath: join(root, "wl"), env: {} });
  assert.equal(failed, false);
  assert.match(lines[0]!, /^    · Ledger\s+not created yet/);
  assert.ok(lines.some((l) => /^    · Rule forest_loss\s+missing GFW_API_KEY, CDSE_CLIENT_ID, CDSE_CLIENT_SECRET — sweeps skip it$/.test(l)));
  assert.ok(lines.some((l) => /^    · Rule fires_in_protected\s+missing FIRMS_MAP_KEY/.test(l)));
  assert.ok(lines.some((l) => /^    · Watchlists\s+none at/.test(l)));
  assert.match(lines[lines.length - 1]!, /^    · Last sweep\s+none yet$/);
});

test("doctor watch: seeded ledger, keys, repo watchlists, heartbeat", () => {
  const dir = tmp();
  seedDemo(Ledger.open(dir));
  mkdirSync(join(dir, "watch"));
  writeFileSync(join(dir, "watch", "heartbeat.json"), JSON.stringify({ sweepId: "s1", at: "2026-09-26T10:00:00.000Z", pairs: 4, created: 1, confirmed: 1, gaps: 0, skipped: 2, dryRun: false }));
  const env = { GFW_API_KEY: "k", CDSE_CLIENT_ID: "i", CDSE_CLIENT_SECRET: "s", FIRMS_MAP_KEY: "f" };
  const { lines, failed } = watchChecks({ ledgerDir: dir, watchlistsPath: "watchlists", env, now: Date.parse("2026-09-26T13:00:00Z") });
  assert.equal(failed, false, lines.join("\n"));
  assert.match(lines[0]!, /^    ✓ Ledger\s+.* — 8 entries, 3 findings, [\d.]+ KB, verify OK$/);
  assert.ok(lines.some((l) => /^    ✓ Rule forest_loss\s+keys present \(GFW_API_KEY, CDSE_CLIENT_ID, CDSE_CLIENT_SECRET\)$/.test(l)));
  assert.ok(lines.some((l) => /^    ✓ Watchlists\s+\d+ watchlist\(s\), \d+ AOIs \(\d+ control\)/.test(l)));
  assert.match(lines[lines.length - 1]!, /^    ✓ Last sweep\s+2026-09-26T10:00:00.000Z \(3.0 h ago\) — 4 pairs, 1 opened, 1 confirmed, 0 gaps, 2 skipped$/);
});

test("doctor watch: tampered ledger and invalid watchlist fail", () => {
  const dir = tmp();
  seedDemo(Ledger.open(dir));
  appendFileSync(join(dir, "entries.jsonl"), "{}\n");
  const wl = tmp();
  writeFileSync(join(wl, "bad.json"), JSON.stringify({ version: 1, name: "x", aois: [] }));
  const { lines, failed } = watchChecks({ ledgerDir: dir, watchlistsPath: wl, env: {} });
  assert.equal(failed, true);
  assert.match(lines[0]!, /^    ✗ Ledger\s+.*verify FAILED: /);
  assert.ok(lines.some((l) => /^    ✗ Watchlists\s+invalid: /.test(l)));
});
