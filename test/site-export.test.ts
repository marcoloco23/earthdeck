// `earthdeck watch export`: the static public site. Pages are server-rendered from the ledger
// (SEO, no content behind JS), every link is relative, stats math is stated and tested, the
// signing key never leaves the ledger dir, and ledger content can't inject markup. Also the
// browser-side pieces that are pure: the static fetch-path mapping and the WebCrypto proof
// check, cross-checked against the Node ledger.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ledger } from "../src/ledger/store.js";
import { seedDemo } from "../src/ledger/cli.js";
import { tilePath as nodeTilePath } from "../src/ledger/merkle.js";
import type { Finding } from "../src/ledger/schema.js";
import { computeStats, exportSite, livingValueOf } from "../src/watch/export.js";
import { esc, fillTemplate, parseNarration, plainArea, renderMarkdown, safeUrl } from "../src/watch/site-render.js";
import { SITE } from "../src/site.config.js";
import { apiPaths } from "../web/src/api.js";
import { leafTile, parseCheckpoint, tilePath, verifyCheckpointSignature, verifyInclusion } from "../web/src/proof.js";

const BASE = "https://vital.example.org";
const PUB_ID = "01994a2e-0000-7000-8000-00000000d001";
const EVIL_ID = "01994a2e-0000-7000-8000-00000000e666";

function seeded(): string {
  const dir = mkdtempSync(join(tmpdir(), "earthdeck-site-ledger-"));
  const l = Ledger.open(dir);
  seedDemo(l);
  // Hostile public input: markup in the title, a javascript: href, a script-closing narration.
  l.append({
    kind: "created",
    findingId: EVIL_ID,
    actor: "system:forest_loss@1.0",
    rule: { name: "forest_loss", version: "1.0" },
    title: `<script>alert("t")</script> "quoted" & <b>bold</b>`,
    summary: "</script><img src=x onerror=alert(1)>",
    tier: 0,
    geometry: { type: "Point", coordinates: [10, 10] },
    bbox: [9.9, 9.9, 10.1, 10.1],
    observedAt: "2026-09-01T00:00:00Z",
    evidence: [
      {
        id: "x",
        kind: "alert",
        source: "evil",
        datetime: "2026-09-01T00:00:00Z",
        href: "javascript:alert(1)",
        method: { name: "m", version: "1" },
        values: { living_value_usd_yr: 1000 },
      },
    ],
  });
  mkdirSync(join(dir, "watch"), { recursive: true });
  writeFileSync(join(dir, "watch", "heartbeat.json"), JSON.stringify({ sweepId: "sweep-1", at: "2026-09-25T12:00:00Z" }));
  writeFileSync(join(dir, "watch", "journal.jsonl"), '{"secret":"journal"}\n');
  return dir;
}

function fakeSite(): string {
  const dir = mkdtempSync(join(tmpdir(), "earthdeck-site-bundle-"));
  mkdirSync(join(dir, "assets"));
  writeFileSync(join(dir, "assets", "index-abc.js"), "console.log('site')");
  writeFileSync(join(dir, "assets", "index-abc.css"), "body{}");
  writeFileSync(join(dir, "og.png"), "png");
  writeFileSync(
    join(dir, "index.html"),
    `<!doctype html><html lang="en"><head><!--ssr:head--><script type="module" crossorigin src="./assets/index-abc.js"></script><link rel="stylesheet" href="./assets/index-abc.css"></head><body class="site" data-page=""><!--ssr:body--></body></html>`,
  );
  return dir;
}

function walk(root: string, rel = ""): string[] {
  return readdirSync(join(root, rel)).flatMap((n) => {
    const p = rel ? `${rel}/${n}` : n;
    return statSync(join(root, p)).isDirectory() ? walk(root, p) : [p];
  });
}

const jsonLdOf = (html: string) => [...html.matchAll(/<script type="application\/ld\+json">(.*?)<\/script>/g)].map((m) => JSON.parse(m[1]!) as Record<string, unknown>);

