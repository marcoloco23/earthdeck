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
import { livingValueOf, type SiteStats, type RateCell } from "./export.js";

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

// ---- plain words (landing + top of case pages: for a general reader, no ids or jargon) -----------------

/** One plain status word per status. */
export const PLAIN_STATUS: Record<string, string> = {
  candidate: "Being checked",
  confirmed: "Being reviewed",
  published: "Published",
  notified: "Published",
  replied: "Published",
  no_response: "Published",
  ignored: "Published",
  resolved: "Resolved",
  expired: "Couldn’t confirm",
  false_positive: "Turned out wrong",
  retracted: "Withdrawn",
};
export const plainStatus = (s: string) => `<span class="status-badge status--${safeStatus(s)}"><span class="status-dot"></span>${esc(PLAIN_STATUS[s] ?? words(s))}</span>`;

/** Friendly names for the data sources evidence cites (fallback: the raw source id). */
const SOURCE_NAMES: [RegExp, string][] = [
  [/^gfw/, "Global Forest Watch alerts"],
  [/^sentinel-2/, "Sentinel-2 satellite images"],
  [/^sentinel-5p/, "Sentinel-5P satellite (methane)"],
  [/^sentinel-1/, "Sentinel-1 radar images"],
  [/^firms/, "NASA fire detections"],
  [/^climate-trace/, "Climate TRACE facility records"],
  [/nightfire|^eog/, "Gas-flare detections (VIIRS Nightfire)"],
  [/^gbif/, "GBIF species records"],
];
export const sourceName = (src: string) => SOURCE_NAMES.find(([re]) => re.test(src))?.[1] ?? src;

/** 2 significant figures with thousands separators: 324.9 → "320", 12345 → "12,000". */
const sig2 = (v: number) => Number(v.toPrecision(2)).toLocaleString("en-US");

/** Largest area (hectares) any evidence reports, or null. */
export function areaHaOf(f: Finding): number | null {
  let best: number | null = null;
  for (const e of [...f.evidence, ...(f.confirmed ? [f.confirmed.signal] : [])]) {
    for (const k of ["ha", "area_ha", "areaHa"]) {
      const v = e.values?.[k];
      if (typeof v === "number" && Number.isFinite(v) && v > 0 && (best === null || v > best)) best = v;
    }
  }
  return best;
}

/** "232 hectares — about 320 football fields" (a 105 × 68 m pitch ≈ 0.714 ha). */
export function plainArea(ha: number): string {
  const fields = ha / 0.714;
  const v = ha >= 10 ? Math.round(ha).toLocaleString("en-US") : String(Number(ha.toFixed(1)));
  return `${v} hectare${v === "1" ? "" : "s"}${fields >= 1.5 ? ` — about ${sig2(fields)} football fields` : ""}`;
}

/** The analyst writes `headline ⏎⏎ narrative ⏎⏎ Key numbers: … Confidence: … Caveats: …`; split it. */
export function parseNarration(text: string): { headline: string | null; body: string; caveats: string[] } {
  const lines = text.split("\n");
  const isLabel = (l: string) => /^(Key numbers|Confidence|Caveats):/.test(l.trim());
  if (!lines.some(isLabel)) return { headline: null, body: text, caveats: [] };
  const first = lines.findIndex((l) => l.trim());
  const headline = lines[first]!.replace(/^#+\s*/, "").trim() || null;
  const rest = lines.slice(first + 1);
  const stop = rest.findIndex(isLabel);
  const body = rest.slice(0, stop < 0 ? undefined : stop).join("\n").trim();
  const ci = lines.findIndex((l) => l.trim() === "Caveats:");
  const caveats = ci < 0 ? [] : lines.slice(ci + 1).map((l) => /^\s*-\s+(.*)$/.exec(l)?.[1]).filter((x): x is string => !!x);
  return { headline, body, caveats };
}

/** The plain headline: the narration's when present, else the finding title. */
export const plainTitle = (f: Finding) => (f.narration ? parseNarration(f.narration.text).headline : null) ?? f.title;

/** "Sep 2, 2026" — a date a person reads. */
const plainDate = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? dateOf(iso) : d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
};

