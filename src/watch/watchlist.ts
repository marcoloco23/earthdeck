// Watchlists are plain JSON a contributor can PR: which places, which rules, which
// thresholds. Control AOIs (expected quiet) ride along so the ledger measures our own
// false-positive rate, not just the world's problems.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { assertBBox } from "../util.js";
import type { BBox } from "../types.js";

export const watchAoi = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{1,63}$/, "id: lowercase letters, digits, dashes"),
  name: z.string().min(1).max(120),
  bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]),
  tags: z.array(z.string().max(40)).max(20).default([]),
  /** Expected-quiet area: any finding here counts against the rule's error rate. */
  control: z.boolean().default(false),
  /** Days after which a new sweep may open a *new* finding instead of adding evidence. */
  cooldownDays: z.number().int().min(1).max(365).default(30),
  rules: z.array(z.object({ name: z.string().min(1), params: z.record(z.string(), z.unknown()).default({}) })).min(1),
  notes: z.string().max(1000).optional(),
});
export type WatchAoi = z.infer<typeof watchAoi>;

export const watchlist = z.object({
  version: z.literal(1),
  name: z.string().min(1),
  description: z.string().max(2000).optional(),
  aois: z.array(watchAoi).min(1),
});
export type Watchlist = z.infer<typeof watchlist>;

export function parseWatchlist(json: unknown, where = "watchlist"): Watchlist {
  const wl = watchlist.parse(json);
  const seen = new Set<string>();
  for (const a of wl.aois) {
    assertBBox(a.bbox as BBox);
    if (seen.has(a.id)) throw new Error(`${where}: duplicate AOI id ${a.id}`);
    seen.add(a.id);
  }
  return wl;
}

/** Load one file or every `*.json` in a directory (`_*.json`, e.g. discover's `_summary.json`, is metadata — skipped). */
export function loadWatchlists(path: string): Watchlist[] {
  const st = statSync(path);
  const files = st.isDirectory()
    ? readdirSync(path)
        .filter((f) => f.endsWith(".json") && !f.startsWith("_"))
        .sort()
        .map((f) => join(path, f))
    : [path];
  return files.map((f) => parseWatchlist(JSON.parse(readFileSync(f, "utf8")), f));
}
