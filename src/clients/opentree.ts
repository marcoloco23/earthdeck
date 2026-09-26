// Open Tree of Life — taxonomic name resolution (TNRS) to OpenTree Taxonomy (OTT) ids, the
// join key into the synthetic tree of life. Public, zero-key, CC0 (OTT) —
// https://github.com/OpenTreeOfLife/germinator/wiki/TNRS-API-v3 . Live-verified 2026-09-26:
// POST /v3/tnrs/match_names {"names": [...]} → results[].matches[].taxon.ott_id.

import { USER_AGENT } from "../config.js";
import { OverviewError } from "../errors.js";

export const OPENTREE_TNRS = "https://api.opentreeoflife.org/v3/tnrs/match_names";

export interface OttMatch {
  ottId: number;
  name: string;
  rank: string | null;
  score: number;
  isSynonym: boolean;
  url: string;
}

/** Best exact-ish match from a match_names response (highest score, non-suppressed). */
export function parseTnrs(json: unknown): OttMatch | null {
  const results = (json as { results?: Array<{ matches?: Array<Record<string, unknown>> }> })?.results;
  if (!Array.isArray(results)) throw new OverviewError("unexpected OpenTree TNRS response shape");
  const matches = results[0]?.matches ?? [];
  const best = [...matches]
    .filter((m) => typeof (m.taxon as { ott_id?: unknown })?.ott_id === "number")
    .sort((a, b) => Number(b.score ?? 0) - Number(a.score ?? 0))[0];
  if (!best) return null;
  const taxon = best.taxon as { ott_id: number; name?: string; rank?: string };
  return {
    ottId: taxon.ott_id,
    name: taxon.name ?? String(best.matched_name ?? ""),
    rank: taxon.rank ?? null,
    score: Number(best.score ?? 0),
    isSynonym: best.is_synonym === true,
    url: `https://tree.opentreeoflife.org/taxonomy/browse?id=${taxon.ott_id}`,
  };
}

export async function ottMatch(name: string): Promise<OttMatch | null> {
  const res = await fetch(OPENTREE_TNRS, {
    method: "POST",
    headers: { "user-agent": USER_AGENT, "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ names: [name], do_approximate_matching: false }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new OverviewError(`OpenTree TNRS failed (${res.status})`, res.status, body.slice(0, 300));
  }
  return parseTnrs(await res.json());
}