/** Ledger actor ids can carry people's handles; pages never show them. */
function plainActor(a: string): string {
  if (a.startsWith("system:")) return `automatic rule ${a.slice(7).replace("@", " v")}`;
  if (a.startsWith("model:")) return "AI model";
  if (a.startsWith("reviewer:")) return "a reviewer";
  return "the watch";
}

const REPLY_TEXT =
  "If a case names or affects you, you can reply. A reply channel that keeps both sides on record is being set up; until then, every case page carries its ledger id so a reply can be attached to it.";

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

/** The shared header. On the landing, `line` (the one sentence) sits beside the wordmark as the page's h1. */
export function siteTop(c: Ctx, current: "landing" | "cases" | "trust" | "developers" | null, line?: string): string {
  const cur = (k: string) => (current === k ? ` aria-current="page"` : "");
  const home = rel(c, "");
  return `<header class="site-top${line ? " site-top--landing" : ""}">
      <div class="wrap${line ? " wrap--wide" : ""} site-top-in">
        <a class="brand" href="${home}">${BRAND_MARK}<span class="brand-name">${esc(SITE.name)}</span>${line ? "" : `<span class="brand-sub">${esc(SITE.byline)}</span>`}</a>
        ${line ? `<h1 class="top-line">${esc(line)}</h1>` : ""}
        <nav class="site-nav" aria-label="Site">
          <a href="${rel(c, "watch/")}"${cur("cases")}>Cases</a>
          <a href="${c.depth === 0 ? "" : home}#challenge">Reply</a>
          <a href="${rel(c, "developers/")}"${cur("developers")}>Developers</a>
        </nav>
      </div>
    </header>`;
}

export function siteFoot(c: Ctx): string {
  const gen = c.stats.generatedAt.replace("T", " ").slice(0, 16);
  return `<footer class="site-foot">
      <div class="wrap${c.depth === 0 && c.path === "" ? " wrap--wide" : ""}">
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
        <p class="foot-note">${esc(SITE.fullName)} — cases are found by automatic rules on open satellite data and written up by AI; nothing is published without a second, independent signal and a review. ${esc(SITE.credit)} · ${c.stats.site.trust ? `<a class="link" href="${rel(c, "trust.html")}">How we decide</a> · ` : ""}<a class="link" href="${rel(c, "developers/")}">For developers</a> · updated ${esc(gen)} UTC</p>
      </div>
    </footer>`;
}

// ---- small pieces (mirror web/src/ui.ts + watch.ts) ------------------------------------------------------

const time = (iso: string, text = dateOf(iso), cls = "") => `<time${cls ? ` class="${cls}"` : ""} datetime="${esc(iso)}">${esc(text)}</time>`;
const copyBtn = (value: string) => `<button class="btn btn--ghost btn--xs" type="button" data-copy="${esc(value)}" hidden>Copy</button>`;
const hash = (h: string) => `<span class="hashrow"><code class="hash" title="${esc(h)}">${esc(h.slice(0, 12))}…${esc(h.slice(-6))}</code>${copyBtn(h)}</span>`;
const cmdline = (cmd: string, attrs = "") => `<div class="cmdline"><code class="cmd"${attrs}>${esc(cmd)}</code>${copyBtn(cmd)}</div>`;
const section = (title: string, body: string, count?: number | string, id?: string) =>
  `<section class="case-section"${id ? ` id="${id}"` : ""}><h2 class="section-h">${esc(title)}${count !== undefined ? `<span class="section-n">${esc(count)}</span>` : ""}</h2>${body}</section>`;

