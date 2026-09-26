// Server-side (export-time) HTML for the public Earth Watch site. Every page ships its full
// content in the HTML — crawlers and no-JS readers get the whole case — and the small site
// bundle (web/src/site/main.ts) only enhances: relative times, copy buttons, the "include
// unpublished" switch, the world pulse, and the in-browser proof check.
//
// Ledger content is public input: every interpolated string goes through `esc`, URLs are
// allow-listed to http(s), and JSON-LD is emitted with `<` escaped so it can't close its tag.
// Class names mirror web/src/watch.ts + styles.css so the site and dashboard look the same.

import { PUBLIC_STATUSES, TERMINAL_STATUSES, type Evidence, type Finding, type FindingEvent } from "../ledger/schema.js";
import { SITE } from "../site.config.js";
import type { SiteStats, RateCell } from "./export.js";

// TODO: import { GLOBAL_NATURE_VALUE } from "../clients/naturalvalue.js" once natural_value
// (a3ab7a9) is on main — these are its figures (2007 US$, 2011 vs 1997 biome areas).
const GLOBAL_NATURE_VALUE = {
  usdPerYear: { low: 1.25e14, high: 1.45e14 },
  source: "Costanza et al. 2014, “Changes in the global value of ecosystem services”, Global Environmental Change 26:152–158 (2007 US$)",
} as const;

// ---- primitives ---------------------------------------------------------------------------------

export const esc = (s: unknown): string =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

