// NASA Common Metadata Repository (CMR) client — the catalog behind Earthdata Search,
// ~50,000 Earth-science collections across every NASA DAAC. Free, no key. This is the
// discovery layer: find which datasets exist for a topic/place/time; analysis stays in
// earthdeck's other tools. (NASA also runs a full MCP server over CMR — see README.)

import { USER_AGENT } from "../config.js";
import { OverviewError } from "../errors.js";
import type { BBox } from "../types.js";
import { assertBBox } from "../util.js";

const CMR_COLLECTIONS = "https://cmr.earthdata.nasa.gov/search/collections.json";

export interface CmrCollection {
  conceptId: string;
  shortName: string;
  title: string;
  dataCenter: string;
  timeStart: string | null;
  timeEnd: string | null; // null = ongoing
  cloudHosted: boolean;
  summary: string; // truncated
  landingPage: string | null;
}

interface RawEntry {
  id?: string;
  short_name?: string;
  title?: string;
  data_center?: string;
  time_start?: string;
  time_end?: string;
  cloud_hosted?: boolean;
  summary?: string;
  links?: Array<{ rel?: string; href?: string }>;
}

/** Normalize a CMR collections.json feed into CmrCollection rows (bad entries skipped). */
export function parseCmrCollections(json: unknown): CmrCollection[] {
  const entries = (json as { feed?: { entry?: RawEntry[] } })?.feed?.entry;
  if (!Array.isArray(entries)) throw new OverviewError("unexpected CMR response shape");
  const out: CmrCollection[] = [];
  for (const e of entries) {
    if (!e.id || !e.title) continue;
    const landing = e.links?.find(
      (l) => l.rel?.endsWith("documentation#") || l.rel?.endsWith("metadata#"),
    );
    out.push({
      conceptId: e.id,
      shortName: e.short_name ?? "",
      title: e.title,
      dataCenter: e.data_center ?? "",
      timeStart: e.time_start ?? null,
      timeEnd: e.time_end ?? null,
      cloudHosted: e.cloud_hosted === true,
      summary: (e.summary ?? "").slice(0, 280),
      landingPage: landing?.href ?? null,
    });
  }
  return out;
}

export interface CmrQuery {
  keyword: string;
  bbox?: BBox;
  dateFrom?: string; // YYYY-MM-DD
  dateTo?: string;
  limit?: number;
}

/** Search CMR collections by keyword (+ optional bbox/time), most-used datasets first. */
export async function searchCollections(q: CmrQuery): Promise<CmrCollection[]> {
  const params = new URLSearchParams({
    keyword: q.keyword,
    page_size: String(Math.max(1, Math.min(50, q.limit ?? 10))),
    sort_key: "-usage_score",
  });
  if (q.bbox) {
    assertBBox(q.bbox);
    params.set("bounding_box", q.bbox.join(","));
  }
  if (q.dateFrom || q.dateTo) {
    params.set("temporal", `${q.dateFrom ? `${q.dateFrom}T00:00:00Z` : ""},${q.dateTo ? `${q.dateTo}T23:59:59Z` : ""}`);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25_000);
  try {
    const res = await fetch(`${CMR_COLLECTIONS}?${params.toString()}`, {
      headers: { "user-agent": USER_AGENT, accept: "application/json" },
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new OverviewError(`CMR request failed (${res.status})`, res.status, body.slice(0, 300));
    }
    return parseCmrCollections(await res.json());
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new OverviewError("CMR request timed out (25 s) — NASA's catalog can be slow under load; retry");
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