/** A case in plain words: status word, date, headline, then place · size · value of nature at stake. */
function caseRow(f: Finding, href: string, cls = ""): string {
  const ha = areaHaOf(f);
  const lv = livingValueOf(f);
  const meta = [f.aoi?.name, ha !== null ? plainArea(ha) : "", lv !== null ? `nature’s work worth ≈ ${fmtUsd(lv)} a year` : ""].filter(Boolean).join(" · ");
  const title = plainTitle(f);
  return `<a class="case-row${cls ? ` ${cls}` : ""}" href="${esc(href)}" data-case="${esc(f.findingId)}"><span class="case-top">${plainStatus(f.status)}${time(f.updatedAt, plainDate(f.updatedAt), "case-when")}</span><span class="case-title" title="${esc(title)}">${esc(title)}</span>${meta ? `<span class="case-meta">${esc(meta)}</span>` : ""}</a>`;
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

export function landingPage(c: Ctx, findings: Finding[]): { head: string; body: string } {
  const s = c.stats;
  const site = c.baseUrl ?? SITE.organization.url;
  const orgId = `${site}#org`;
  const ld = [
    { "@context": "https://schema.org", "@type": "Organization", "@id": orgId, name: SITE.organization.name, url: c.baseUrl ?? SITE.organization.url },
    { "@context": "https://schema.org", "@type": "WebSite", name: SITE.fullName, alternateName: SITE.name, url: abs(c, "") ?? undefined, description: SITE.description, publisher: { "@id": orgId } },
    datasetLd(c, orgId),
  ];
  const isPub = (f: Finding) => PUBLIC_STATUSES.includes(f.status);
  // What's live: published cases plus the open ones still being checked or reviewed.
  const live = findings.filter((f) => isPub(f) || f.status === "candidate" || f.status === "confirmed");
  const latest = [...live].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 6);
  const nPub = live.filter(isPub).length;

  // Markers: plain links positioned over an equirectangular image, so lon/lat → % is linear.
  const pct = (v: number) => Math.min(100, Math.max(0, v)).toFixed(2);
  const pins = [...live]
    .sort((a, b) => Number(isPub(a)) - Number(isPub(b))) // published drawn last, on top
    .map((f) => {
      const [w, so, e, n] = f.bbox;
      const x = (((w + e) / 2 + 180) / 360) * 100;
      const y = ((90 - (so + n) / 2) / 180) * 100;
      const cls = ["pin", isPub(f) ? "pin--pub" : "pin--open", y < 18 ? "pin--below" : "", x < 14 ? "pin--l" : x > 86 ? "pin--r" : ""].filter(Boolean).join(" ");
      const title = plainTitle(f);
      return `<a class="${cls}" href="watch/case/${esc(f.findingId)}/" style="left:${pct(x)}%;top:${pct(y)}%" data-case="${esc(f.findingId)}" aria-label="${esc(`${PLAIN_STATUS[f.status] ?? words(f.status)}: ${title}`)}"><span class="pin-dot"></span><span class="pin-tip" aria-hidden="true">${esc(clip(title, 64))}</span></a>`;
    })
    .join("");
  const rows = latest.length
    ? latest.map((f) => `<li>${caseRow(f, `watch/case/${f.findingId}/`, `live-row${isPub(f) ? "" : " is-unpublished"}`)}</li>`).join("")
    : `<li class="live-empty">No cases yet — the first check hasn’t found anything.</li>`;

  const fp = s.falsePositiveRate.overall;
  const num = (v: string, k: string, title = "") => `<div class="num"${title ? ` title="${esc(title)}"` : ""}><dt>${esc(k)}</dt><dd>${v}</dd></div>`;
  const wrongTitle = fp.decided ? `${fp.falsePositives} of the ${fp.decided} cases we could settle were false alarms — caught by our own checks before anything was published. We keep them on the site.` : "No case has been settled yet.";
  const flow: [string, string][] = [
    ["Spot", "satellites flag a change"],
    ["Double-check", "a second, separate source must agree"],
    ["Review", "a reviewer reads the evidence"],
    ["Warn first", "the people named hear first"],
    ["Keep the record", "nothing is edited or deleted"],
  ];

  const body = `${siteTop(c, "landing", SITE.oneLine)}
    <main class="land">
      <section class="live wrap wrap--wide" aria-label="What the watch has found">
        <div class="live-map">
          <figure class="world">
            <div class="world-scroll">
              <div class="world-in">
                <img class="world-img" src="https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi?SERVICE=WMS&amp;REQUEST=GetMap&amp;VERSION=1.1.1&amp;LAYERS=VIIRS_Black_Marble&amp;STYLES=&amp;SRS=EPSG:4326&amp;BBOX=-180,-90,180,90&amp;WIDTH=1440&amp;HEIGHT=720&amp;FORMAT=image/jpeg" width="1440" height="720" alt="The Earth at night with the places of ${nPub} published case${nPub === 1 ? "" : "s"} and ${live.length - nPub} still being checked" decoding="async" fetchpriority="high" />
                <div class="pins">${pins}</div>
              </div>
            </div>
            <figcaption class="world-cap"><span class="legend"><span class="lg lg--pub"></span>Published<span class="lg lg--open"></span>Being checked</span><span>Earth at night · NASA</span></figcaption>
          </figure>
          <dl class="nums" aria-label="So far">
            ${num(String(s.cases.public), "Cases published")}
            ${num(fp.decided ? `${fp.falsePositives}<span class="num-of"> of ${fp.decided}</span>` : "0", "False alarms we caught", wrongTitle)}
            ${num(s.lastSweep ? time(s.lastSweep.at, plainDate(s.lastSweep.at), "ago") : "—", "Last check", s.lastSweep ? `${s.lastSweep.at.replace("T", " ").slice(0, 16)} UTC` : "")}
          </dl>
        </div>
        <div class="live-list">
          <div class="live-head"><h2 class="live-h">Latest cases</h2><a class="link" href="watch/">All cases →</a></div>
          <ol class="live-rows">${rows}</ol>
        </div>
      </section>
      <section class="wrap wrap--wide strip" aria-labelledby="how-h">
        <h2 class="strip-h" id="how-h">How a case is made</h2>
        <ol class="flow">${flow.map(([k, v], i) => `<li><span class="flow-n">${i + 1}</span><b>${esc(k)}</b><span>${esc(v)}</span></li>`).join("")}</ol>
      </section>
      <section class="wrap wrap--wide strip" id="pulse-band" aria-labelledby="pulse-h" hidden>
        <div class="strip-side"><h2 class="strip-h" id="pulse-h">World pulse</h2><button class="btn btn--ghost btn--xs pulse-toggle" type="button" aria-expanded="false" aria-controls="pulse">Show all</button></div>
        <div class="strip-body"><p class="strip-lede">How the planet is doing — good news and bad.</p><div id="pulse" class="is-collapsed"></div><p class="global-value">Nature does about $${GLOBAL_NATURE_VALUE.usdPerYear.low / 1e12}–${GLOBAL_NATURE_VALUE.usdPerYear.high / 1e12} trillion worth of work for us every year. <cite>${esc(GLOBAL_NATURE_VALUE.source)}</cite></p></div>
      </section>
      <section class="wrap wrap--wide strip" id="challenge" aria-labelledby="challenge-h">
        <h2 class="strip-h" id="challenge-h">Named in a case? Think it’s wrong?</h2>
        <div class="strip-body"><p class="strip-lede">${esc(REPLY_TEXT)}</p><p class="strip-lede">If a case turns out wrong, it is marked “Turned out wrong” — in public — and it stays on this site.</p></div>
      </section>
    </main>
    ${siteFoot(c)}`;
  return {
    head: head(c, { title: `${SITE.fullName} — ${SITE.tagline.join(" ")}`, description: SITE.description, jsonld: ld }),
    body,
  };
}