/** Only http(s) links from the ledger become hrefs (a zod `.url()` happily accepts `javascript:`). */
export const safeUrl = (u: unknown): string | null => (typeof u === "string" && /^https?:\/\/[^\s"<>]+$/i.test(u) ? u : null);

export function jsonLd(obj: unknown): string {
  return `<script type="application/ld+json">${JSON.stringify(obj).replace(/</g, "\\u003c").replace(/[\u2028\u2029]/g, "")}</script>`;
}

const safeStatus = (s: string) => (/^[a-z_]+$/.test(s) ? s : "unknown");
const words = (s: string) => s.replace(/_/g, " ");
const dateOf = (iso: string) => (iso.length >= 10 ? iso.slice(0, 10) : iso);
const clip = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n - 1).trimEnd()}…`);
const fmtLat = (v: number) => `${Math.abs(v).toFixed(2)}°${v < 0 ? "S" : "N"}`;
const fmtLon = (v: number) => `${Math.abs(v).toFixed(2)}°${v < 0 ? "W" : "E"}`;

/** "$3.4M" — order-of-magnitude money for headline tiles. */
export function fmtUsd(v: number): string {
  const a = Math.abs(v);
  const [d, u] = a >= 1e12 ? [1e12, "T"] : a >= 1e9 ? [1e9, "B"] : a >= 1e6 ? [1e6, "M"] : a >= 1e3 ? [1e3, "k"] : [1, ""];
  const x = v / d;
  return `$${Math.abs(x) >= 100 ? x.toFixed(0) : x.toPrecision(2).replace(/\.0$/, "")}${u}`;
}

export function formatRate(c: RateCell | undefined): string {
  if (!c || c.rate === null) return "no decided findings yet";
  return `${(c.rate * 100).toFixed(c.rate > 0 && c.rate < 0.1 ? 1 : 0)} % · ${c.falsePositives} of ${c.decided} decided`;
}

export function issueUrl(template: "right-of-reply" | "false-positive", f: { findingId: string; title: string }, repo: string = SITE.repo): string {
  const prefix = template === "right-of-reply" ? "Right of reply" : "False positive";
  return `${repo}/issues/new?template=${template}.md&title=${encodeURIComponent(clip(`${prefix}: ${f.title} (${f.findingId})`, 240))}`;
}

// ---- page context ---------------------------------------------------------------------------------

export interface Ctx {
  /** Directory depth of the page below the site root (0 = index.html, 3 = watch/case/<id>/). */
  depth: number;
  /** Site-relative path of this page ("" for the landing, "watch/case/<id>/"). */
  path: string;
  baseUrl: string | null;
  stats: SiteStats;
}

const root = (c: Ctx) => (c.depth === 0 ? "./" : "../".repeat(c.depth));
const rel = (c: Ctx, target: string) => (target === "" ? root(c) : `${c.depth === 0 ? "" : "../".repeat(c.depth)}${target}`);
const abs = (c: Ctx, path: string) => (c.baseUrl ? `${c.baseUrl}/${path}` : null);

export interface HeadSpec {
  title: string;
  description: string;
  type?: "website" | "article";
  noindex?: boolean;
  jsonld?: unknown[];
  publishedTime?: string;
  modifiedTime?: string;
}

/** <title>, description, canonical, Open Graph, Twitter card, robots, JSON-LD. */
export function head(c: Ctx, h: HeadSpec): string {
  const canonical = abs(c, c.path);
  const image = abs(c, SITE.ogImage);
  const desc = clip(h.description.replace(/\s+/g, " ").trim(), 180);
  const m: string[] = [
    `<title>${esc(h.title)}</title>`,
    `<meta name="description" content="${esc(desc)}" />`,
    canonical ? `<link rel="canonical" href="${esc(canonical)}" />` : "",
    h.noindex ? `<meta name="robots" content="noindex, follow" />` : "",
    `<meta property="og:site_name" content="${esc(SITE.name)}" />`,
    `<meta property="og:type" content="${h.type ?? "website"}" />`,
    `<meta property="og:title" content="${esc(h.title)}" />`,
    `<meta property="og:description" content="${esc(desc)}" />`,
    `<meta property="og:locale" content="${esc(SITE.locale)}" />`,
    canonical ? `<meta property="og:url" content="${esc(canonical)}" />` : "",
    image ? `<meta property="og:image" content="${esc(image)}" />` : "",
    image ? `<meta property="og:image:width" content="1200" /><meta property="og:image:height" content="630" />` : "",
    h.publishedTime ? `<meta property="article:published_time" content="${esc(h.publishedTime)}" />` : "",
    h.modifiedTime ? `<meta property="article:modified_time" content="${esc(h.modifiedTime)}" />` : "",
    `<meta name="twitter:card" content="${image ? "summary_large_image" : "summary"}" />`,
    `<meta name="twitter:title" content="${esc(h.title)}" />`,
    `<meta name="twitter:description" content="${esc(desc)}" />`,
    image ? `<meta name="twitter:image" content="${esc(image)}" />` : "",
    `<link rel="alternate" type="application/geo+json" href="${rel(c, "feed.geojson")}" title="Published findings (GeoJSON)" />`,
    ...(h.jsonld ?? []).map(jsonLd),
  ];
  return m.filter(Boolean).join("\n    ");
}

// ---- chrome -----------------------------------------------------------------------------------------

const BRAND_MARK = `<svg class="brand-mark" viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="8.25" fill="none" stroke="currentColor" stroke-width="1.5"/><ellipse cx="10" cy="10" rx="3.6" ry="8.25" fill="none" stroke="currentColor" stroke-width="1.2" opacity="0.55"/><path d="M1.9 10h16.2" stroke="currentColor" stroke-width="1.2" opacity="0.55"/></svg>`;

export function siteTop(c: Ctx, current: "landing" | "cases" | "trust" | null): string {
  const cur = (k: string) => (current === k ? ` aria-current="page"` : "");
  const home = rel(c, "");
  return `<header class="site-top">
      <div class="wrap site-top-in">
        <a class="brand" href="${home}">${BRAND_MARK}<span class="brand-name">${esc(SITE.name)}</span><span class="brand-sub">${esc(SITE.byline)}</span></a>
        <nav class="site-nav" aria-label="Site">
          <a href="${rel(c, "watch/")}"${cur("cases")}>Cases</a>
          <a href="${c.depth === 0 ? "" : home}#verify">Verify</a>
          <a href="${c.depth === 0 ? "" : home}#challenge" class="nav-opt">Challenge</a>
          ${c.stats.site.trust ? `<a href="${rel(c, "trust.html")}"${cur("trust")} class="nav-opt">Trust</a>` : ""}
          <a href="${esc(SITE.repo)}" rel="noopener">GitHub</a>
        </nav>
      </div>
    </header>`;
}

export function siteFoot(c: Ctx): string {
  const gen = c.stats.generatedAt.replace("T", " ").slice(0, 16);
  return `<footer class="site-foot">
      <div class="wrap">
        <h2 class="foot-h">Data sources &amp; attributions</h2>
        <ul class="attrib">
          <li><b>Global Forest Watch</b> — integrated deforestation alerts, World Resources Institute. CC BY 4.0.</li>
          <li><b>Copernicus</b> — contains modified Copernicus Sentinel data, processed via the Copernicus Data Space Ecosystem; CAMS, ERA5 and GloFAS information from the Copernicus services.</li>
          <li><b>NASA FIRMS</b> — we acknowledge the use of data and imagery from LANCE FIRMS operated by NASA’s Earth Science Data and Information System (ESDIS). Imagery: NASA GIBS (Blue Marble, Black Marble).</li>
          <li><b>Climate TRACE</b> — asset-level emissions inventory. CC BY 4.0.</li>
          <li><b>Our World in Data</b> — world pulse indicators. CC BY 4.0; upstream licences per indicator.</li>
          <li><b>GBIF</b> — GBIF.org occurrence data; licence per dataset (CC0, CC BY or CC BY-NC).</li>
          <li><b>NOAA</b> — ONI (CPC), OISST, Mauna Loa CO₂ (GML), Coral Reef Watch. U.S. Government work, public domain.</li>
          <li><b>EOG</b> — VIIRS Nightfire, Earth Observation Group, Payne Institute, Colorado School of Mines. Monthly and annual aggregates only.</li>
        </ul>
        <p class="foot-note">${esc(SITE.name)} — findings are machine-generated and AI-narrated; publication requires independent confirmation and human review. <a class="link" href="${esc(SITE.repo)}" rel="noopener">${esc(SITE.credit)}</a> (MIT) · <a class="link" href="${rel(c, "feed.json")}">feed.json</a> · <a class="link" href="${rel(c, "api/stats.json")}">stats.json</a> · snapshot ${esc(gen)} UTC</p>
      </div>
    </footer>`;
}

// ---- small pieces (mirror web/src/ui.ts + watch.ts) ------------------------------------------------------

const TIER_HINT = [
  "Tier 0 — informational, no publication gate",
  "Tier 1 — publishing needs one human approval",
  "Tier 2 — publishing needs two distinct human approvals; naming a party allowed",
  "Tier 3 — private notice + right-of-reply window before publication",
];

export const statusBadge = (s: string) => `<span class="status-badge status--${safeStatus(s)}"><span class="status-dot"></span>${esc(words(s))}</span>`;
export const tierBadge = (t: number) => {
  const ok = Number.isInteger(t) && t >= 0 && t <= 3;
  return `<span class="tier tier--${ok ? t : "x"}" title="${esc(ok ? TIER_HINT[t] : "Tier unknown")}">${ok ? `T${t}` : "T?"}</span>`;
};
const time = (iso: string, text = dateOf(iso), cls = "") => `<time${cls ? ` class="${cls}"` : ""} datetime="${esc(iso)}">${esc(text)}</time>`;
const copyBtn = (value: string) => `<button class="btn btn--ghost btn--xs" type="button" data-copy="${esc(value)}" hidden>Copy</button>`;
const hash = (h: string) => `<span class="hashrow"><code class="hash" title="${esc(h)}">${esc(h.slice(0, 12))}…${esc(h.slice(-6))}</code>${copyBtn(h)}</span>`;
const cmdline = (cmd: string, attrs = "") => `<div class="cmdline"><code class="cmd"${attrs}>${esc(cmd)}</code>${copyBtn(cmd)}</div>`;
const section = (title: string, body: string, count?: number | string, id?: string) =>
  `<section class="case-section"${id ? ` id="${id}"` : ""}><h2 class="section-h">${esc(title)}${count !== undefined ? `<span class="section-n">${esc(count)}</span>` : ""}</h2>${body}</section>`;

function caseRow(f: Finding, href: string, cls = ""): string {
  const meta = [f.aoi?.name ?? f.aoi?.id, `${f.rule.name}@${f.rule.version}`, `${f.evidence.length + (f.confirmed ? 1 : 0)} evidence`].filter(Boolean).join(" · ");
  return `<a class="case-row${cls ? ` ${cls}` : ""}" href="${esc(href)}"><span class="case-top">${statusBadge(f.status)}${tierBadge(f.tier)}${time(f.updatedAt, dateOf(f.updatedAt), "case-when")}</span><span class="case-title">${esc(f.title)}</span><span class="case-meta">${esc(meta)}</span></a>`;
}

// ---- markdown-lite (TRUST.md, narration) -------------------------------------------------------------------

function inline(s: string): string {
  return esc(s)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\[([^\]]+)\]\(((?:https?:\/\/|\.{0,2}\/|#)[^)\s]*)\)/g, '<a class="link" href="$2">$1</a>');
}

/** Pure: render the Markdown subset TRUST.md and narrations use. Text is escaped before any tag is added. */
export function renderMarkdown(md: string, headingOffset = 0): string {
  const html: string[] = [];
  let list: "ul" | "ol" | null = null;
  let para: string[] = [];
  let code: string[] | null = null;
  const flush = () => {
    if (para.length) html.push(`<p>${inline(para.join(" "))}</p>`);
    para = [];
  };
  const close = () => {
    if (list) html.push(`</${list}>`);
    list = null;
  };
  for (const raw of md.split("\n")) {
    const line = raw.trimEnd();
    if (code) {
      if (line.startsWith("```")) {
        html.push(`<pre><code>${esc(code.join("\n"))}</code></pre>`);
        code = null;
      } else code.push(raw);
      continue;
    }
    if (line.startsWith("```")) {
      flush();
      close();
      code = [];
      continue;
    }
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    const ul = /^\s*[-*]\s+(.*)$/.exec(line);
    const ol = /^\s*\d+\.\s+(.*)$/.exec(line);
    if (h) {
      flush();
      close();
      const lvl = Math.min(6, h[1]!.length + headingOffset);
      html.push(`<h${lvl}>${inline(h[2]!)}</h${lvl}>`);
    } else if (ul || ol) {
      flush();
      const kind = ul ? "ul" : "ol";
      if (list !== kind) {
        close();
        html.push(`<${kind}>`);
        list = kind;
      }
      html.push(`<li>${inline((ul ?? ol)![1]!)}</li>`);
    } else if (line.startsWith(">")) {
      flush();
      close();
      html.push(`<blockquote>${inline(line.replace(/^>\s?/, ""))}</blockquote>`);
    } else if (line === "") {
      flush();
      close();
    } else {
      close();
      para.push(line);
    }
  }
  if (code) html.push(`<pre><code>${esc(code.join("\n"))}</code></pre>`);
  flush();
  close();
  return html.join("\n");
}

