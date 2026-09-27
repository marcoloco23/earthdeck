// `earthdeck watch export --out <dir>` — the public site as static files (S3 + CloudFront,
// GitHub Pages, `npx serve` — no server), regenerated after every sweep.
//
//   index.html                     landing (server-rendered; branding from src/site.config.ts)
//   watch/index.html               cases index — real links, every finding
//   watch/case/<id>/index.html     one server-rendered page per finding (non-public: noindex)
//   api/ledger.json, api/ledger/<id>.json, feed.json, feed.geojson   — LedgerView's own bodies
//   ledger/{checkpoint,pub,entries.jsonl,tile/**}                     — the verification surface
//   api/stats.json                 counts + published false-positive rate per rule
//   api/map.json                   the interactive map's cases + watched places (src/watch/map-data.ts)
//   api/metrics.json               the landing's Metrics mode: totals, timeline, stakes (src/watch/metrics.ts)
//   api/pulse.json                 world_pulse snapshot (fresh, else cached, else omitted)
//   api/storms.json                active tropical cyclones as GeoJSON (live exports only, best-effort)
//   api/marine/{fishing,ships}.json  GFW fishing-effort grid / AIS ship density — only when the
//                                  runner has GFW_FISHING_TOKEN / AISSTREAM_KEY (src/watch/marine-export.ts)
//   developers/index.html          verify-it-yourself commands, feeds, API, schema (kept off the landing)
//   schema/finding-event.v1.json, trust.html (+ TRUST.md), sitemap.xml, robots.txt
//   assets/**, og.png, favicon.{ico,svg}, apple-touch-icon.png, icon-{192,512}.png
//                                  the built site bundle (dist/site, `pnpm build`; icons: scripts/site-icons.mjs)
//   site.webmanifest               name + icons for home screens, from SITE
//
// Every link is relative; absolute URLs appear only where the web demands them (canonical,
// og:*, JSON-LD, sitemap), all from --base-url / SITE.baseUrl. The signing key (`ledger.key`)
// and the sweep journal are never copied.

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { LedgerView } from "../dashboard/ledger-view.js";
import { PUBLIC_STATUSES, STATUSES, type Finding, type Status } from "../ledger/schema.js";
import { ledgerDir as defaultLedgerDir } from "../config.js";
import { SITE } from "../site.config.js";
import { readPublicReplies } from "../replies/review.js";
import { readHeartbeat, type Heartbeat } from "./journal.js";
import { mapData } from "./map-data.js";
import { computeMetrics } from "./metrics.js";
import { marineSnapshots } from "./marine-export.js";
import { newsForCases } from "./news.js";
import { CallBudget, gdeltCapFromEnv } from "./quota.js";
import { casePage, developersPage, FALLBACK_TEMPLATE, NEWS_NOTE, fillTemplate, landingPage, robots, sitemap, trustPage, watchIndexPage, webManifest, type CaseData, type Ctx } from "./site-render.js";

const PKG_ROOT = fileURLToPath(new URL("../../", import.meta.url)); // dist/watch → root, src/watch → root
const MARKER = ".earthdeck-site";

/** Statuses that mean a finding passed independent confirmation and was not ruled out. */
const DECIDED_TRUE: readonly Status[] = ["confirmed", "published", "notified", "replied", "no_response", "resolved", "ignored", "retracted"];
/** "Open" cases for the living-value tile: confirmed or public, and not resolved/retracted. */
const LIVING_OPEN: readonly Status[] = ["confirmed", "published", "notified", "replied", "no_response", "ignored"];

export const FP_DEFINITION =
  "False-positive rate = false_positive ÷ (false_positive + findings that passed independent confirmation: " +
  "confirmed, published, notified, replied, no_response, resolved, ignored, retracted). Open candidates " +
  "(still waiting for a second signal) and expired candidates are undecided and excluded. Nothing is ever " +
  "deleted from the ledger, so this rate can only be improved by better rules, not by hiding rows.";

export const LIVING_VALUE_DEFINITION =
  "Sum over open cases (confirmed or public, not resolved or retracted) of the largest living_value_usd_yr " +
  "any of the case's evidence carries — a benefit-transfer estimate of the ecosystem services the affected " +
  "area provides per year. Order of magnitude only.";

