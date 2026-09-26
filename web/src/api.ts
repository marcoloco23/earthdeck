// Where the web code reads the ledger from. The live dashboard asks the local server
// (`/api/ledger`, …); the public static site (`earthdeck watch export`) serves the same
// bodies as plain files relative to each page (`../../../api/ledger/<id>.json`, …). One pure
// mapping, unit-tested without a browser (test/site-export.test.ts).

export type ApiMode = "live" | "static";

export interface Api {
  mode: ApiMode;
  ledger: string;
  finding: (id: string) => string;
  checkpoint: string;
  pub: string;
  entries: string;
  /** A tlog tile by its path under the ledger dir, e.g. "tile/0/000.p/8". */
  tile: (path: string) => string;
  feed: string;
  /** Static-only extras (null in live mode). */
  stats: string | null;
  pulse: string | null;
}

/**
 * `base` is the relative prefix from the current page to the site root: "" for the landing
 * page, "../../../" for watch/case/<id>/. Ids are URI-encoded; tile paths keep their slashes.
 */
export function apiPaths(mode: ApiMode, base = ""): Api {
  const tile = (root: string) => (p: string) => `${root}ledger/${p.split("/").map(encodeURIComponent).join("/")}`;
  if (mode === "live") {
    return {
      mode,
      ledger: "/api/ledger",
      finding: (id) => `/api/ledger/${encodeURIComponent(id)}`,
      checkpoint: "/ledger/checkpoint",
      pub: "/ledger/pub",
      entries: "/ledger/entries.jsonl",
      tile: tile("/"),
      feed: "/feed.json",
      stats: null,
      pulse: null,
    };
  }
  return {
    mode,
    ledger: `${base}api/ledger.json`,
    finding: (id) => `${base}api/ledger/${encodeURIComponent(id)}.json`,
    checkpoint: `${base}ledger/checkpoint`,
    pub: `${base}ledger/pub`,
    entries: `${base}ledger/entries.jsonl`,
    tile: tile(base),
    feed: `${base}feed.json`,
    stats: `${base}api/stats.json`,
    pulse: `${base}api/pulse.json`,
  };
}