// ---- landing -------------------------------------------------------------------------------------------------

export function landingPage(c: Ctx, published: Finding[]): { head: string; body: string } {
  const s = c.stats;
  const base = c.baseUrl ?? "https://<this-site>";
  const site = c.baseUrl ?? SITE.repo;
  const orgId = `${site}#org`;
  const ld = [
    { "@context": "https://schema.org", "@type": "Organization", "@id": orgId, name: SITE.organization.name, url: c.baseUrl ?? SITE.organization.url, sameAs: [SITE.repo] },
    { "@context": "https://schema.org", "@type": "WebSite", name: SITE.name, url: abs(c, "") ?? undefined, description: SITE.description, publisher: { "@id": orgId } },
    datasetLd(c, orgId),
  ];
  const dots = published
    .map((f) => {
      const [w, so, e, n] = f.bbox;
      const x = ((w + e) / 2 + 180).toFixed(2);
      const y = (90 - (so + n) / 2).toFixed(2);
      return `<a href="watch/case/${esc(f.findingId)}/"><title>${esc(f.title)}</title><circle class="dot-halo" cx="${x}" cy="${y}" r="1.8"/><circle class="dot-core" cx="${x}" cy="${y}" r="1.8"/></a>`;
    })
    .join("");
  const fp = s.falsePositiveRate.overall;
  const fpV = fp.rate === null ? "n/a" : `${(fp.rate * 100).toFixed(fp.rate > 0 && fp.rate < 0.1 ? 1 : 0)} %`;
  const kpi = (k: string, v: string, sub: string, title = "", cls = "") =>
    `<div class="kpi${cls}"${title ? ` title="${esc(title)}"` : ""}><div class="kpi-k">${esc(k)}</div><div class="kpi-v">${v}</div><div class="kpi-sub">${sub}</div></div>`;
  const sweep = s.lastSweep
    ? kpi("Last sweep", time(s.lastSweep.at, dateOf(s.lastSweep.at), "ago"), esc(s.lastSweep.at.replace("T", " ").slice(0, 16) + " UTC"), `Sweep ${s.lastSweep.sweepId}`)
    : kpi("Last sweep", "—", `site built ${esc(dateOf(s.generatedAt))}`);
  const rootK = s.ledger.root
    ? kpi("Ledger root", `<code class="hash" title="${esc(s.ledger.root)}">${esc(s.ledger.root.slice(0, 10))}…</code>${copyBtn(s.ledger.root)}`, `${s.ledger.size} signed entries`, "", " kpi--root")
    : kpi("Ledger root", "empty", "no entries yet", "", " kpi--root");
  const latest = published.length
    ? published.slice(0, 6).map((f) => caseRow(f, `watch/case/${f.findingId}/`)).join("")
    : `<p class="band-lede">Nothing has passed confirmation and review yet. Every candidate is still listed — marked unpublished — in the <a class="link" href="watch/?all=1">cases index</a>.</p>`;

  const body = `${siteTop(c, "landing")}
    <main>
      <section class="hero wrap" aria-labelledby="hero-h">
        <p class="eyebrow">Open planetary monitoring</p>
        <h1 class="hero-h" id="hero-h">${SITE.tagline.map(esc).join("<br />")}</h1>
        <p class="hero-lede">${esc(SITE.description)}</p>
        <p class="hero-lede hero-lede--sub">An AI writes up what the sweep finds; the ledger refuses to publish anything that skipped independent confirmation or human review — and anyone can re-check it without trusting us.</p>
        <div class="hero-cta"><a class="btn btn--primary btn--lg" href="watch/">Browse cases</a><a class="btn btn--lg" href="#verify">Verify it yourself</a></div>
      </section>
      <section class="wrap" aria-label="Where the published cases are">
        <figure class="world">
          <img class="world-img" src="https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi?SERVICE=WMS&amp;REQUEST=GetMap&amp;VERSION=1.1.1&amp;LAYERS=VIIRS_Black_Marble&amp;STYLES=&amp;SRS=EPSG:4326&amp;BBOX=-180,-90,180,90&amp;WIDTH=1440&amp;HEIGHT=720&amp;FORMAT=image/jpeg" width="1440" height="720" alt="The Earth at night (NASA Black Marble) with the locations of ${published.length} published case${published.length === 1 ? "" : "s"}" decoding="async" fetchpriority="high" />
          <svg class="world-dots" viewBox="0 0 360 180" preserveAspectRatio="none" role="group" aria-label="Published case locations">${dots}</svg>
          <figcaption class="world-cap"><span>${published.length ? `${published.length} published case${published.length === 1 ? "" : "s"}` : "No published cases yet"}</span><span>NASA Black Marble via GIBS</span></figcaption>
        </figure>
      </section>
      <section class="wrap kpis${s.livingValue ? " kpis--6" : ""}" aria-label="The ledger at a glance">
        ${kpi("Published cases", String(s.cases.public), "passed confirmation + review")}
        ${kpi("Independently confirmed", String(s.cases.confirmed), `of ${s.cases.total} finding${s.cases.total === 1 ? "" : "s"} in the ledger`)}
        ${kpi("False-positive rate", fpV, fp.rate === null ? "no decided findings yet" : `${fp.falsePositives} of ${fp.decided} decided`, s.falsePositiveRate.definition)}
        ${s.livingValue ? kpi("Living value", `≈ ${esc(fmtUsd(s.livingValue.usdPerYear))}<span class="kpi-unit">/yr</span>`, `value of nature at stake in ${s.livingValue.cases} open case${s.livingValue.cases === 1 ? "" : "s"}, USD/yr, order of magnitude`, s.livingValue.definition, " kpi--living") : ""}
        ${sweep}
        ${rootK}
      </section>
      <p class="wrap global-value">Nature does ≈ $${GLOBAL_NATURE_VALUE.usdPerYear.low / 1e12}–${GLOBAL_NATURE_VALUE.usdPerYear.high / 1e12} trillion a year of work for us — more than global GDP. <cite>${esc(GLOBAL_NATURE_VALUE.source)}</cite></p>
      <section class="wrap band" aria-labelledby="how-h">
        <h2 class="band-h" id="how-h">How a case is made</h2>
        <p class="band-lede">A rule decides what counts as a finding. The AI explains it. The ledger refuses to publish anything that skipped a step.</p>
        <ol class="pipeline">
          <li><span class="pipe-n">01</span><h3>Detect</h3><p>Deterministic rules sweep watched places with open data — forest alerts, active fires, methane columns, flares. A rule fires; a candidate opens with its evidence.</p></li>
          <li><span class="pipe-n">02</span><h3>Verify</h3><p>A candidate stays unpublished until an independent second signal — another sensor, provider or a later revisit — confirms it. Unconfirmed candidates expire.</p></li>
          <li><span class="pipe-n">03</span><h3>Attribute</h3><p>Assets and institutions, never people — and only through a cited registry, with two human reviewers before any party is named.</p></li>
          <li><span class="pipe-n">04</span><h3>Route</h3><p>The case goes to whoever can act on it. High-stakes cases get a 72-hour private notice and a right of reply before they are public.</p></li>
          <li><span class="pipe-n">05</span><h3>Track</h3><p>Replies, resolutions, corrections and false positives are new signed events. Nothing is edited. Nothing is deleted.</p></li>
        </ol>
      </section>
      <section class="wrap band" aria-labelledby="latest-h">
        <div class="band-row"><h2 class="band-h" id="latest-h">Latest published cases</h2><a class="link" href="watch/">All cases →</a></div>
        <div class="case-grid">${latest}</div>
      </section>
      <section class="wrap band" id="pulse-band" aria-labelledby="pulse-h" hidden>
        <h2 class="band-h" id="pulse-h">World pulse</h2>
        <p class="band-lede">The context every case sits in: civilization’s and the living planet’s vital signs from Our World in Data, each with an honest direction — good news and bad.</p>
        <div id="pulse"></div>
      </section>
      <section class="wrap band" id="verify" aria-labelledby="verify-h">
        <h2 class="band-h" id="verify-h">How to verify</h2>
        <p class="band-lede">The ledger is a transparency log: every event is signed (DSSE, Ed25519), hashed into an RFC 6962 Merkle tree and sealed by a signed checkpoint. Three commands, no account, no trust in this website:</p>
        <ol class="steps-v">
          <li><h3>Mirror the log</h3><p>The raw entries, the signed checkpoint and the public key — static files on this site.</p>${cmdline(`mkdir ew && cd ew && curl -sf --remote-name-all ${base}/ledger/entries.jsonl ${base}/ledger/checkpoint && curl -sf ${base}/ledger/pub -o ledger.pub`, c.baseUrl ? "" : ' data-base-cmd=""')}</li>
          <li><h3>Re-derive everything</h3><p>Checks every signature, the canonical form of every entry, every trust rule (no publication without confirmation and review), and that the root matches the checkpoint.</p>${cmdline("EARTHDECK_LEDGER_DIR=. npx -y earthdeck ledger verify")}</li>
          <li><h3>Prove history wasn’t rewritten</h3><p>Keep today’s checkpoint. Next time, check that the new log extends it — a consistency proof, not a promise.</p>${cmdline("EARTHDECK_LEDGER_DIR=. npx -y earthdeck ledger verify --trusted ../saved-checkpoint")}</li>
        </ol>
        <p class="band-note">Machine-readable: <a class="link" href="feed.json">feed.json</a> · <a class="link" href="feed.geojson">feed.geojson</a> · <a class="link" href="api/stats.json">stats.json</a> · <a class="link" href="schema/finding-event.v1.json">event schema</a> · <a class="link" href="ledger/checkpoint">checkpoint</a></p>
      </section>
      <section class="wrap band" id="challenge" aria-labelledby="challenge-h">
        <h2 class="band-h" id="challenge-h">How to challenge</h2>
        <div class="challenge-grid">
          <div><h3>Right of reply</h3><p>If a case names or affects you, reply. Your reply is recorded as a signed event and shown verbatim on the case page, next to the evidence. Every case page has a button that opens a pre-filled request.</p></div>
          <div><h3>Report a false positive</h3><p>Think a case is wrong? Tell us why. If it is, it becomes a <em>false positive</em> — publicly, forever — and counts against its rule’s published false-positive rate.</p></div>
        </div>
        <div class="challenge-actions">${challengeButtons(s, null)}</div>
      </section>
    </main>
    ${siteFoot(c)}`;
  return {
    head: head(c, { title: `${SITE.name} — ${SITE.tagline.join(" ")}`, description: SITE.description, jsonld: ld }),
    body,
  };
}

