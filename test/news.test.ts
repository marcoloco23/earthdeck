// "In the news": the GDELT DOC 2.0 client (fetch-mocked against a response recorded live on
// 2026-09-27 — deliberately a noisy one), query building from real ledger AOI names, the
// title relevance filter, caching/pacing/budget/rate-limit behaviour, and the rendered section
// in the static case page. Never touches the network.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gdeltArticles, gdeltUrl, newsPlace, newsQuery, parseArticles, type NewsItem, type NewsSubject } from "../src/clients/gdelt.js";
import { Ledger } from "../src/ledger/store.js";
import { seedDemo } from "../src/ledger/cli.js";
import type { Finding } from "../src/ledger/schema.js";
import { exportSite } from "../src/watch/export.js";
import { newsForCases, relevant } from "../src/watch/news.js";
import { CallBudget, gdeltCapFromEnv } from "../src/watch/quota.js";
import { NEWS_NOTE, newsHtml } from "../src/watch/site-render.js";
import { mockFetch, textResponse } from "./helpers.js";

const RAW = readFileSync(new URL("./fixtures/gdelt-doc-california-fire-2026-09-27.json", import.meta.url), "utf8");
const subj = (name: string, rule: string, params: Record<string, unknown> = {}): NewsSubject => ({ rule: { name: rule, params }, aoi: { name }, title: "" });

test("newsPlace: strips tile/registered-site bookkeeping, parentheses and admin tails", () => {
  assert.equal(newsPlace(subj("Flare field near Eleme, Rivers (Nigeria) — 20 registered sites", "flaring")), "Eleme");
  assert.equal(newsPlace(subj("Mavinga National Park (AGO) — tile 3/4", "fires_in_protected")), "Mavinga National Park");
  assert.equal(newsPlace(subj("Peixoto de Azevedo, Mato Grosso (Brazil) — tile 2/2", "forest_loss")), "Peixoto de Azevedo");
  assert.equal(newsPlace(subj("Rumaila field (Basra, Iraq)", "flaring")), "Rumaila field");
  assert.equal(newsPlace(subj("World: tree cover loss", "indicator_trend")), null);
  assert.equal(newsPlace(subj("Arctic sea ice", "indicator_threshold")), "Arctic");
});

test("newsQuery: place phrase AND OR-ed topic keywords; no topic or place → null", () => {
  assert.equal(newsQuery(subj("Galápagos Marine Reserve", "mpa_fishing")), `"Galápagos Marine Reserve" ("illegal fishing" OR "fishing fleet" OR "fishing vessels")`);
  assert.equal(newsQuery(subj("Lahore (Pakistan)", "indicator_threshold", { indicator: "air_quality" })), `"Lahore" (smog OR "air pollution" OR "air quality")`);
  assert.equal(newsQuery(subj("Arctic sea ice", "indicator_threshold", { indicator: "sea_ice" })), `"Arctic" "sea ice"`);
  assert.equal(newsQuery(subj("Somewhere", "indicator_trend")), null);
  const u = new URL(gdeltUrl("x y"));
  assert.equal(u.origin + u.pathname, "https://api.gdeltproject.org/api/v2/doc/doc");
  assert.deepEqual([u.searchParams.get("mode"), u.searchParams.get("format"), u.searchParams.get("timespan"), u.searchParams.get("sort")], ["ArtList", "json", "7d", "hybridrel"]);
});

test("parseArticles: keeps only headline metadata, normalises seendate", () => {
  const items = parseArticles(JSON.parse(RAW));
  assert.equal(items.length, 5);
  assert.deepEqual(Object.keys(items[0]!).sort(), ["domain", "language", "seendate", "sourcecountry", "title", "url"]);
  assert.equal(items[1]!.seendate, "2026-09-27T09:30:00Z");
  assert.equal(items[1]!.domain, "newstribune.com");
  assert.deepEqual(parseArticles({ articles: [{ title: "x", url: "javascript:alert(1)" }, { title: "", url: "https://a" }] }), []);
});

test("gdeltArticles: UA + timeout; empty body → []; plain-text rate notice → 429, not retried", async (t) => {
  let reply = RAW;
  const m = mockFetch(() => textResponse(reply));
  t.after(m.restore);
  assert.equal((await gdeltArticles(`"California" wildfire`)).length, 5);
  assert.match(m.calls[0]!.headers["user-agent"]!, /earthdeck-news/);
  reply = "";
  assert.deepEqual(await gdeltArticles("q"), []);
  reply = "Please limit requests to one every 5 seconds or contact …";
  await assert.rejects(gdeltArticles("q"), (e: { status?: number }) => e.status === 429);
  assert.equal(m.calls.length, 3, "one request per call — no retry");
});

test("relevant: the noisy live fixture mostly falls away — only titles naming the place or topic survive", () => {
  const f = { ...subj("California", "fires_in_protected"), findingId: "x", status: "confirmed" } as unknown as Finding;
  const kept = relevant(f, parseArticles(JSON.parse(RAW)));
  assert.deepEqual(kept.map((k) => k.domain), ["newstribune.com"]); // "California oldest … winery" — place match; still noise, hence the note
});

const item = (title: string): NewsItem => ({ title, url: `https://news.example/${encodeURIComponent(title)}`, domain: "news.example", seendate: "2026-09-26T10:00:00Z", language: "English", sourcecountry: "Brazil" });
const finding = (id: string, status: string, name = "Peixoto de Azevedo, Mato Grosso (Brazil)"): Finding =>
  ({ findingId: id, status, rule: { name: "forest_loss", version: "1.0", params: {} }, aoi: { name }, title: "t" }) as unknown as Finding;