test("export writes a self-contained, relative, server-rendered site", async () => {
  const ledgerDir = seeded();
  const out = join(mkdtempSync(join(tmpdir(), "earthdeck-site-out-")), "site");
  const pulseCache = join(ledgerDir, "..", `pulse-${Date.now()}.json`);
  writeFileSync(pulseCache, JSON.stringify({ generatedAt: "2026-09-25T00:00:00Z", rows: [{ slug: "co2", status: "ok" }] }));
  writeFileSync(join(ledgerDir, "..", "TRUST-test.md"), "# Trust policy\n\nWe publish <only> what passed review.\n\n- one\n- two\n");

  const report = await exportSite({ out, ledgerDir, baseUrl: `${BASE}/`, siteDir: fakeSite(), pulse: "cache", pulseCache, trustFile: join(ledgerDir, "..", "TRUST-test.md"), contact: "reply@example.org" });
  assert.equal(report.findings, 4);
  assert.equal(report.publicFindings, 1);
  assert.equal(report.pulse, "cached");
  assert.equal(report.web, true);
  assert.equal(report.trust, true);

  const files = walk(out);
  for (const f of [
    "index.html",
    "watch/index.html",
    `watch/case/${PUB_ID}/index.html`,
    `watch/case/${EVIL_ID}/index.html`,
    "api/ledger.json",
    `api/ledger/${PUB_ID}.json`,
    "api/stats.json",
    "api/pulse.json",
    "feed.json",
    "feed.geojson",
    "ledger/checkpoint",
    "ledger/pub",
    "ledger/entries.jsonl",
    "ledger/tile/0/000.p/9",
    "schema/finding-event.v1.json",
    "trust.html",
    "TRUST.md",
    "sitemap.xml",
    "robots.txt",
    "og.png",
    "assets/index-abc.js",
  ]) {
    assert.ok(files.includes(f), `missing ${f}`);
  }
  // Never publish the signing key, the journal, or the template itself as a page.
  assert.ok(!files.some((f) => f.includes("ledger.key") || f.includes("journal") || f.includes("heartbeat")));
  // Nothing points at a local server.
  for (const f of files.filter((x) => /\.(html|json|jsonl|geojson|xml|txt|md)$/.test(x) || x === "ledger/checkpoint")) {
    const text = readFileSync(join(out, f), "utf8");
    assert.ok(!/localhost|127\.0\.0\.1/.test(text), `${f} mentions a local server`);
  }
  // The public site is anonymous: no owner name, handle, personal host, email or repo link —
  // even though --contact was passed. (ledger/** is the signed log itself: base64 signatures
  // could spell anything, and its bytes are what verification checks, so it is left out here.)
  for (const f of files.filter((x) => /\.(html|json|geojson|xml|txt|md)$/.test(x) && !x.startsWith("ledger/"))) {
    const text = readFileSync(join(out, f), "utf8");
    assert.ok(!/marc|sperzel|marcoloco|github\.com|mailto:|reply@example\.org/i.test(text), `${f} is not anonymous`);
    assert.ok(!/[\w.+-]+@[\w-]+(\.[\w-]+)*\.[a-z]{2,}/i.test(text), `${f} holds an email address`);
  }
  // No "@" anywhere a reader sees it: rendered page bodies, stats, sitemap, robots.
  for (const f of files.filter((x) => x.endsWith(".html"))) {
    const html = readFileSync(join(out, f), "utf8");
    assert.ok(!html.slice(html.indexOf("<body")).includes("@"), `${f} shows an @`);
  }
  for (const f of ["api/stats.json", "sitemap.xml", "robots.txt"]) assert.ok(!readFileSync(join(out, f), "utf8").includes("@"), `${f} holds an @`);

  // JSON shapes: the dashboard's own bodies.
  const ledger = JSON.parse(readFileSync(join(out, "api/ledger.json"), "utf8"));
  assert.equal(ledger.size, 9);
  assert.equal(ledger.findings.length, 4);
  const one = JSON.parse(readFileSync(join(out, `api/ledger/${PUB_ID}.json`), "utf8"));
  assert.equal(one.events.length, 5);
  assert.equal(one.inclusion.size, 9);
  const feed = JSON.parse(readFileSync(join(out, "feed.json"), "utf8"));
  assert.equal(feed.count, 1);
  assert.equal(feed.findings[0].url, `${BASE}/watch/case/${PUB_ID}/`);
  assert.equal(readFileSync(join(out, "ledger/checkpoint"), "utf8"), readFileSync(join(ledgerDir, "checkpoint"), "utf8"));

  const stats = JSON.parse(readFileSync(join(out, "api/stats.json"), "utf8"));
  assert.equal(stats.site.name, SITE.name);
  assert.equal(stats.site.baseUrl, BASE);
  assert.equal(stats.site.contact, null, "--contact is ignored: the public site is anonymous");
  assert.ok(!("repo" in stats.site));
  assert.equal(stats.lastSweep.sweepId, "sweep-1");
  assert.equal(stats.ledger.size, 9);
  assert.match(stats.ledger.root, /^[0-9a-f]{64}$/);
  assert.equal(stats.cases.public, 1);
  assert.equal(stats.byStatus.candidate, 2);
  assert.equal(stats.falsePositiveRate.overall.decided, 2);
  assert.match(stats.falsePositiveRate.definition, /false_positive ÷/);
  assert.equal(stats.livingValue, null, "a candidate's living value is not 'at stake in open cases'");

  // Landing: one h1, Organization + WebSite + Dataset, canonical, OG, assets at depth 0.
  const landing = readFileSync(join(out, "index.html"), "utf8");
  assert.equal(landing.match(/<h1\b/g)?.length, 1);
  assert.ok(landing.includes(`<link rel="canonical" href="${BASE}/" />`));
  assert.ok(landing.includes(`<meta property="og:image" content="${BASE}/og.png" />`));
  assert.ok(landing.includes('src="./assets/index-abc.js"'));
  assert.ok(landing.includes('data-page="landing"'));
  assert.deepEqual(jsonLdOf(landing).map((x) => x["@type"]), ["Organization", "WebSite", "Dataset"]);
  assert.ok(landing.includes(`href="watch/case/${PUB_ID}/"`));
  assert.ok(!landing.includes("<!--ssr:"));
  // First screen: the one sentence is the h1; map markers (published + still being checked), the
  // three plain numbers, and the latest cases in plain words.
  assert.match(landing, new RegExp(`<h1 class="top-line">${SITE.oneLine.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}</h1>`));
  assert.equal(landing.match(/class="pin pin--pub/g)?.length, 1);
  assert.equal(landing.match(/class="pin pin--open/g)?.length, 3, "two seeded candidates-in-progress + the hostile candidate");
  for (const k of ["Cases published", "False alarms we caught", "Last check", "Latest cases", "How the planet is doing", "Being checked", "34 hectares — about 48 football fields"]) {
    assert.ok(landing.includes(k), `landing lacks ${k}`);
  }
  // The map is the product: a full-screen hero with the panel's five modes, all server-rendered
  // (no-JS readers get every pane, stacked), and a light below-the-fold section for crawlers.
  for (const m of ["cases", "planet", "live", "metrics", "about"]) {
    assert.ok(landing.includes(`id="tab-${m}" href="#pane-${m}"`) && landing.includes(`id="pane-${m}"`), `landing lacks the ${m} mode`);
  }
  assert.ok(landing.includes('<section class="hero" id="hero"') && landing.includes('<div class="case-view" hidden></div>'));
  assert.ok(landing.includes('id="challenge"'), "the Reply link still lands somewhere");
  assert.ok(landing.includes('<section class="wrap wrap--wide seo"'));
  assert.ok(files.includes("api/metrics.json") && !files.includes("api/storms.json"), "metrics always; storms only on live exports");
  // …and nothing for developers: no commands, hashes, rule ids, tiers, feeds or JSON links.
  const landingBody = landing.slice(landing.indexOf("<body"));
  for (const k of ['class="cmd"', 'class="hash"', "npx ", "forest_loss", "tier", ".json", "checkpoint", "@"]) {
    assert.ok(!landingBody.includes(k), `landing mentions ${k}`);
  }
  assert.ok(!landing.includes("<script>alert"), "hostile titles are escaped on the landing too");

  // Developers page: the commands, feeds and schema the landing leaves out.
  const dev = readFileSync(join(out, "developers/index.html"), "utf8");
  assert.equal(dev.match(/<h1\b/g)?.length, 1);
  assert.ok(dev.includes('src="../assets/index-abc.js"'));
  for (const k of ["npx -y earthdeck ledger verify", `${BASE}/ledger/entries.jsonl`, 'href="../feed.json"', 'href="../schema/finding-event.v1.json"', "Source code: coming."]) {
    assert.ok(dev.includes(k), `developers page lacks ${k}`);
  }

  // Case page: full content in HTML, Report JSON-LD with the publish date, assets rebased.
  const page = readFileSync(join(out, `watch/case/${PUB_ID}/index.html`), "utf8");
  assert.equal(page.match(/<h1\b/g)?.length, 1);
  assert.ok(page.includes('src="../../../assets/index-abc.js"'));
  assert.ok(page.includes(`<link rel="canonical" href="${BASE}/watch/case/${PUB_ID}/" />`));
  assert.ok(!page.includes("noindex"));
  const report2 = jsonLdOf(page)[0]!;
  assert.equal(report2["@type"], "Report");
  assert.equal(report2.datePublished, "2026-09-02T09:01:00Z");
  for (const s of ["What we saw", "What it might not be", "What would change our mind", "Why this was published", "Two separate sources agreed", "Right of reply", "Global Forest Watch alerts", "Technical details", "Verify", "gfw-integrated-alerts", "2784", "IBAMA", "Rule FP rate", PUB_ID]) {
    assert.ok(page.includes(s), `case page lacks ${s}`);
  }
  assert.ok(page.includes(`data-index="${one.inclusion.index}"`));
  // The map first (the case area outlined), then the words; the article names its case for the map redirect.
  assert.ok(page.indexOf('<div class="case-map"><figure class="case-hero">') < page.indexOf("<article"));
  assert.ok(page.includes(`<article class="case" itemscope itemtype="https://schema.org/Report" data-case="${PUB_ID}">`));
  // The plain part comes first; ids, rule names and the proof only inside the closed details block.
  const tech = page.indexOf('<details class="tech"');
  assert.ok(tech > page.indexOf("What would change our mind") && !page.includes('<details class="tech" open'));
  for (const k of ["forest_loss", "gfw-integrated-alerts", 'class="hash"']) assert.ok(page.indexOf(k, page.indexOf("<body")) > tech, `${k} above the technical details`);

  // Unpublished pages exist (transparency) but are noindex and not in the sitemap.
  const cand = readFileSync(join(out, "watch/case/01994a2e-0000-7000-8000-00000000d002/index.html"), "utf8");
  assert.ok(cand.includes('<meta name="robots" content="noindex, follow" />'));
  assert.ok(cand.includes("Not published yet: only one source has seen this so far."));
  assert.ok(cand.includes("Why this is not published"));
  const sm = readFileSync(join(out, "sitemap.xml"), "utf8");
  assert.ok(sm.includes(`<loc>${BASE}/watch/case/${PUB_ID}/</loc>`));
  assert.ok(!sm.includes("d002"));
  assert.ok(sm.includes(`<loc>${BASE}/trust.html</loc>`));
  assert.ok(readFileSync(join(out, "robots.txt"), "utf8").includes(`Sitemap: ${BASE}/sitemap.xml`));

  // Cases index lists every finding with real links; unpublished ones are marked.
  const idx = readFileSync(join(out, "watch/index.html"), "utf8");
  assert.equal(idx.match(/class="case-row/g)?.length, 4);
  assert.equal(idx.match(/is-unpublished/g)?.length, 3);
  assert.ok(idx.includes('src="../assets/index-abc.js"'));
  // Icons + manifest on every page, relative to its depth; the logo is absolute in JSON-LD.
  assert.ok(landing.includes('<link rel="icon" href="favicon.ico" sizes="48x48" />'));
  assert.ok(landing.includes('<link rel="apple-touch-icon" href="apple-touch-icon.png" />'));
  assert.ok(readFileSync(join(out, `watch/case/${PUB_ID}/index.html`), "utf8").includes('<link rel="icon" href="../../../favicon.svg" type="image/svg+xml" />'));
  assert.ok(idx.includes('<link rel="manifest" href="../site.webmanifest" />'));
  assert.equal(jsonLdOf(landing)[0]!.logo, `${BASE}/icon-512.png`);
  const manifest = JSON.parse(readFileSync(join(out, "site.webmanifest"), "utf8"));
  assert.equal(manifest.name, SITE.fullName);
  assert.deepEqual(manifest.icons.map((i: { sizes: string }) => i.sizes), ["192x192", "512x512", "any"]);
  // Both pages carry the static world map the site bundle upgrades in place; pins link relative to the page.
  assert.ok(idx.includes('<figure class="world" data-map>') && landing.includes('<figure class="world" data-map>'));
  assert.ok(idx.includes(`href="case/${PUB_ID}/"`));
  // The map's data: every finding with a usable bbox, as data (the hostile title is only text inside JSON).
  const md = JSON.parse(readFileSync(join(out, "api/map.json"), "utf8"));
  assert.equal(md.v, 1);
  assert.equal(md.cases.length, 4);
  for (const c of md.cases as { id: string; topic: string }[]) assert.notEqual(c.topic, "other", `case ${c.id} would show under an "Other" topic`);
  assert.deepEqual(new Set(md.cases.map((c: { group: string }) => c.group)), new Set(["published", "checking"]));
  assert.ok(md.places.some((p: { name: string }) => p.name === "São Félix do Xingu"));

  // Hostile ledger content is inert.
  const evil = readFileSync(join(out, `watch/case/${EVIL_ID}/index.html`), "utf8");
  assert.ok(!evil.includes("<script>alert"));
  assert.ok(!evil.includes("<img src=x"));
  assert.ok(!evil.includes('href="javascript:'));
  assert.ok(evil.includes("&lt;script&gt;alert(&quot;t&quot;)&lt;/script&gt;"));
  for (const ld of evil.matchAll(/<script type="application\/ld\+json">(.*?)<\/script>/g)) assert.ok(!ld[1]!.includes("<"));

  // TRUST.md is escaped, rendered in the site chrome.
  const trust = readFileSync(join(out, "trust.html"), "utf8");
  assert.ok(trust.includes("&lt;only&gt;"));
  assert.ok(trust.includes("<li>one</li>"));

  // Re-export into the same dir works (marker); a foreign non-empty dir is refused.
  await exportSite({ out, ledgerDir, siteDir: null, pulse: "off" });
  const foreign = mkdtempSync(join(tmpdir(), "earthdeck-site-foreign-"));
  writeFileSync(join(foreign, "keep.txt"), "mine");
  await assert.rejects(exportSite({ out: foreign, ledgerDir, siteDir: null, pulse: "off" }), /not written by/);
  assert.ok(existsSync(join(foreign, "keep.txt")));
});

test("export without a base URL: no canonical, no sitemap, still valid pages", async () => {
  const out = join(mkdtempSync(join(tmpdir(), "earthdeck-site-nobase-")), "s");
  const r = await exportSite({ out, ledgerDir: seeded(), baseUrl: null, siteDir: null, pulse: "off" });
  assert.equal(r.sitemap, false);
  assert.equal(r.pulse, "none");
  assert.ok(!existsSync(join(out, "sitemap.xml")));
  assert.equal(readFileSync(join(out, "robots.txt"), "utf8"), "User-agent: *\nAllow: /\n");
  const landing = readFileSync(join(out, "index.html"), "utf8");
  assert.ok(!landing.includes('rel="canonical"'));
  assert.ok(landing.includes("<!doctype html>"));
  await assert.rejects(exportSite({ out, ledgerDir: seeded(), baseUrl: "ftp://nope", siteDir: null, pulse: "off" }), /http\(s\)/);
});

test("stats: published false-positive rate per rule + living value", () => {
  const l = Ledger.open(mkdtempSync(join(tmpdir(), "earthdeck-stats-")));
  seedDemo(l);
  const [pub, cand, conf] = [l.get(PUB_ID)!, l.get("01994a2e-0000-7000-8000-00000000d002")!, l.get("01994a2e-0000-7000-8000-00000000d003")!];
  const as = (f: Finding, status: Finding["status"], extra: Partial<Finding> = {}): Finding => ({ ...f, ...extra, status, findingId: `${f.findingId.slice(0, -4)}${Math.random().toString(16).slice(2, 6)}` });
  const lv = (usd: number) => [{ ...pub.evidence[0]!, values: { living_value_usd_yr: usd } }];
  const findings = [
    as(pub, "notified", { evidence: lv(2e6) }),
    as(pub, "false_positive"),
    as(pub, "false_positive"),
    as(pub, "resolved", { evidence: lv(5e9) }), // resolved: decided, but no longer "at stake"
    as(pub, "expired"), // undecided
    as(cand, "candidate", { evidence: lv(7e9) }), // undecided, not at stake
    as(conf, "confirmed"),
    as(conf, "false_positive"),
  ];
  const s = computeStats(findings, { size: 0, root: null, checkpoint: null }, null, {}, new Date("2026-09-26T00:00:00Z"));
  assert.deepEqual(s.falsePositiveRate.byRule.forest_loss, { falsePositives: 2, decided: 4, rate: 0.5 });
  assert.deepEqual(s.falsePositiveRate.byRule.fires_in_protected, { falsePositives: 0, decided: 0, rate: null });
  assert.deepEqual(s.falsePositiveRate.byRule.methane_anomaly, { falsePositives: 1, decided: 2, rate: 0.5 });
  assert.deepEqual(s.falsePositiveRate.overall, { falsePositives: 3, decided: 6, rate: 0.5 });
  assert.equal(s.cases.public, 2); // notified + resolved
  assert.equal(s.byTier["1"], 6);
  assert.deepEqual(s.byRule.forest_loss, { total: 5, public: 2, versions: ["1.0"] });
  assert.equal(s.livingValue?.usdPerYear, 2e6);
  assert.equal(s.livingValue?.cases, 1);
  assert.equal(livingValueOf({ ...pub, evidence: [...lv(3), ...lv(9)] }), 9);
  assert.equal(livingValueOf(cand), null);
});

test("render primitives: escaping, URL allow-list, markdown, template fill", () => {
  assert.equal(esc(`<a href="x">'&'</a>`), "&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;");
  assert.equal(safeUrl("javascript:alert(1)"), null);
  assert.equal(safeUrl("https://ok.example/a?b=1"), "https://ok.example/a?b=1");
  assert.equal(plainArea(232), "232 hectares — about 320 football fields");
  assert.equal(plainArea(0.5), "0.5 hectares");
  assert.deepEqual(parseNarration("Forest cleared near a river\n\nAbout 34 hectares went.\n\nKey numbers:\n- ha: 34 [x]\n\nConfidence: high\nCaveats:\n- could be fire"), {
    headline: "Forest cleared near a river",
    body: "About 34 hectares went.",
    caveats: ["could be fire"],
  });
  assert.deepEqual(parseNarration("## Free-form\n\ntext"), { headline: null, body: "## Free-form\n\ntext", caveats: [] });
  assert.equal(renderMarkdown("## Hi **there**\n\n[x](javascript:alert(1))", 1), "<h3>Hi <strong>there</strong></h3>\n<p>[x](javascript:alert(1))</p>");
  const tpl = `<head><!--ssr:head--><script src="./assets/a.js"></script><link href="./assets/a.css"></head><body data-page=""><!--ssr:body--></body>`;
  assert.equal(fillTemplate(tpl, 3, "case", { head: "<title>$&</title>", body: "B" }), `<head><title>$&</title><script src="../../../assets/a.js"></script><link href="../../../assets/a.css"></head><body data-page="case">B</body>`);
});

test("static fetch-path mapping (web/src/api.ts)", () => {
  const s = apiPaths("static", "../../../");
  assert.equal(s.ledger, "../../../api/ledger.json");
  assert.equal(s.finding("a/b"), "../../../api/ledger/a%2Fb.json");
  assert.equal(s.checkpoint, "../../../ledger/checkpoint");
  assert.equal(s.pub, "../../../ledger/pub");
  assert.equal(s.tile("tile/0/x001/000.p/8"), "../../../ledger/tile/0/x001/000.p/8");
  assert.equal(s.stats, "../../../api/stats.json");
  assert.equal(apiPaths("static").pulse, "api/pulse.json");
  const live = apiPaths("live");
  assert.equal(live.finding("abc"), "/api/ledger/abc");
  assert.equal(live.tile("tile/0/000"), "/ledger/tile/0/000");
  assert.equal(live.stats, null);
});

test("browser proof check (web/src/proof.ts) agrees with the Node ledger", async () => {
  const dir = mkdtempSync(join(tmpdir(), "earthdeck-proof-"));
  const l = Ledger.open(dir);
  seedDemo(l);
  const cpText = l.checkpointText()!;
  const cp = parseCheckpoint(cpText)!;
  assert.equal(cp.size, 8);
  assert.equal(cp.rootHex, l.root().toString("hex"));
  const pub = readFileSync(join(dir, "ledger.pub"), "utf8");
  assert.equal(await verifyCheckpointSignature(cp, pub), true);
  const forged = parseCheckpoint(cpText.replace("\n8\n", "\n9\n"))!;
  assert.equal(await verifyCheckpointSignature(forged, pub), false);

  for (let i = 0; i < l.size; i++) {
    const p = l.inclusionProof(i);
    assert.equal(await verifyInclusion(p.leafHash, i, p.size, p.proof, p.root), true, `leaf ${i}`);
    const t = leafTile(i, l.size);
    const tile = readFileSync(join(dir, t.path));
    assert.equal(tile.subarray(t.offset, t.offset + 32).toString("hex"), p.leafHash);
  }
  const p = l.inclusionProof(3);
  assert.equal(await verifyInclusion(p.leafHash, 4, p.size, p.proof, p.root), false);
  assert.equal(await verifyInclusion(p.leafHash, 3, p.size, p.proof, "00".repeat(32)), false);
  for (const [lvl, idx, w] of [[0, 0, 256], [0, 7, 8], [1, 1234, 256], [0, 1234067, 5]] as const) assert.equal(tilePath(lvl, idx, w), nodeTilePath(lvl, idx, w));
});