export interface RateCell {
  falsePositives: number;
  decided: number;
  /** null when nothing has been decided yet — "no data" is not "0 %". */
  rate: number | null;
}

export interface SiteStats {
  generatedAt: string;
  /** `contact` is always null: the public site is anonymous (no address, no repo link). */
  site: { name: string; baseUrl: string | null; contact: null; trust: boolean };
  ledger: { size: number; root: string | null; checkpoint: string | null };
  lastSweep: Heartbeat | null;
  cases: { total: number; public: number; confirmed: number; candidates: number; falsePositives: number };
  byStatus: Record<Status, number>;
  byRule: Record<string, { total: number; public: number; versions: string[] }>;
  byTier: Record<string, number>;
  falsePositiveRate: { definition: string; overall: RateCell; byRule: Record<string, RateCell> };
  /** Present only when some open case carries `living_value_usd_yr` evidence values. */
  livingValue: null | { usdPerYear: number; cases: number; definition: string };
}

const cell = (fp: number, decided: number): RateCell => ({ falsePositives: fp, decided, rate: decided > 0 ? fp / decided : null });

/** Largest `living_value_usd_yr` across a finding's evidence (incl. the confirming signal), or null. */
export function livingValueOf(f: Finding): number | null {
  let best: number | null = null;
  for (const e of [...f.evidence, ...(f.confirmed ? [f.confirmed.signal] : [])]) {
    const v = e.values?.living_value_usd_yr;
    if (typeof v === "number" && Number.isFinite(v) && v >= 0 && (best === null || v > best)) best = v;
  }
  return best;
}

/** Pure: the counters and rates the landing page and every case page show. */
export function computeStats(
  findings: readonly Finding[],
  ledger: { size: number; root: string | null; checkpoint: string | null },
  lastSweep: Heartbeat | null,
  site: { baseUrl?: string | null; trust?: boolean } = {},
  now = new Date(),
): SiteStats {
  const byStatus = Object.fromEntries(STATUSES.map((s) => [s, 0])) as Record<Status, number>;
  const byRule: SiteStats["byRule"] = {};
  const byTier: Record<string, number> = {};
  const fp: Record<string, { fp: number; decided: number }> = {};
  let fpAll = 0;
  let decidedAll = 0;
  let living = 0;
  let livingCases = 0;
  for (const f of findings) {
    byStatus[f.status] += 1;
    const r = (byRule[f.rule.name] ??= { total: 0, public: 0, versions: [] });
    r.total += 1;
    if (PUBLIC_STATUSES.includes(f.status)) r.public += 1;
    if (!r.versions.includes(f.rule.version)) r.versions.push(f.rule.version);
    byTier[String(f.tier)] = (byTier[String(f.tier)] ?? 0) + 1;
    const c = (fp[f.rule.name] ??= { fp: 0, decided: 0 });
    if (f.status === "false_positive") {
      c.fp += 1;
      c.decided += 1;
      fpAll += 1;
      decidedAll += 1;
    } else if (DECIDED_TRUE.includes(f.status)) {
      c.decided += 1;
      decidedAll += 1;
    }
    const lv = LIVING_OPEN.includes(f.status) ? livingValueOf(f) : null;
    if (lv !== null) {
      living += lv;
      livingCases += 1;
    }
  }
  for (const r of Object.values(byRule)) r.versions.sort();
  return {
    generatedAt: now.toISOString(),
    site: { name: SITE.name, baseUrl: site.baseUrl ?? null, contact: null, trust: site.trust ?? false },
    ledger,
    lastSweep,
    cases: {
      total: findings.length,
      public: findings.filter((f) => PUBLIC_STATUSES.includes(f.status)).length,
      confirmed: findings.filter((f) => f.confirmed !== null).length,
      candidates: byStatus.candidate,
      falsePositives: byStatus.false_positive,
    },
    byStatus,
    byRule,
    byTier,
    falsePositiveRate: {
      definition: FP_DEFINITION,
      overall: cell(fpAll, decidedAll),
      byRule: Object.fromEntries(Object.entries(fp).map(([k, v]) => [k, cell(v.fp, v.decided)])),
    },
    livingValue: livingCases ? { usdPerYear: living, cases: livingCases, definition: LIVING_VALUE_DEFINITION } : null,
  };
}

