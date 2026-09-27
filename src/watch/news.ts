// "In the news" for the static site: per decided case, recent headlines from GDELT matched by
// place + topic (src/clients/gdelt.ts). Context only — never evidence, never fed to the
// analyst's narration or review. Cached per case under <ledger dir>/news/<id>.json (12 h TTL),
// paced ≤1 request / 5.5 s, capped per export (CallBudget), and failing soft: a failed or
// skipped lookup falls back to the stale cache, else the case simply has no news section.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Finding, Status } from "../ledger/schema.js";
import { GDELT_MIN_INTERVAL_MS, gdeltArticles, newsPlace, newsQuery, topicKeywords, type NewsItem } from "../clients/gdelt.js";
import { CallBudget } from "./quota.js";

/** Decided-true cases only: no candidates, false positives, expired or retracted. */
export const NEWS_STATUSES: readonly Status[] = ["confirmed", "published", "notified", "replied", "no_response", "resolved"];
export const NEWS_TTL_MS = 12 * 3600_000;
export const NEWS_MAX_ITEMS = 5;

interface CacheFile {
  fetchedAt: string;
  query: string;
  items: NewsItem[];
}

const fold = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

/**
 * GDELT matches words anywhere in the article text, so most hits are off-topic. Keep a headline
 * only when its title itself names the place or the topic.
 */
export function relevant(f: Finding, items: readonly NewsItem[]): NewsItem[] {
  const place = newsPlace(f);
  const words = [...(place ? [place] : []), ...topicKeywords(f)].map(fold);
  return items.filter((n) => {
    const t = fold(n.title);
    return words.some((w) => t.includes(w));
  });
}

function readCache(file: string): CacheFile | null {
  try {
    const j = JSON.parse(readFileSync(file, "utf8")) as CacheFile;
    return typeof j.fetchedAt === "string" && Array.isArray(j.items) ? j : null;
  } catch {
    return null;
  }
}

export interface NewsOptions {
  cacheDir: string;
  budget: CallBudget;
  now: Date;
  log?: (s: string) => void;
  /** Injected for tests; default GDELT DOC 2.0. */
  fetchArticles?: (query: string) => Promise<NewsItem[]>;
  minIntervalMs?: number;
}

/** caseId → ≤5 relevant headlines (only cases that have some). */
export async function newsForCases(findings: readonly Finding[], o: NewsOptions): Promise<Map<string, NewsItem[]>> {
  const out = new Map<string, NewsItem[]>();
  const fetchArticles = o.fetchArticles ?? ((q: string) => gdeltArticles(q));
  const gap = o.minIntervalMs ?? GDELT_MIN_INTERVAL_MS;
  const log = o.log ?? (() => {});
  let last = 0;
  let fetched = 0;
  let failed = 0;
  for (const f of findings) {
    if (!NEWS_STATUSES.includes(f.status)) continue;
    const query = newsQuery(f);
    if (!query) continue;
    const file = join(o.cacheDir, `${f.findingId}.json`);
    const cached = existsSync(file) ? readCache(file) : null;
    const fresh = cached && cached.query === query && o.now.getTime() - Date.parse(cached.fetchedAt) < NEWS_TTL_MS;
    let items = cached?.items ?? [];
    if (!fresh && o.budget.take()) {
      const wait = last + gap - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      try {
        items = relevant(f, await fetchArticles(query)).slice(0, NEWS_MAX_ITEMS);
        fetched += 1;
        try {
          mkdirSync(o.cacheDir, { recursive: true });
          writeFileSync(file, JSON.stringify({ fetchedAt: o.now.toISOString(), query, items } satisfies CacheFile));
        } catch {
          /* cache is best-effort */
        }
      } catch (e) {
        failed += 1;
        const err = e as { status?: number; message?: string };
        if (err.status === 429) {
          o.budget.stop();
          log("  news: GDELT rate limit — no more lookups this export (cached headlines still used)");
        }
      } finally {
        last = Date.now();
      }
    }
    if (items.length) out.set(f.findingId, items.slice(0, NEWS_MAX_ITEMS));
  }
  if (fetched || failed) log(`  news: ${fetched} lookups, ${failed} failed, ${out.size} cases with headlines`);
  return out;
}
