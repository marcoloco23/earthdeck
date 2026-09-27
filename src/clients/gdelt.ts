// GDELT DOC 2.0 — "In the news" context for a case: recent headlines matching the case's place
// name + topic keywords. Zero-key, open (https://blog.gdeltproject.org/gdelt-doc-2-0-api-debuts/).
//
// Verified live 2026-09-27: the GEO 2.0 endpoint (api/v2/geo/geo) answers 404 — it is gone,
// so there is no radius search; matching is by place name + keywords over article text, which
// is noisy. The DOC API asks for ≤1 request per 5 s and answers an over-rate request with HTTP
// 200 and a plain-text "Please limit requests…" notice instead of JSON — treated as a rate
// limit (fail soft, never retried). Only headline metadata is kept: no bodies, no images.

import { OverviewError } from "../errors.js";

export const GDELT_DOC = "https://api.gdeltproject.org/api/v2/doc/doc";
export const GDELT_USER_AGENT = "earthdeck-news/0.3 (+https://vitalearth.io; open-data environmental watch)";
/** GDELT asks for one request every 5 seconds. */
export const GDELT_MIN_INTERVAL_MS = 5_500;

export interface NewsItem {
  title: string;
  url: string;
  domain: string;
  /** ISO 8601 (GDELT's `20260927T093000Z` normalised). */
  seendate: string;
  language: string;
  sourcecountry: string;
}

/** The subset of a finding the query builder needs. */
export interface NewsSubject {
  rule: { name: string; params?: Record<string, unknown> };
  aoi?: { name?: string };
  title: string;
}

/** Topic keywords per rule (OR-ed). Phrases are quoted in the query. */
export function topicKeywords(s: NewsSubject): string[] {
  const p = s.rule.params ?? {};
  const kind = String(p.kind ?? p.indicator ?? p.hazard ?? "");
  switch (s.rule.name) {
    case "forest_loss":
      return ["deforestation", "logging", "land clearing"];
    case "fires_in_protected":
    case "fires_absent":
      return ["wildfire", "forest fire", "bushfire"];
    case "flaring":
    case "flaring_stopped":
      return ["gas flaring", "flaring", "oil field"];
    case "methane_anomaly":
      return ["methane", "gas leak", "gas flaring"];
    case "mpa_fishing":
      return ["illegal fishing", "fishing fleet", "fishing vessels"];
    case "weather_extreme":
      return ["heatwave", "cyclone", "flood", "extreme weather"];
    case "indicator_threshold":
      if (kind === "marine_heatwave") return ["marine heatwave", "coral bleaching", "ocean temperature"];
      if (kind === "sea_ice") return ["sea ice"];
      if (kind === "air_quality") return ["smog", "air pollution", "air quality"];
      if (kind === "river_discharge") return ["flood", "drought", "river level"];
      return [];
    case "improvement":
      if (/forest/.test(kind)) return ["deforestation", "logging"];
      if (/flar/.test(kind)) return ["gas flaring", "flaring"];
      if (/reef|coral/.test(kind)) return ["coral bleaching", "marine heatwave"];
      if (/air/.test(kind)) return ["smog", "air pollution"];
      if (/fire/.test(kind)) return ["wildfire", "forest fire"];
      return [];
    default:
      return [];
  }
}

/**
 * The place to search for, cleaned of watch bookkeeping: "Flare field near Eleme, Rivers
 * (Nigeria) — 20 registered sites" → "Eleme"; "Mavinga National Park (AGO) — tile 3/4" →
 * "Mavinga National Park". Global / hemispheric subjects ("World: …", "Arctic sea ice") give the
 * region word only when it is a real place; otherwise null (no place → no news query).
 */
export function newsPlace(s: NewsSubject): string | null {
  let n = (s.aoi?.name ?? "").trim();
  if (!n || /^world\b/i.test(n)) return null;
  if (/^(arctic|antarctic) sea ice$/i.test(n)) return n.split(" ")[0]!;
  n = n.replace(/\s+[—–-]\s+(tile \d+\/\d+|\d+ registered sites?)\s*$/i, "");
  n = n.replace(/^flare field near\s+/i, "");
  n = n.replace(/\s*\([^)]*\)\s*/g, " ").trim();
  n = n.split(",")[0]!.trim();
  n = n.replace(/["()]/g, "").trim();
  // GDELT rejects keywords shorter than 3 characters; very short names are also too ambiguous.
  return n.length >= 4 ? n : null;
}

/** DOC 2.0 query string, or null when the case has no place or no topic. */
export function newsQuery(s: NewsSubject): string | null {
  const place = newsPlace(s);
  const kw = topicKeywords(s);
  if (!place || kw.length === 0) return null;
  const q = (w: string) => (w.includes(" ") ? `"${w}"` : w);
  const topic = kw.length === 1 ? q(kw[0]!) : `(${kw.map(q).join(" OR ")})`;
  return `"${place}" ${topic}`;
}

export function gdeltUrl(query: string, opts: { timespan?: string; maxrecords?: number } = {}): string {
  return `${GDELT_DOC}?${new URLSearchParams({
    query,
    mode: "ArtList",
    format: "json",
    timespan: opts.timespan ?? "7d",
    maxrecords: String(opts.maxrecords ?? 10),
    sort: "hybridrel",
  })}`;
}

function isoSeen(s: string): string {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(s);
  return m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z` : s;
}

/** Keep only headline metadata; drop malformed rows, non-http(s) URLs and duplicate titles. */
export function parseArticles(body: unknown): NewsItem[] {
  const arts = (body as { articles?: unknown })?.articles;
  if (!Array.isArray(arts)) return [];
  const out: NewsItem[] = [];
  const seen = new Set<string>();
  for (const a of arts as Record<string, unknown>[]) {
    const str = (k: string) => (typeof a?.[k] === "string" ? (a[k] as string).trim() : "");
    const url = str("url");
    const title = str("title").replace(/\s+/g, " ");
    if (!title || !/^https?:\/\//i.test(url)) continue;
    const key = title.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ title: title.slice(0, 300), url, domain: str("domain"), seendate: isoSeen(str("seendate")), language: str("language"), sourcecountry: str("sourcecountry") });
  }
  return out;
}

/**
 * One DOC 2.0 ArtList call. 15 s timeout, never retried. Throws OverviewError with status 429
 * on a rate-limit answer (real 429 or GDELT's plain-text notice) so callers can stop for the run.
 */
export async function gdeltArticles(query: string, opts: { timespan?: string; maxrecords?: number; timeoutMs?: number } = {}): Promise<NewsItem[]> {
  const res = await fetch(gdeltUrl(query, opts), {
    headers: { "user-agent": GDELT_USER_AGENT, accept: "application/json" },
    signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
  });
  const text = await res.text();
  if (res.status === 429 || /please limit requests/i.test(text)) throw new OverviewError("GDELT rate limit (429)", 429);
  if (!res.ok) throw new OverviewError(`GDELT DOC request failed (${res.status})`, res.status, text.slice(0, 200));
  if (!text.trim()) return []; // GDELT answers an empty body when nothing matched
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new OverviewError(`GDELT DOC answered non-JSON: ${text.slice(0, 120)}`, res.status);
  }
  return parseArticles(body);
}