test("newsForCases: decided cases only, 12 h cache, budget cap, stop on rate limit, stale cache survives", async () => {
  const dir = mkdtempSync(join(tmpdir(), "earthdeck-news-"));
  const queries: string[] = [];
  let fail = false;
  const fetchArticles = async (q: string) => {
    queries.push(q);
    if (fail) throw Object.assign(new Error("GDELT rate limit (429)"), { status: 429 });
    return [item("Deforestation surges in Peixoto de Azevedo"), item("Unrelated football result"), ...Array.from({ length: 6 }, (_, i) => item(`Logging raid ${i}`))];
  };
  const fs = [finding("a", "published"), finding("b", "candidate"), finding("c", "false_positive"), finding("d", "confirmed", "Novo Progresso, Pará (Brazil)")];
  const now = new Date("2026-09-27T12:00:00Z");
  const r1 = await newsForCases(fs, { cacheDir: dir, budget: new CallBudget(40), now, fetchArticles, minIntervalMs: 0 });
  assert.deepEqual([...r1.keys()], ["a", "d"]);
  assert.equal(r1.get("a")!.length, 5, "capped at 5");
  assert.ok(!r1.get("a")!.some((n) => /football/.test(n.title)), "off-topic titles dropped");
  assert.equal(queries.length, 2);
  assert.ok(existsSync(join(dir, "a.json")));

  // Within 12 h: served from cache, no calls.
  await newsForCases(fs, { cacheDir: dir, budget: new CallBudget(40), now: new Date(now.getTime() + 3600_000), fetchArticles, minIntervalMs: 0 });
  assert.equal(queries.length, 2);

  // Stale + rate-limited: first call 429 → budget stops → both keep their stale cached headlines.
  fail = true;
  const logs: string[] = [];
  const budget = new CallBudget(40);
  const r3 = await newsForCases(fs, { cacheDir: dir, budget, now: new Date(now.getTime() + 13 * 3600_000), fetchArticles, minIntervalMs: 0, log: (s) => logs.push(s) });
  assert.equal(queries.length, 3, "no second call after a rate limit");
  assert.ok(budget.halted);
  assert.equal(r3.size, 2);
  assert.ok(logs.some((l) => /rate limit/.test(l)));

  // Budget 0 → cache only.
  fail = false;
  await newsForCases(fs, { cacheDir: dir, budget: new CallBudget(0), now: new Date(now.getTime() + 13 * 3600_000), fetchArticles, minIntervalMs: 0 });
  assert.equal(queries.length, 3);
});

test("gdeltCapFromEnv: default 40, env override, rejects garbage", () => {
  assert.equal(gdeltCapFromEnv({}), 40);
  assert.equal(gdeltCapFromEnv({ EARTHDECK_MAX_GDELT_CALLS: "3" }), 3);
  assert.throws(() => gdeltCapFromEnv({ EARTHDECK_MAX_GDELT_CALLS: "-1" }));
});

test("newsHtml: escaped headline links with rel=noopener nofollow + the context note; empty → nothing", () => {
  assert.equal(newsHtml([]), "");
  assert.equal(newsHtml(undefined), "");
  assert.equal(newsHtml([{ ...item("x"), url: "javascript:alert(1)" }]), "");
  const h = newsHtml([item(`<img src=x onerror=alert(1)> fire`)]);
  assert.match(h, /In the news/);
  assert.match(h, /rel="noopener nofollow"/);
  assert.doesNotMatch(h, /<img/);
  assert.ok(h.includes(NEWS_NOTE.replace(/'/g, "&#39;")) || h.includes(NEWS_NOTE), "note present");
});

test("exportSite: news off by default (no network); cache mode writes api/news and the case-page section", async (t) => {
  const m = mockFetch(() => {
    throw new Error("network must not be touched");
  });
  t.after(m.restore);
  const ledgerDir = mkdtempSync(join(tmpdir(), "earthdeck-news-ledger-"));
  seedDemo(Ledger.open(ledgerDir));
  const PUB = "01994a2e-0000-7000-8000-00000000d001";
  const tmp = mkdtempSync(join(tmpdir(), "earthdeck-news-site-"));

  const r0 = await exportSite({ out: join(tmp, "s0"), ledgerDir, siteDir: null, pulse: "off" });
  assert.equal(r0.news, 0);
  assert.equal(existsSync(join(tmp, "s0", "api", "news")), false);
  assert.doesNotMatch(readFileSync(join(tmp, "s0", "watch", "case", PUB, "index.html"), "utf8"), /In the news/);

  mkdirSync(join(ledgerDir, "news"), { recursive: true });
  writeFileSync(join(ledgerDir, "news", `${PUB}.json`), JSON.stringify({ fetchedAt: "2026-01-01T00:00:00Z", query: "old", items: [item("Deforestation in São Félix do Xingu")] }));
  const r1 = await exportSite({ out: join(tmp, "s1"), ledgerDir, siteDir: null, pulse: "off", news: "cache" });
  assert.equal(r1.news, 1);
  const api = JSON.parse(readFileSync(join(tmp, "s1", "api", "news", `${PUB}.json`), "utf8"));
  assert.equal(api.items.length, 1);
  const page = readFileSync(join(tmp, "s1", "watch", "case", PUB, "index.html"), "utf8");
  assert.match(page, /In the news[\s\S]*Deforestation in São Félix do Xingu/);
  assert.equal(m.calls.length, 0);
});