/** For developers: every command, feed and machine-readable link the landing leaves out. */
export function developersPage(c: Ctx): { head: string; body: string } {
  const s = c.stats;
  const base = c.baseUrl ?? "https://<this-site>";
  const r = (p: string) => rel(c, p);
  const link = (p: string, label: string, what: string) => `<li><a class="link" href="${r(p)}">${esc(label)}</a><span>${esc(what)}</span></li>`;
  const body = `${siteTop(c, "developers")}
    <main class="wrap wrap--narrow site-watch">
      <header class="page-head">
        <h1 class="page-h">For developers</h1>
        <p class="band-lede">Verify it yourself, pull the data feeds, read the schema. No account and no trust in this website needed.</p>
      </header>
      ${section(
        "Verify it yourself",
        `<p class="section-lede">The ledger is a transparency log: every event is signed (DSSE, Ed25519), hashed into an RFC 6962 Merkle tree and sealed by a signed checkpoint. Three commands:</p>
        <ol class="steps-v">
          <li><h3>Mirror the log</h3><p>The raw entries, the signed checkpoint and the public key — static files on this site.</p>${cmdline(`mkdir ew && cd ew && curl -sf --remote-name-all ${base}/ledger/entries.jsonl ${base}/ledger/checkpoint && curl -sf ${base}/ledger/pub -o ledger.pub`, c.baseUrl ? "" : ' data-base-cmd=""')}</li>
          <li><h3>Re-derive everything</h3><p>Checks every signature, the canonical form of every entry, every trust rule (no publication without confirmation and review), and that the root matches the checkpoint.</p>${cmdline("EARTHDECK_LEDGER_DIR=. npx -y earthdeck ledger verify")}</li>
          <li><h3>Prove history wasn’t rewritten</h3><p>Keep today’s checkpoint. Next time, check that the new log extends it — a consistency proof, not a promise.</p>${cmdline("EARTHDECK_LEDGER_DIR=. npx -y earthdeck ledger verify --trusted ../saved-checkpoint")}</li>
        </ol>
        <dl class="kv">${s.ledger.root ? `<dt>Signed root</dt><dd>${hash(s.ledger.root)}</dd>` : ""}<dt>Entries</dt><dd>${esc(s.ledger.size)}</dd></dl>`,
        undefined,
        "verify",
      )}
      ${section(
        "Data feeds & API",
        `<ul class="dev-links">
          ${link("feed.json", "feed.json", "published cases (JSON Feed)")}
          ${link("feed.geojson", "feed.geojson", "published cases as GeoJSON")}
          ${link("api/ledger.json", "api/ledger.json", "every finding, public or not")}
          ${link("api/stats.json", "api/stats.json", "counts and false-positive rate per rule")}
          ${link("api/pulse.json", "api/pulse.json", "world pulse snapshot (when available)")}
          ${link("ledger/checkpoint", "ledger/checkpoint", "signed checkpoint")}
          ${link("ledger/pub", "ledger/pub", "ledger public key")}
          ${link("ledger/entries.jsonl", "ledger/entries.jsonl", "the full log")}
          ${link("schema/finding-event.v1.json", "schema/finding-event.v1.json", "event schema (JSON Schema)")}
          ${s.site.trust ? link("trust.html", "Trust policy", "what gets published, and why") : ""}
        </ul>`,
      )}
      ${section("Source code", `<p class="section-lede">Source code: coming.</p>`)}
      <p class="band-note">Every case page also carries its own inclusion proof, checked in your browser, under “Technical details”.</p>
    </main>
    ${siteFoot(c)}`;
  return { head: head(c, { title: `For developers · ${SITE.name}`, description: "Verify every Earth Watch case yourself: the signed ledger, three commands, data feeds, API and schema." }), body };
}