export interface ExportOptions {
  out: string;
  ledgerDir?: string;
  /** Public origin for canonical/OG/JSON-LD/sitemap. Default SITE.baseUrl; null = none (no sitemap). */
  baseUrl?: string | null;
  /** Accepted for compatibility and ignored (off by default): the public site is anonymous. Replies go through the reply wall. */
  contact?: string;
  /** The reply wall's intake URL (`POST /reply`, the stack's ReplyUrl output). Default SITE.replyEndpoint; null = no form. */
  replyUrl?: string | null;
  /** Local mirror of the reply wall (`public/<caseId>/<id>.json` are shown). Default <ledger>/../replies. */
  repliesDir?: string;
  /** Built site bundle (index.html template, assets/, og.png). Default dist/site; null = unstyled fallback. */
  siteDir?: string | null;
  /** "auto": fetch a fresh world_pulse, fall back to the cache; "cache": cache only; "off": omit. */
  pulse?: "auto" | "cache" | "off";
  pulseCache?: string;
  pulseTimeoutMs?: number;
  /** Marine layers (needs GFW_FISHING_TOKEN / AISSTREAM_KEY): "auto" refreshes stale caches, "cache" reads them, "off" (default here; the CLI passes "auto") omits. */
  marine?: "auto" | "cache" | "off";
  marineCacheDir?: string;
  trustFile?: string;
  /** "In the news" headlines from GDELT for decided cases: "auto" fetches (paced, capped, cached
   *  12 h), "cache" reads the cache only, "off" (default here; the CLI passes "auto") omits. */
  news?: "auto" | "cache" | "off";
  newsCacheDir?: string;
  /** Overwrite a non-empty directory that was not written by a previous export. */
  force?: boolean;
  log?: (s: string) => void;
  now?: Date;
}

export interface ExportReport {
  out: string;
  findings: number;
  publicFindings: number;
  pulse: "fresh" | "cached" | "none";
  marine: { fishing: boolean; ships: boolean };
  /** Cases that got an "In the news" section. */
  news: number;
  web: boolean;
  trust: boolean;
  sitemap: boolean;
  files: string[];
}