function datasetLd(c: Ctx, orgId: string): Record<string, unknown> {
  return {
    "@context": "https://schema.org",
    "@type": "Dataset",
    "@id": `${abs(c, "watch/") ?? "watch/"}#dataset`,
    name: `${SITE.name} findings ledger`,
    description:
      "Every environmental finding Earth Watch has opened — candidates, confirmations, reviews, publications, replies and false positives — as signed in-toto/DSSE events in an RFC 6962 transparency log with a signed checkpoint.",
    url: abs(c, "watch/") ?? undefined,
    creator: { "@id": orgId, "@type": "Organization", name: SITE.organization.name },
    ...(SITE.dataLicense ? { license: SITE.dataLicense } : {}),
    isAccessibleForFree: true,
    dateModified: c.stats.generatedAt,
    keywords: ["environmental monitoring", "deforestation", "wildfire", "methane", "gas flaring", "earth observation", "transparency log"],
    distribution: [
      { "@type": "DataDownload", encodingFormat: "application/json", contentUrl: abs(c, "feed.json") ?? "feed.json" },
      { "@type": "DataDownload", encodingFormat: "application/geo+json", contentUrl: abs(c, "feed.geojson") ?? "feed.geojson" },
      { "@type": "DataDownload", encodingFormat: "application/jsonl", contentUrl: abs(c, "ledger/entries.jsonl") ?? "ledger/entries.jsonl" },
    ],
  };
}