function datasetLd(c: Ctx, orgId: string): Record<string, unknown> {
  return {
    "@context": "https://schema.org",
    "@type": "Dataset",
    "@id": `${abs(c, "watch/") ?? "watch/"}#dataset`,
    name: `${SITE.fullName} findings ledger`,
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

// ---- cases index ----------------------------------------------------------------------------------------------

export function watchIndexPage(c: Ctx, findings: Finding[]): { head: string; body: string } {
  const s = c.stats;
  const isPublic = (f: Finding) => PUBLIC_STATUSES.includes(f.status);
  const pub = findings.filter(isPublic);
  const rows = findings.map((f) => `<li class="case-item${isPublic(f) ? "" : " is-unpublished"}">${caseRow(f, `case/${f.findingId}/`)}</li>`).join("");
  const orgId = `${c.baseUrl ?? SITE.organization.url}#org`;
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
//
// Top of the page is for anyone: headline, the plain write-up, a map, what we saw / what it might
// not be / what would change our mind, why it was (not) published, and how to reply. Everything
// technical — rule, ids, evidence methods, history, the proof — sits in a closed "Technical
// details" block at the bottom. Actor ids from the ledger (which can carry people's handles) are
// never rendered; they stay in the ledger files for verification only.

export interface CaseData {
  finding: Finding;
  events: FindingEvent[];
  inclusion: null | { index: number; leafHash: string; proof: string[]; size: number; root: string };
}

const MAIN_PATH = ["candidate", "confirmed", "published", "notified", "resolved"];
const NOT_PUBLIC: Record<string, string> = {
  candidate: "Not published yet: only one source has seen this so far. We wait for a second, separate one before anything goes up.",
  confirmed: "Not published yet: a second, separate source agreed, and it is now waiting for a reviewer.",
  expired: "Never published: no second source confirmed it in time, so it was dropped — but it stays on this site.",
  false_positive: "Never published: on a closer look it turned out wrong. It stays on this site so mistakes are counted, not hidden.",
};
const CHANGE_MIND =
  "Newer satellite images that show no change, a correction from the data source, or a reply with evidence from the ground. If that happens, the case is marked “Turned out wrong” — in public — and it stays on this site.";
const NOT_SURE_DEFAULT =
  "Satellite signals can be wrong: clouds, smoke, the seasons and sensor glitches can all look like change. That is why every case needs a second, separate source before it is published.";

export function casePage(c: Ctx, d: CaseData): { head: string; body: string } {
  const f = d.finding;
  const s = c.stats;
  const isPublic = PUBLIC_STATUSES.includes(f.status);
  const pubEv = d.events.find((e) => e.kind === "status_changed" && e.to === "published");
  const published = pubEv?.at;
  const where = f.aoi?.name ?? f.aoi?.id;
  const [w, so, e, n] = f.bbox;
  const nar = f.narration ? parseNarration(f.narration.text) : null;
  const title = plainTitle(f);

  // What we saw: size and value in words, then each piece of evidence by its source's plain name.
  const ha = areaHaOf(f);
  const lv = livingValueOf(f);
  const allEv = [...f.evidence, ...(f.confirmed ? [f.confirmed.signal] : [])];
  const seen = [
    ...(ha !== null ? [`<li><b>Area:</b> ${esc(plainArea(ha))}</li>`] : []),
    ...(lv !== null ? [`<li><b>Nature’s work at stake:</b> about ${esc(fmtUsd(lv))} a year (a rough estimate of what this land does for people — clean water, carbon, food).</li>`] : []),
    ...allEv.map((x) => {
      const href = safeUrl(x.href);
      return `<li><b>${esc(sourceName(x.source))}</b>${x.summary ? ` — ${esc(x.summary)}` : ""} <span class="seen-when">(${esc(plainDate(x.datetime))})</span>${href ? ` <a class="link" href="${esc(href)}" rel="noopener nofollow">See the source ↗</a>` : ""}</li>`;
    }),
  ];
  const doubts = [...(nar?.caveats ?? []), ...(f.blindSpots ?? [])];
  const replies = rightOfReplyHtml(f);

  // Technical details (collapsed).
  const facts: [string, string][] = [
    ["Rule", `${f.rule.name} v${f.rule.version}`],
    ["Tier", `T${f.tier}`],
    ...(f.aoi?.tags?.length ? ([["Tags", f.aoi.tags.join(", ")]] as [string, string][]) : []),
    ["Confirmed", f.confirmed ? `Yes — independent ${f.confirmed.independence} signal, ${dateOf(f.confirmed.at)}` : "Not yet — single signal"],
    ...(f.attribution ? ([["Subject", `${f.attribution.subject.kind}: ${f.attribution.subject.name}`]] as [string, string][]) : []),
    ...(f.attribution?.party ? ([["Party", `${f.attribution.party.name} (via ${f.attribution.party.registry.name}; ${f.attribution.reviewers.length} reviewers)`]] as [string, string][]) : []),
    ["Rule FP rate", formatRate(s.falsePositiveRate.byRule[f.rule.name])],
    ["Location", `${fmtLat((so + n) / 2)} ${fmtLon((w + e) / 2)}`],
    ["Observed", dateOf(f.observedAt)],
    ["Opened", `${dateOf(f.createdAt)} by ${plainActor(f.createdBy)}`],
  ];
  const ev = allEv.map((x, i) => evidenceHtml(x, i >= f.evidence.length));
  const ctxHtml = contextHtml(f);
  const hist = [...f.history].reverse().map((h) => tl(h.at, `${words(h.kind)} → ${words(h.status)}`, plainActor(h.actor))).join("");

  const body = `${siteTop(c, "cases")}
    <main class="wrap wrap--narrow site-watch">
      <nav class="crumbs" aria-label="Breadcrumb"><a class="btn btn--ghost btn--back" href="../../">All cases</a></nav>
      <article class="case" itemscope itemtype="https://schema.org/Report">
        <header class="case-head">
          <div class="case-top">${plainStatus(f.status)}</div>
          <h1 class="case-h" itemprop="headline">${esc(title)}</h1>
          <p class="case-sub">${[where ? esc(where) : "", `seen ${time(f.observedAt, plainDate(f.observedAt))}`, published ? `published ${time(published, plainDate(published))}` : ""].filter(Boolean).join(" · ")}</p>
        </header>
        ${nar ? `<div class="case-summary narrative" itemprop="articleBody">${renderMarkdown(nar.body, 1)}<p class="disclosure">Written by AI, then checked by a separate reviewer before publication. Every claim points at the evidence below.</p></div>` : `<p class="case-summary" itemprop="abstract">${esc(f.summary)}</p>`}
        ${isPublic ? "" : `<p class="banner banner--muted">${esc(NOT_PUBLIC[f.status] ?? `Not published: ${PLAIN_STATUS[f.status] ?? words(f.status)}.`)}</p>`}
        ${f.retracted ? `<p class="banner banner--danger">Withdrawn ${time(f.retracted.at, plainDate(f.retracted.at))} — ${esc(f.retracted.reason)}</p>` : ""}
        ${heroHtml(f)}
        ${section("What we saw", `<ul class="plain-list">${seen.join("")}</ul>`)}
        ${section("What it might not be", doubts.length ? `<ul class="plain-list">${doubts.map((b) => `<li>${esc(b)}</li>`).join("")}</ul>` : `<p class="section-lede">${esc(NOT_SURE_DEFAULT)}</p>`)}
        ${section("What would change our mind", `<p class="section-lede">${esc(CHANGE_MIND)}</p>`)}
        ${section(isPublic ? "Why this was published" : "Why this is not published", `<p class="section-lede">${esc(whySentence(f, pubEv))}</p>`)}
        ${section("Right of reply", `${replies}<p class="section-lede">${esc(REPLY_TEXT)}</p><p class="case-id">Ledger id <code>${esc(f.findingId)}</code>${copyBtn(f.findingId)}</p>`, undefined, "challenge")}
        <details class="tech" id="technical">
          <summary class="tech-sum">Technical details <span>rule, evidence ids, history, proof</span></summary>
          <dl class="kv kv--case">${facts.map(([k, v]) => `<dt>${esc(k)}</dt><dd${k === "Rule FP rate" ? ` title="${esc(s.falsePositiveRate.definition)}"` : ""}>${esc(v)}</dd>`).join("")}</dl>
          ${stepperHtml(f)}
          ${section("Evidence", ev.join(""), ev.length)}
          ${ctxHtml ? section("Context", ctxHtml) : ""}
          ${section("Publication gates", whyHtml(f, pubEv))}
          ${section("History", `<ol class="tl">${hist}</ol>`, f.history.length)}
          ${section("Verify", verifyHtml(c, d), undefined, "verify")}
        </details>
      </article>
    </main>
    ${siteFoot(c)}`;

  const orgId = `${c.baseUrl ?? SITE.organization.url}#org`;
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
    isBasedOn: allEv.map((x) => safeUrl(x.href)).filter(Boolean),
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

/** "Why this was published", in one plain sentence. */
function whySentence(f: Finding, pub: FindingEvent | undefined): string {
  if (f.status === "retracted") return "It was published, then withdrawn — the reason is shown above.";
  if (!PUBLIC_STATUSES.includes(f.status)) return NOT_PUBLIC[f.status] ?? `Not published: ${PLAIN_STATUS[f.status] ?? words(f.status)}.`;
  const first = [...new Set(f.evidence.map((x) => sourceName(x.source)))].join(" and ");
  const second = f.confirmed ? sourceName(f.confirmed.signal.source) : null;
  const gates = pub && pub.kind === "status_changed" ? (pub as unknown as { gates?: { reviewedBy?: unknown } }).gates : undefined;
  const reviewers = Math.max(new Set(f.reviews.filter((r) => r.decision === "approve").map((r) => r.actor)).size, Array.isArray(gates?.reviewedBy) ? gates.reviewedBy.length : 0);
  return `Two separate sources agreed — ${first}${second ? `, then ${second}` : ""} — and ${reviewers <= 1 ? "a reviewer" : `${reviewers} reviewers`} checked the evidence before it went up.`;
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
  const items = f.notifications.map((x) => tl(x.at, `Told ${x.to.name} first`, `Public from ${plainDate(x.publicAt)}`));
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
      needed === 0 ? "Human approval — not required at tier 0" : `Human approval — ${approvers.length} of ${needed} needed at tier ${f.tier}`,
    ),
  ];
  if (f.tier >= 3) {
    const notice = f.notifications.find((x) => x.to.kind !== "public");
    items.push(check(!!notice, notice ? `Private notice to ${notice.to.name} — public from ${dateOf(notice.publicAt)}` : "Private notice + right-of-reply window — not yet"));
  }
  if (f.narration) items.push(check(true, `Narration — AI-drafted by ${f.narration.model.id}${f.narration.reviewedBy ? ", reviewed by a reviewer" : ""}`));
  let detail = "";
  if (pub && pub.kind === "status_changed") {
    const rows: [string, string][] = [["Published", `${dateOf(pub.at)} by ${plainActor(pub.actor)}`]];
    // `gates` is written by newer publishers; render whatever it holds, generically — but
    // identities (narratedBy, reviewedBy, …) only as roles: ledger actor ids stay off the page.
    const gates = (pub as unknown as { gates?: unknown }).gates;
    const g = gates && typeof gates === "object" && !Array.isArray(gates) ? (gates as Record<string, unknown>) : {};
    for (const [k, v] of Object.entries(g)) rows.push([humanKey(k), /By$/.test(k) ? [v].flat().map((x) => plainActor(String(x))).join(", ") : show(v)]);
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