export async function exportSite(opts: ExportOptions): Promise<ExportReport> {
  const out = resolve(opts.out);
  const lDir = opts.ledgerDir ?? defaultLedgerDir();
  const log = opts.log ?? (() => {});
  const now = opts.now ?? new Date();
  const rawBase = opts.baseUrl === undefined ? SITE.baseUrl : opts.baseUrl;
  const baseUrl = rawBase ? rawBase.replace(/\/+$/, "") : null;
  if (baseUrl && !/^https?:\/\/[^\s/"'<>]+(\/[^\s"'<>]*)?$/.test(baseUrl)) throw new Error(`--base-url must be an http(s) URL, got ${rawBase}`);
  const rawReply = opts.replyUrl === undefined ? SITE.replyEndpoint : opts.replyUrl;
  const replyEndpoint = rawReply ? `${rawReply.replace(/\/+$/, "")}/reply` : null;
  if (replyEndpoint && !/^https:\/\/[^\s/"'<>]+(\/[^\s"'<>]*)?$/.test(replyEndpoint)) throw new Error(`--reply-url must be an https URL, got ${rawReply}`);
  const repliesDir = opts.repliesDir ?? join(dirname(resolve(lDir)), "replies");

  prepareOut(out, opts.force === true);
  const write = (rel: string, body: string | Buffer) => {
    const abs = join(out, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body);
  };
  const body = (r: { body: string | Buffer }) => (typeof r.body === "string" ? r.body : r.body.toString("utf8"));

  // ---- ledger API (same bodies the dashboard serves) ----
  const view = new LedgerView(lDir);
  const ledger = view.open();
  write("api/ledger.json", body(await view.handle("/api/ledger")));
  const findings = ledger?.list() ?? [];
  const cases: CaseData[] = [];
  for (const f of findings) {
    if (!/^[A-Za-z0-9-]{1,64}$/.test(f.findingId)) throw new Error(`unsafe finding id ${JSON.stringify(f.findingId)}`);
    const json = body(await view.handle(`/api/ledger/${f.findingId}`));
    write(`api/ledger/${f.findingId}.json`, json);
    cases.push(JSON.parse(json) as CaseData);
  }
  const feed = JSON.parse(body(await view.handle("/feed.json"))) as { findings: { findingId: string; url?: string }[] };
  if (baseUrl) for (const item of feed.findings) item.url = `${baseUrl}/watch/case/${item.findingId}/`;
  write("feed.json", JSON.stringify(feed));
  write("feed.geojson", body(await view.handle("/feed.geojson")));

  // ---- verification surface: plain copies (never ledger.key, never the journal) ----
  const copy = (from: string, to: string) => {
    if (existsSync(join(lDir, from))) cpSync(join(lDir, from), join(out, to), { recursive: true });
  };
  copy("checkpoint", "ledger/checkpoint");
  copy("ledger.pub", "ledger/pub");
  copy("entries.jsonl", "ledger/entries.jsonl");
  copy("tile", "ledger/tile");

  const trustFile = opts.trustFile ?? "TRUST.md";
  const trust = existsSync(trustFile);

  // ---- stats ----
  const stats = computeStats(
    findings,
    { size: ledger?.size ?? 0, root: ledger ? ledger.root().toString("hex") : null, checkpoint: ledger?.checkpointText() ?? null },
    readHeartbeat(join(lDir, "watch")),
    { baseUrl, trust },
    now,
  );
  write("api/stats.json", JSON.stringify(stats));
  write("api/map.json", JSON.stringify(mapData(findings, now)));
  write("api/metrics.json", JSON.stringify(computeMetrics(findings, stats, now)));

  // ---- world pulse ----
  const pulse = await pulseSnapshot(opts.pulse ?? "auto", opts.pulseCache ?? join(dirname(resolve(lDir)), "pulse.json"), opts.pulseTimeoutMs ?? 45_000, log);
  if (pulse.json) write("api/pulse.json", pulse.json);
  // Active tropical cyclones for the map's Live layers — live exports only, best-effort.
  if ((opts.pulse ?? "auto") === "auto") {
    const storms = await stormsSnapshot(now, Math.min(opts.pulseTimeoutMs ?? 45_000, 20_000), log);
    if (storms) write("api/storms.json", storms);
  }

  // ---- marine layers (server-side keys; each file only if the runner could produce it) ----
  const marine = await marineSnapshots({
    mode: opts.marine ?? "off",
    cacheDir: opts.marineCacheDir ?? join(dirname(resolve(lDir)), "marine"),
    watchlist: join(PKG_ROOT, "watchlists", "marine.json"),
    now,
    log,
  });
  if (marine.fishing) write("api/marine/fishing.json", marine.fishing);
  if (marine.ships) write("api/marine/ships.json", marine.ships);

  // ---- in the news (context only; never evidence) ----
  const newsMode = opts.news ?? "off";
  const news =
    newsMode === "off"
      ? new Map()
      : await newsForCases(findings, {
          cacheDir: opts.newsCacheDir ?? join(resolve(lDir), "news"),
          budget: new CallBudget(newsMode === "auto" ? gdeltCapFromEnv() : 0),
          now,
          log,
        });
  for (const [id, items] of news) write(`api/news/${id}.json`, JSON.stringify({ generatedAt: now.toISOString(), note: NEWS_NOTE, items }));

  const schemaFile = join(PKG_ROOT, "schema", "finding-event.v1.json");
  if (existsSync(schemaFile)) write("schema/finding-event.v1.json", readFileSync(schemaFile));

  // ---- the built bundle: assets + public files; its index.html is the page template ----
  const siteDir = opts.siteDir === undefined ? join(PKG_ROOT, "dist", "site") : opts.siteDir;
  const web = siteDir !== null && existsSync(join(siteDir, "index.html"));
  let tpl = FALLBACK_TEMPLATE;
  if (web) {
    tpl = readFileSync(join(siteDir!, "index.html"), "utf8");
    const tplPath = resolve(siteDir!, "index.html");
    cpSync(siteDir!, out, { recursive: true, filter: (src) => resolve(src) !== tplPath && !src.endsWith(".map") });
  } else log(`  note: built site not found${siteDir ? ` at ${siteDir}` : ""} — run \`pnpm build\`; pages are written unstyled.`);

  // ---- pages ----
  const ctx = (depth: number, path: string): Ctx => ({ depth, path, baseUrl, stats });
  const published = findings.filter((f) => PUBLIC_STATUSES.includes(f.status));
  write("index.html", fillTemplate(tpl, 0, "landing", landingPage(ctx(0, ""), findings)));
  write("developers/index.html", fillTemplate(tpl, 1, "developers", developersPage(ctx(1, "developers/"))));
  write("watch/index.html", fillTemplate(tpl, 1, "watch", watchIndexPage(ctx(1, "watch/"), findings)));
  let replyCount = 0;
  for (const d of cases) {
    const path = `watch/case/${d.finding.findingId}/`;
    const isPublic = PUBLIC_STATUSES.includes(d.finding.status);
    // Only public cases show replies (and take new ones); the reviewer only accepts on those anyway.
    const replies = isPublic ? readPublicReplies(repliesDir, d.finding.findingId) : [];
    if (replies.length) {
      write(`api/replies/${d.finding.findingId}.json`, JSON.stringify({ caseId: d.finding.findingId, reviewedBy: "second model", replies: replies.map(({ id, text, role, receivedAt }) => ({ id, text, role, receivedAt })) }));
      replyCount += replies.length;
    }
    write(`${path}index.html`, fillTemplate(tpl, 3, "case", casePage(ctx(3, path), d, { replies, replyEndpoint: isPublic && d.finding.status !== "retracted" ? replyEndpoint : null, news: news.get(d.finding.findingId) })));
  }
  if (replyCount) log(`  replies: ${replyCount} public repl${replyCount === 1 ? "y" : "ies"} shown`);
  if (trust) {
    const md = readFileSync(trustFile, "utf8");
    write("TRUST.md", md);
    write("trust.html", fillTemplate(tpl, 0, "trust", trustPage(ctx(0, "trust.html"), md)));
  }

  write("site.webmanifest", webManifest());

  // ---- crawlers ----
  write("robots.txt", robots(baseUrl));
  if (baseUrl) {
    const pages = [
      { path: "", lastmod: stats.generatedAt },
      { path: "watch/", lastmod: findings[0]?.updatedAt ?? stats.generatedAt },
      { path: "developers/" },
      ...published.map((f) => ({ path: `watch/case/${f.findingId}/`, lastmod: f.updatedAt })),
      ...(trust ? [{ path: "trust.html" }] : []),
    ];
    write("sitemap.xml", sitemap(baseUrl, pages));
  } else log("  note: no --base-url — sitemap.xml, canonical URLs and og:image are omitted.");

  write(MARKER, `${now.toISOString()}\n`);
  return {
    out,
    findings: findings.length,
    publicFindings: stats.cases.public,
    pulse: pulse.kind,
    marine: { fishing: Boolean(marine.fishing), ships: Boolean(marine.ships) },
    news: news.size,
    web,
    trust,
    sitemap: baseUrl !== null,
    files: listFiles(out),
  };
}

/** Refuse to clobber a directory we didn't write; otherwise empty it (stale partial tiles etc.). */
function prepareOut(out: string, force: boolean): void {
  if (existsSync(out)) {
    if (!statSync(out).isDirectory()) throw new Error(`${out} exists and is not a directory`);
    const entries = readdirSync(out);
    if (entries.length && !entries.includes(MARKER) && !force) {
      throw new Error(`${out} is not empty and was not written by \`earthdeck watch export\` — pass --force to overwrite it`);
    }
    for (const e of entries) rmSync(join(out, e), { recursive: true, force: true });
  }
  mkdirSync(out, { recursive: true });
}

async function pulseSnapshot(
  mode: "auto" | "cache" | "off",
  cachePath: string,
  timeoutMs: number,
  log: (s: string) => void,
): Promise<{ kind: "fresh" | "cached" | "none"; json?: string }> {
  if (mode === "off") return { kind: "none" };
  if (mode === "auto") {
    try {
      const { worldPulse } = await import("../tools/worldpulse.js");
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<never>((_, rej) => {
        timer = setTimeout(() => rej(new Error(`timed out after ${timeoutMs} ms`)), timeoutMs);
      });
      const p = await Promise.race([worldPulse(), timeout]).finally(() => clearTimeout(timer));
      if (p.rows.some((r) => r.status === "ok")) {
        const json = JSON.stringify(p);
        try {
          mkdirSync(dirname(cachePath), { recursive: true });
          writeFileSync(cachePath, json);
        } catch {
          /* cache is best-effort */
        }
        return { kind: "fresh", json };
      }
      log("  world pulse: every source unavailable — falling back to the cached snapshot");
    } catch (e) {
      log(`  world pulse: ${(e as Error).message} — falling back to the cached snapshot`);
    }
  }
  if (existsSync(cachePath)) {
    try {
      const json = readFileSync(cachePath, "utf8");
      const parsed = JSON.parse(json) as { rows?: unknown };
      if (Array.isArray(parsed.rows)) return { kind: "cached", json };
    } catch {
      /* unreadable cache → omit */
    }
  }
  return { kind: "none" };
}

async function stormsSnapshot(now: Date, timeoutMs: number, log: (s: string) => void): Promise<string | null> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const [{ activeStorms }, { stormsGeoJson }] = await Promise.all([import("../clients/storms.js"), import("../tools/weather.js")]);
    const timeout = new Promise<never>((_, rej) => {
      timer = setTimeout(() => rej(new Error(`timed out after ${timeoutMs} ms`)), timeoutMs);
    });
    const r = await Promise.race([activeStorms(now.toISOString().slice(0, 10)), timeout]);
    return JSON.stringify({ generatedAt: now.toISOString(), ...stormsGeoJson(r.storms) });
  } catch (e) {
    log(`  storms: ${(e as Error).message} — the cyclone layer is left out`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function listFiles(root: string, rel = ""): string[] {
  const out: string[] = [];
  for (const e of readdirSync(join(root, rel), { withFileTypes: true })) {
    const p = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...listFiles(root, p));
    else out.push(p);
  }
  return out.sort();
}

// ---- CLI ---------------------------------------------------------------------------------------

export async function runExportCli(args: string[]): Promise<void> {
  const opt = (name: string) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const out = opt("--out");
  if (!out) {
    process.stdout.write(
      [
        "usage: earthdeck watch export --out <dir> [--base-url https://…] [--reply-url https://…] [--replies <dir>]",
        "                              [--no-pulse | --pulse-cache <file>] [--no-marine] [--no-news] [--trust TRUST.md] [--force]",
        `Writes the public ${SITE.name} site (landing + case pages + ledger + feeds) as static files.`,
        `--base-url defaults to ${SITE.baseUrl} (src/site.config.ts); it drives canonical URLs, og:*, JSON-LD and sitemap.xml.`,
        "",
      ].join("\n"),
    );
    process.exitCode = 2;
    return;
  }
  const report = await exportSite({
    out,
    baseUrl: opt("--base-url"),
    contact: opt("--contact"),
    replyUrl: opt("--reply-url"),
    repliesDir: opt("--replies"),
    pulse: args.includes("--no-pulse") ? "off" : "auto",
    pulseCache: opt("--pulse-cache"),
    marine: args.includes("--no-marine") ? "off" : "auto",
    news: args.includes("--no-news") ? "off" : "auto",
    trustFile: opt("--trust"),
    force: args.includes("--force"),
    log: (s) => process.stdout.write(`${s}\n`),
  });
  process.stdout.write(
    `exported ${report.findings} findings (${report.publicFindings} public) → ${report.out}\n` +
      `  ${report.files.length} files · world pulse: ${report.pulse} · marine: fishing ${report.marine.fishing ? "yes" : "no"}, ships ${report.marine.ships ? "yes" : "no"} · news: ${report.news} cases · web bundle: ${report.web ? "yes" : "MISSING"} · TRUST.md: ${report.trust ? "rendered" : "not found"} · sitemap: ${report.sitemap ? "yes" : "no"}\n` +
      `  preview: npx -y serve ${report.out}\n`,
  );
}