function challengeButtons(s: SiteStats, f: Finding | null): string {
  const repo = s.site.repo;
  const reply = f ? issueUrl("right-of-reply", f, repo) : `${repo}/issues/new?template=right-of-reply.md`;
  const fp = f ? issueUrl("false-positive", f, repo) : `${repo}/issues/new?template=false-positive.md`;
  const contact = s.site.contact && /^[^\s@<>"']+@[^\s@<>"']+$/.test(s.site.contact) ? s.site.contact : null;
  const subject = encodeURIComponent(f ? `Right of reply: ${f.title} (${f.findingId})` : `${SITE.name}: right of reply`);
  return [
    `<a class="btn btn--primary" href="${esc(reply)}" rel="noopener">Right of reply</a>`,
    `<a class="btn" href="${esc(fp)}" rel="noopener">Report a false positive</a>`,
    contact ? `<a class="btn" href="mailto:${esc(contact)}?subject=${esc(subject)}">Email ${esc(contact)}</a>` : "",
  ].join("");
}

// ---- cases index ----------------------------------------------------------------------------------------------

export function watchIndexPage(c: Ctx, findings: Finding[]): { head: string; body: string } {
  const s = c.stats;
  const isPublic = (f: Finding) => PUBLIC_STATUSES.includes(f.status);
  const pub = findings.filter(isPublic);
  const rows = findings.map((f) => `<li class="case-item${isPublic(f) ? "" : " is-unpublished"}">${caseRow(f, `case/${f.findingId}/`)}</li>`).join("");
  const orgId = `${c.baseUrl ?? SITE.repo}#org`;
  const crumbs = c.baseUrl
    ? {
        "@context": "https://schema.org",
        "@type": "BreadcrumbList",
        itemListElement: [
          { "@type": "ListItem", position: 1, name: SITE.name, item: abs(c, "") },
          { "@type": "ListItem", position: 2, name: "Cases", item: abs(c, "watch/") },
        ],
      }
    : null;
  const unpublished = findings.length - pub.length;
  const body = `${siteTop(c, "cases")}
    <main class="wrap wrap--narrow site-watch">
      <header class="page-head">
        <h1 class="page-h">Cases</h1>
        <p class="band-lede">Every published finding with its evidence, independent confirmation, review trail and a proof against the signed ledger. Unpublished findings — candidates, false positives, expired — stay in the ledger too.</p>
      </header>
      <div class="watch-head">
        <div class="ledger-strip">
          <div class="ledger-nums"><span class="ledger-num"><b>${pub.length}</b> published</span><span class="ledger-num"><b>${findings.length}</b> in ledger</span><span class="ledger-num"><b>${s.ledger.size}</b> entries</span></div>
          ${s.ledger.root ? `<div class="ledger-root"><span class="ledger-root-k">Root</span><code class="hash" title="${esc(s.ledger.root)}">${esc(s.ledger.root.slice(0, 10))}…</code>${copyBtn(s.ledger.root)}</div>` : ""}
        </div>
        ${unpublished ? `<button class="vis-toggle" type="button" role="switch" aria-checked="false" aria-controls="case-list" hidden><span class="vis-knob"></span><span class="vis-label">Include ${unpublished} unpublished — candidates, false positives, expired</span></button>` : ""}
      </div>
      <ul class="case-list list--public" id="case-list">${rows}</ul>
      ${pub.length ? "" : `<div class="empty empty--watch only-public"><div class="empty-orb"></div><h2 class="empty-title">Nothing published yet</h2><p class="empty-text">${findings.length ? `The ledger holds ${findings.length} finding${findings.length === 1 ? "" : "s"}; none has passed independent confirmation and human review yet. Switch on “Include unpublished” to see them — including the ones that turned out wrong.` : "The sweep hasn’t opened a finding yet."}</p></div>`}
    </main>
    ${siteFoot(c)}`;
  return {
    head: head(c, {
      title: `Cases · ${SITE.name}`,
      description: `${pub.length} published environmental case${pub.length === 1 ? "" : "s"} — each with its evidence, independent confirmation, human review and a proof against a signed, append-only ledger.`,
      jsonld: [datasetLd(c, orgId), ...(crumbs ? [crumbs] : [])],
    }),
    body,
  };
}

// ---- case page ---------------------------------------------------------------------------------------------------

export interface CaseData {
  finding: Finding;
  events: FindingEvent[];
  inclusion: null | { index: number; leafHash: string; proof: string[]; size: number; root: string };
}

const MAIN_PATH = ["candidate", "confirmed", "published", "notified", "resolved"];
const NOT_PUBLIC: Record<string, string> = {
  candidate: "a candidate — one signal, still waiting for an independent second one",
  confirmed: "confirmed by an independent second signal and waiting for human review",
  expired: "expired — no independent confirmation arrived in time",
  false_positive: "a false positive — reviewers ruled the signal out",
};

export function casePage(c: Ctx, d: CaseData): { head: string; body: string } {
  const f = d.finding;
  const s = c.stats;
  const isPublic = PUBLIC_STATUSES.includes(f.status);
  const pubEv = d.events.find((e) => e.kind === "status_changed" && e.to === "published");
  const published = pubEv?.at;
  const where = f.aoi?.name ?? f.aoi?.id;
  const [w, so, e, n] = f.bbox;

  const facts: [string, string][] = [
    ["Rule", `${f.rule.name} v${f.rule.version}`],
    ...(f.aoi?.tags?.length ? ([["Tags", f.aoi.tags.join(", ")]] as [string, string][]) : []),
    ["Confirmed", f.confirmed ? `Yes — independent ${f.confirmed.independence} signal, ${dateOf(f.confirmed.at)}` : "Not yet — single signal"],
    ...(f.attribution ? ([["Subject", `${f.attribution.subject.kind}: ${f.attribution.subject.name}`]] as [string, string][]) : []),
    ...(f.attribution?.party ? ([["Party", `${f.attribution.party.name} (via ${f.attribution.party.registry.name}; ${f.attribution.reviewers.length} reviewers)`]] as [string, string][]) : []),
    ["Rule FP rate", formatRate(s.falsePositiveRate.byRule[f.rule.name])],
    ["Location", `${fmtLat((so + n) / 2)} ${fmtLon((w + e) / 2)}`],
  ];
  const ev = [...f.evidence.map((x) => evidenceHtml(x, false)), ...(f.confirmed ? [evidenceHtml(f.confirmed.signal, true)] : [])];
  const ctxHtml = contextHtml(f);
  const replies = rightOfReplyHtml(f);
  const hist = [...f.history].reverse().map((h) => tl(h.at, `${words(h.kind)} → ${words(h.status)}`, h.actor)).join("");

  const body = `${siteTop(c, "cases")}
    <main class="wrap wrap--narrow site-watch">
      <nav class="crumbs" aria-label="Breadcrumb"><a class="btn btn--ghost btn--back" href="../../">All cases</a></nav>
      <article class="case" itemscope itemtype="https://schema.org/Report">
        ${heroHtml(f)}
        <header class="case-head">
          <div class="case-top">${statusBadge(f.status)}${tierBadge(f.tier)}</div>
          <h1 class="case-h" itemprop="headline">${esc(f.title)}</h1>
          <p class="case-sub">${[where ? esc(where) : "", `observed ${time(f.observedAt)}`, published ? `published ${time(published)}` : `opened ${time(f.createdAt)}`, `by ${esc(f.createdBy)}`].filter(Boolean).join(" · ")}</p>
        </header>
        <p class="case-summary" itemprop="abstract">${esc(f.summary)}</p>
        ${isPublic ? "" : `<p class="banner banner--muted">Not published. This finding is ${esc(NOT_PUBLIC[f.status] ?? words(f.status))}. It is shown because nothing is ever removed from the ledger — mistakes included.</p>`}
        ${f.retracted ? `<p class="banner banner--danger">Retracted ${time(f.retracted.at)} — ${esc(f.retracted.reason)}</p>` : ""}
        ${f.narration ? `<div class="narrative" itemprop="articleBody">${renderMarkdown(f.narration.text, 1)}<p class="disclosure">AI-drafted by ${esc(f.narration.model.id)}, ${f.narration.reviewedBy ? `reviewed by ${esc(f.narration.reviewedBy)}` : "not yet human-reviewed"}. Every claim cites evidence below.</p></div>` : ""}
        ${stepperHtml(f)}
        <dl class="kv kv--case">${facts.map(([k, v]) => `<dt>${esc(k)}</dt><dd${k === "Rule FP rate" ? ` title="${esc(s.falsePositiveRate.definition)}"` : ""}>${esc(v)}</dd>`).join("")}</dl>
        ${section("Evidence", ev.join(""), ev.length)}
        ${ctxHtml ? section("Context", ctxHtml) : ""}
        ${f.blindSpots?.length ? section("Blind spots", `<p class="section-lede">What this rule cannot see — read the finding with these in mind.</p><ul class="blind">${f.blindSpots.map((b) => `<li>${esc(b)}</li>`).join("")}</ul>`, f.blindSpots.length) : ""}
        ${section(isPublic ? "Why this was published" : "Why this is not published", whyHtml(f, pubEv))}
        ${replies ? section("Right of reply", replies) : ""}
        ${section("Challenge this finding", `<p class="section-lede">Named in this finding, affected by it, or think it’s wrong? Replies are recorded in the ledger and shown verbatim on this page. Corrections are new signed events — never silent edits.</p><div class="challenge-actions">${challengeButtons(s, f)}</div>`, undefined, "challenge")}
        ${section("History", `<ol class="tl">${hist}</ol>`, f.history.length)}
        ${section("Verify", verifyHtml(c, d), undefined, "verify")}
      </article>
    </main>
    ${siteFoot(c)}`;

  const orgId = `${c.baseUrl ?? SITE.repo}#org`;
  const geo = f.geometry.type === "Point"
    ? { "@type": "GeoCoordinates", latitude: f.geometry.coordinates[1], longitude: f.geometry.coordinates[0] }
    : { "@type": "GeoShape", box: `${so} ${w} ${n} ${e}` };
  const report = {
    "@context": "https://schema.org",
    "@type": "Report",
    headline: clip(f.title, 110),
    description: f.summary,
    url: abs(c, c.path) ?? undefined,
    image: abs(c, SITE.ogImage) ?? undefined,
    datePublished: published ?? f.createdAt,
    dateCreated: f.createdAt,
    dateModified: f.updatedAt,
    author: { "@type": "Organization", "@id": orgId, name: SITE.organization.name, url: SITE.organization.url },
    publisher: { "@type": "Organization", "@id": orgId, name: SITE.organization.name, url: SITE.organization.url },
    about: { "@type": "Place", name: where ?? `${fmtLat((so + n) / 2)} ${fmtLon((w + e) / 2)}`, geo },
    keywords: [f.rule.name, ...(f.aoi?.tags ?? [])].join(", "),
    isBasedOn: [...f.evidence, ...(f.confirmed ? [f.confirmed.signal] : [])].map((x) => safeUrl(x.href)).filter(Boolean),
    isPartOf: { "@id": `${abs(c, "watch/") ?? "watch/"}#dataset` },
    ...(f.narration ? { creativeWorkStatus: isPublic ? "Published" : "Draft" } : {}),
  };
  return {
    head: head(c, {
      title: `${f.title} · ${SITE.name}`,
      description: f.summary,
      type: "article",
      noindex: !isPublic,
      publishedTime: published,
      modifiedTime: f.updatedAt,
      jsonld: [report],
    }),
    body,
  };
}

function heroHtml(f: Finding): string {
  const [w, s, e, n] = f.bbox;
  const cx = (w + e) / 2;
  const cy = (s + n) / 2;
  const spanLon = Math.min(60, Math.max(2.4, (e - w) * 4, ((n - s) * 4 * 16) / 9));
  const spanLat = (spanLon * 9) / 16;
  const W = cx - spanLon / 2;
  const E = cx + spanLon / 2;
  const S = cy - spanLat / 2;
  const N = cy + spanLat / 2;
  const px = (lon: number, lat: number) => `${(((lon - W) / (E - W)) * 800).toFixed(1)},${(((N - lat) / (N - S)) * 450).toFixed(1)}`;
  let shapes = "";
  const g = f.geometry;
  const rings = g.type === "Polygon" ? g.coordinates : g.type === "MultiPolygon" ? g.coordinates.flat() : [];
  for (const ring of rings) shapes += `<polygon points="${ring.map((p) => px(p[0]!, p[1]!)).join(" ")}"/>`;
  if (g.type === "Point") {
    const [x, y] = px(g.coordinates[0]!, g.coordinates[1]!).split(",");
    shapes += `<circle cx="${x}" cy="${y}" r="18"/><circle cx="${x}" cy="${y}" r="5"/>`;
  }
  const q = `SERVICE=WMS&amp;REQUEST=GetMap&amp;VERSION=1.1.1&amp;LAYERS=BlueMarble_NextGeneration&amp;STYLES=&amp;SRS=EPSG:4326&amp;BBOX=${[W, S, E, N].map((v) => v.toFixed(4)).join(",")}&amp;WIDTH=800&amp;HEIGHT=450&amp;FORMAT=image/jpeg`;
  const where = f.aoi?.name ?? "the finding";
  return `<figure class="case-hero"><img class="case-hero-img" src="https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi?${q}" width="800" height="450" alt="${esc(`Cloud-free satellite view around ${where}, with the finding area outlined`)}" decoding="async" fetchpriority="high" /><svg class="case-hero-geom" viewBox="0 0 800 450" aria-hidden="true">${shapes}</svg><figcaption class="case-hero-cap"><span>${esc(`${fmtLat(cy)} ${fmtLon(cx)}`)}</span><span>NASA Blue Marble via GIBS · outline = finding area</span></figcaption></figure>`;
}

function stepperHtml(f: Finding): string {
  const taken: string[] = [];
  for (const h of f.history) if (taken[taken.length - 1] !== h.status) taken.push(h.status);
  if (taken[taken.length - 1] !== f.status) taken.push(f.status);
  let future: string[] = [];
  if (!TERMINAL_STATUSES.includes(f.status)) {
    const i = MAIN_PATH.indexOf(f.status);
    future = i >= 0 ? MAIN_PATH.slice(i + 1) : ["resolved"];
    if (f.tier < 3) future = future.filter((x) => x !== "notified");
  }
  const li = (st: string, state: string) =>
    `<li class="step step--${state} status--${safeStatus(st)}"${state === "current" ? ' aria-current="step"' : ""}><span class="step-dot"></span><span class="step-label">${esc(words(st))}</span></li>`;
  return `<ol class="steps" aria-label="Case lifecycle">${taken.map((st, i) => li(st, i === taken.length - 1 ? "current" : "done")).join("")}${future.map((st) => li(st, "future")).join("")}</ol>`;
}

function evidenceHtml(e: Evidence, confirming: boolean): string {
  const vals = e.values && Object.keys(e.values).length
    ? `<div class="chips">${Object.entries(e.values).map(([k, v]) => `<span class="chip chip--num"><span class="chip-k">${esc(k)}</span> ${esc(v)}</span>`).join("")}</div>`
    : "";
  const href = safeUrl(e.href);
  return `<div class="evidence${confirming ? " evidence--confirm" : ""}"><div class="evidence-top"><span class="evidence-kind">${esc(e.kind)}</span><span class="evidence-src">${esc(e.source)}</span>${confirming ? '<span class="evidence-flag">Confirming signal</span>' : ""}</div>${e.summary ? `<p class="evidence-sum">${esc(e.summary)}</p>` : ""}${vals}<div class="evidence-meta">${time(e.datetime)} · ${esc(e.method.name)} v${esc(e.method.version)} · <code>${esc(e.id)}</code></div>${href ? `<a class="link" href="${esc(href)}" rel="noopener nofollow">Source ↗</a>` : ""}</div>`;
}

function contextHtml(f: Finding): string {
  const out: string[] = [];
  const b = f.context?.baseline;
  if (b && Number.isFinite(b.aoiValue) && Number.isFinite(b.regionalValue)) {
    const max = Math.max(Math.abs(b.aoiValue), Math.abs(b.regionalValue)) || 1;
    const ratio = b.ratio ?? (b.regionalValue !== 0 ? b.aoiValue / b.regionalValue : null);
    out.push(
      `<div class="baseline"><svg viewBox="0 0 64 64" class="baseline-ring" aria-hidden="true"><circle cx="32" cy="32" r="24" class="ring-outer" style="opacity:${(0.25 + 0.75 * (Math.abs(b.regionalValue) / max)).toFixed(3)}"/><circle cx="32" cy="32" r="11" class="ring-inner" style="opacity:${(0.25 + 0.75 * (Math.abs(b.aoiValue) / max)).toFixed(3)}"/></svg><div class="baseline-text"><div class="baseline-ratio">${ratio === null ? "—" : `${esc(ratio.toFixed(2))}×`}</div><div class="baseline-cap">AOI vs its ${esc(b.ringKm)} km neighbourhood</div><dl class="kv kv--tight"><dt>AOI</dt><dd class="num">${esc(b.aoiValue)}</dd><dt>Ring</dt><dd class="num">${esc(b.regionalValue)}</dd><dt>Metric</dt><dd>${esc(b.metric)}</dd></dl></div></div>`,
    );
  }
  const chips: string[] = [];
  if (f.context?.enso) chips.push(`<span class="chip">ENSO ${esc(f.context.enso.phase)} · ONI ${f.context.enso.oni >= 0 ? "+" : ""}${esc(f.context.enso.oni)}</span>`);
  for (const x of f.context?.events ?? []) chips.push(`<span class="chip">${esc(x.category)}: ${esc(x.title)}</span>`);
  if (chips.length) out.push(`<div class="chips">${chips.join("")}</div>`);
  if (f.context?.notes?.length) out.push(`<ul class="notes">${f.context.notes.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>`);
  return out.join("");
}

function tl(at: string | null, what: string, sub: string, cls = ""): string {
  return `<li class="tl-item${cls ? ` ${cls}` : ""}"><span class="tl-dot"></span>${at ? time(at, dateOf(at), "tl-when") : '<span class="tl-when"></span>'}<span class="tl-what">${esc(what)}</span>${sub ? `<span class="tl-sub">${esc(sub)}</span>` : ""}</li>`;
}

function rightOfReplyHtml(f: Finding): string {
  if (!f.notifications.length && !f.replies.length) return "";
  const items = f.notifications.map((x) => tl(x.at, `Notified ${x.to.kind} · ${x.to.name}`, `Public from ${dateOf(x.publicAt)}`));
  items.push(...f.replies.map((r) => tl(r.receivedAt, `Reply from ${r.from}`, `“${r.text}”`, "tl--reply")));
  if (f.notifications.length && !f.replies.length) items.push(tl(null, "No response recorded yet", "", "tl--waiting"));
  return `<ol class="tl">${items.join("")}</ol>`;
}

function check(ok: boolean, text: string): string {
  return `<li class="check ${ok ? "check--ok" : "check--no"}"><span class="check-mark" aria-hidden="true">${ok ? "✓" : "–"}</span><span>${esc(text)}<span class="sr-only">${ok ? " — met" : " — not met"}</span></span></li>`;
}

function whyHtml(f: Finding, pub: FindingEvent | undefined): string {
  const needed = f.tier >= 2 ? 2 : f.tier >= 1 ? 1 : 0;
  const approvers = [...new Set(f.reviews.filter((r) => r.decision === "approve" && r.tier >= f.tier).map((r) => r.actor))];
  const sources = [...new Set(f.evidence.map((x) => x.source))];
  const items = [
    check(f.evidence.length > 0, `Evidence — ${f.evidence.length} piece${f.evidence.length === 1 ? "" : "s"} from ${sources.join(", ")}`),
    check(f.confirmed !== null, f.confirmed ? `Independent confirmation — a different ${f.confirmed.independence} (${f.confirmed.signal.source}), ${dateOf(f.confirmed.at)}` : "Independent confirmation — not yet"),
    check(
      approvers.length >= needed,
      needed === 0 ? "Human approval — not required at tier 0" : `Human approval — ${approvers.length} of ${needed} needed at tier ${f.tier}${approvers.length ? ` (${approvers.join(", ")})` : ""}`,
    ),
  ];
  if (f.tier >= 3) {
    const notice = f.notifications.find((x) => x.to.kind !== "public");
    items.push(check(!!notice, notice ? `Private notice to ${notice.to.name} — public from ${dateOf(notice.publicAt)}` : "Private notice + right-of-reply window — not yet"));
  }
  if (f.narration) items.push(check(true, `Narration — AI-drafted by ${f.narration.model.id}${f.narration.reviewedBy ? `, reviewed by ${f.narration.reviewedBy}` : ""}`));
  let detail = "";
  if (pub && pub.kind === "status_changed") {
    const rows: [string, string][] = [["Published", `${dateOf(pub.at)} by ${pub.actor}`]];
    // `gates` is written by newer publishers; render whatever it holds, generically.
    const gates = (pub as unknown as { gates?: unknown }).gates;
    const g = gates && typeof gates === "object" && !Array.isArray(gates) ? (gates as Record<string, unknown>) : {};
    for (const [k, v] of Object.entries(g)) rows.push([humanKey(k), show(v)]);
    if (!("policy" in g) && !("policyVersion" in g)) rows.push(["Policy", "version not recorded on this event"]);
    if (pub.reason) rows.push(["Note", pub.reason]);
    detail = `<dl class="kv gates-detail">${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("")}</dl>`;
  } else {
    detail = `<p class="section-lede gates-detail">Publication is decided by the ledger’s rules, not by the AI: the event that publishes a finding is refused unless every gate above is met.</p>`;
  }
  return `<ul class="checks">${items.join("")}</ul>${detail}`;
}

function humanKey(k: string): string {
  const s = k.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}
function show(v: unknown): string {
  if (Array.isArray(v)) return v.map(show).join(", ");
  if (v && typeof v === "object") return JSON.stringify(v);
  return String(v);
}

function verifyHtml(c: Ctx, d: CaseData): string {
  const f = d.finding;
  const cpText = c.stats.ledger.checkpoint;
  const inc = d.inclusion;
  const cmd = `npx -y earthdeck ledger verify --remote ${c.baseUrl ?? "https://<this-site>"}`;
  const rows: string[] = [];
  const row = (k: string, v: string) => rows.push(`<dt>${esc(k)}</dt><dd>${v}</dd>`);
  if (cpText) {
    const [origin, size] = cpText.split("\n");
    row("Checkpoint", esc(`${origin} · ${size} entries`));
  }
  if (c.stats.ledger.root) row("Signed root", hash(c.stats.ledger.root));
  row("This case", esc(`${f.eventCount} signed event${f.eventCount === 1 ? "" : "s"}`));
  if (inc) {
    row("Leaf", esc(`#${inc.index} of ${inc.size} — this case’s latest event`));
    row("Leaf hash", hash(inc.leafHash));
    row("Proof", `<details class="proof-path"><summary>${inc.proof.length}-hash audit path</summary><ol class="proof-list">${inc.proof.map((h) => `<li>${esc(h)}</li>`).join("")}</ol></details>`);
  }
  row("Last event", hash(f.lastEventHash));
  if (cpText) row("Note", `<details class="proof-path"><summary>Checkpoint text</summary><pre class="checkpoint-text">${esc(cpText)}</pre></details>`);
  const checks = [
    "Checkpoint signed by the published ledger key (Ed25519)",
    "This case’s latest event is in the log’s hash tile",
    "Its audit path rebuilds the signed Merkle root",
  ]
    .map((t, i) => `<li class="check check--wait" data-check="${i}"><span class="check-mark" aria-hidden="true">…</span><span>${esc(t)}</span></li>`)
    .join("");
  return `<div class="verify" data-finding="${esc(f.findingId)}"${inc ? ` data-leaf="${esc(inc.leafHash)}" data-index="${inc.index}" data-size="${inc.size}" data-root="${esc(inc.root)}" data-proof="${esc(inc.proof.join(","))}"` : ""}>
          <p class="section-lede verify-live" hidden>Checked in your browser just now, against the files this site serves:</p>
          <ul class="checks checks--verify" hidden aria-live="polite">${checks}</ul>
          <noscript><p class="section-lede">Turn on JavaScript to check this proof in your browser — or run the command below.</p></noscript>
          <dl class="kv">${rows.join("")}</dl>
          <p class="section-lede verify-cli">Re-derive every entry, signature and trust rule yourself:</p>
          ${cmdline(cmd, c.baseUrl ? "" : ' data-base-cmd="remote"')}
          <div class="verify-links"><a class="link" href="../../../api/ledger/${esc(f.findingId)}.json">Case events + proof (JSON)</a><a class="link" href="../../../ledger/checkpoint">Signed checkpoint</a><a class="link" href="../../../ledger/pub">Public key</a><a class="link" href="../../../ledger/entries.jsonl">Full log (JSONL)</a></div>
        </div>`;
}

// ---- trust page -----------------------------------------------------------------------------------------------------

export function trustPage(c: Ctx, md: string): { head: string; body: string } {
  const title = /^#\s+(.+)$/m.exec(md)?.[1] ?? "Trust policy";
  const firstPara = md.split("\n\n").find((p) => p.trim() && !p.trim().startsWith("#")) ?? SITE.description;
  return {
    head: head(c, { title: `${title} · ${SITE.name}`, description: firstPara.replace(/[#*`>_[\]]/g, "") }),
    body: `${siteTop(c, "trust")}
    <main class="wrap wrap--narrow prose">${renderMarkdown(md)}</main>
    ${siteFoot(c)}`,
  };
}

// ---- sitemap / robots ---------------------------------------------------------------------------------------------------

export function sitemap(baseUrl: string, pages: { path: string; lastmod?: string }[]): string {
  const urls = pages
    .map((p) => `  <url><loc>${esc(`${baseUrl}/${p.path}`)}</loc>${p.lastmod ? `<lastmod>${esc(p.lastmod.slice(0, 10))}</lastmod>` : ""}</url>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
}

export function robots(baseUrl: string | null): string {
  return `User-agent: *\nAllow: /\n${baseUrl ? `Sitemap: ${baseUrl}/sitemap.xml\n` : ""}`;
}

// ---- template ---------------------------------------------------------------------------------------------------------

/** Used when the site bundle isn't built (tests, `tsc`-only installs): valid pages, no CSS/JS. */
export const FALLBACK_TEMPLATE = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <!--ssr:head-->
  </head>
  <body class="site" data-page="">
    <!--ssr:body-->
  </body>
</html>
`;

/** Fill the built template for a page at `depth`: head, body, page name, and asset paths rebased. */
export function fillTemplate(tpl: string, depth: number, page: string, parts: { head: string; body: string }): string {
  const prefix = depth === 0 ? "./" : "../".repeat(depth);
  return tpl
    .replace(/(src|href)="\.\/(assets\/[^"]+)"/g, (_m, attr: string, p: string) => `${attr}="${prefix}${p}"`)
    .replace('data-page=""', `data-page="${page}"`)
    .replace("<!--ssr:head-->", () => parts.head)
    .replace("<!--ssr:body-->", () => parts.body);
}
