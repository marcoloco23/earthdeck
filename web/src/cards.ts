import { renderChart, renderSparkline, type SeriesData } from "./chart";
import { el, statusBadge, tierBadge } from "./ui";
import type { Card, EventItem, FireItem, QuakeItem } from "./types";

/**
 * Display metadata per card type. The order is the filter-chip order. Any type NOT listed
 * here (a newer server may add one) still renders with the generic chrome — header, time,
 * provenance, bbox footer — under a neutral tone, so new tools never need UI work to show up.
 */
const TYPE_META: Record<string, { label: string }> = {
  note: { label: "Note" },
  finding: { label: "Finding" },
  imagery: { label: "Imagery" },
  index: { label: "Index" },
  compare: { label: "Compare" },
  similar: { label: "Similar" },
  search: { label: "Search" },
  fires: { label: "Fires" },
  events: { label: "Events" },
  quakes: { label: "Quakes" },
  series: { label: "Series" },
  pulse: { label: "Pulse" },
  worldpulse: { label: "World pulse" },
};

export const TYPE_ORDER = Object.keys(TYPE_META);

const NOTE_KINDS = new Set(["info", "insight", "warning"]);

const known = (type: string): boolean => Object.prototype.hasOwnProperty.call(TYPE_META, type);

/** Class-safe tone key: a known type, or "other" (untrusted strings never reach a class name). */
export function toneOf(type: string): string {
  return known(type) ? type : "other";
}

export function typeLabel(type: string): string {
  if (known(type)) return TYPE_META[type]!.label;
  const s = String(type).replace(/[_-]+/g, " ").slice(0, 24);
  return s ? s[0]!.toUpperCase() + s.slice(1) : "Card";
}

function clockOf(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

interface ProvenanceView {
  sensor?: string;
  composite?: { from?: string; to?: string; mosaicking?: string };
  cloudMask?: { method?: string; excludedClasses?: string[]; validPct?: number };
  scenes?: Array<{ id?: string; datetime?: string; cloudCover?: number | null }>;
  disclaimer?: string;
}

/**
 * A collapsible provenance footer. Built entirely from DOM nodes + textContent (never
 * innerHTML) since some fields (scene ids) originate from the upstream API.
 */
function renderProvenance(prov: ProvenanceView, label?: string): HTMLElement {
  const det = el("details", "card-prov");
  det.addEventListener("click", (e) => e.stopPropagation()); // expanding shouldn't focus the card
  det.appendChild(el("summary", "", label ? `Provenance · ${label}` : "Provenance"));

  const dl = el("dl", "kv");
  const row = (k: string, v: string): void => {
    if (!v) return;
    dl.append(el("dt", "", k), el("dd", "", v));
  };
  row("Sensor", prov.sensor ?? "");
  if (prov.composite) {
    row("Composite", `${prov.composite.from ?? "?"} … ${prov.composite.to ?? "?"} (${prov.composite.mosaicking ?? "leastCC"})`);
  }
  if (prov.cloudMask) {
    row("Cloud mask", prov.cloudMask.method ?? "");
    if (typeof prov.cloudMask.validPct === "number") row("Valid pixels", `${prov.cloudMask.validPct}%`);
    if (prov.cloudMask.excludedClasses?.length) row("Excluded", prov.cloudMask.excludedClasses.join(", "));
  }
  if (prov.scenes?.length) {
    const ids = prov.scenes.map((s) => (s.datetime || s.id || "").slice(0, 10)).filter(Boolean);
    row("Scenes", ids.join(", "));
  }
  det.appendChild(dl);
  if (prov.disclaimer) det.appendChild(el("p", "prov-note", prov.disclaimer));
  return det;
}

/** Append inline text to a node, turning **bold** spans into <strong> — DOM nodes only. */
function appendInline(parent: HTMLElement, text: string): void {
  const parts = text.split(/\*\*(.+?)\*\*/g); // odd indices were inside **…**
  parts.forEach((part, i) => {
    if (!part) return;
    parent.appendChild(i % 2 === 1 ? el("strong", "", part) : document.createTextNode(part));
  });
}

/**
 * Render a note body with markdown-lite: `## ` headings, `- ` bullets, `**bold**`, and
 * blank-line paragraphs. Built ENTIRELY from DOM nodes/textContent — the text is
 * model/tool-supplied and must never reach innerHTML.
 */
function renderNoteBody(text: string): HTMLElement {
  const body = el("div", "note-body");
  let list: HTMLUListElement | null = null;
  const closeList = () => {
    if (list) body.appendChild(list);
    list = null;
  };
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trimEnd();
    if (line.startsWith("- ")) {
      list ??= el("ul");
      const li = el("li");
      appendInline(li, line.slice(2));
      list.appendChild(li);
      continue;
    }
    closeList();
    if (line === "") continue;
    if (line.startsWith("## ")) {
      const h = el("div", "note-h");
      appendInline(h, line.slice(3));
      body.appendChild(h);
    } else {
      const p = el("p");
      appendInline(p, line);
      body.appendChild(p);
    }
  }
  closeList();
  return body;
}

/** A compact list row: marker dot + primary text + muted secondary text. */
function listRow(primary: string, secondary: string, dotClass = ""): HTMLLIElement {
  const li = el("li");
  li.append(el("span", `dot ${dotClass}`.trim()), el("span", "li-main", primary));
  if (secondary) li.appendChild(el("span", "li-sub", secondary));
  return li;
}

function moreRow(n: number): HTMLLIElement {
  return el("li", "li-more", `+${n} more`);
}

/** A big number with a caption — the fires/index/compare headline stat. */
function stat(value: string, caption: string, tone = ""): HTMLElement {
  const s = el("div", `stat ${tone}`.trim());
  s.append(el("span", "stat-v", value), el("span", "stat-k", caption));
  return s;
}

/** Build the DOM node for a card in the feed. Newest cards are prepended by the caller. */
export function renderCard(card: Card, onFocus: (card: Card) => void): HTMLElement {
  const type = String(card.type);
  const tone = toneOf(type);
  const root = el("article", `card card--${tone}`);
  root.dataset.type = tone;
  root.tabIndex = 0;

  const head = el("header", "card-head");
  const kind = el("span", "card-kind");
  kind.append(el("span", "card-kind-dot"), el("span", "", typeLabel(type)));
  const time = el("time", "card-time", clockOf(card.ts));
  time.dateTime = card.ts;
  time.title = card.ts;
  head.append(kind, time);
  root.append(head, el("h3", "card-title", card.title));

  if (type === "imagery" && card.imageUrl) {
    const img = el("img", "card-img");
    img.loading = "lazy";
    img.alt = card.title;
    img.src = card.imageUrl;
    root.appendChild(img);
  }

  if (type === "note") {
    const text = typeof card.payload.text === "string" ? card.payload.text : "";
    const k = typeof card.payload.kind === "string" && NOTE_KINDS.has(card.payload.kind) ? card.payload.kind : "info";
    root.classList.add(`note--${k}`);
    root.appendChild(renderNoteBody(text));
  }

  if (type === "similar") {
    const matches = (card.payload.matches as Array<{ lon: number; lat: number; similarity: number }> | undefined) ?? [];
    const stats = card.payload.stats as { cells?: number; simMean?: number; simMax?: number } | undefined;
    const list = el("ol", "rows rows--ranked");
    for (const m of matches.slice(0, 8)) {
      list.appendChild(listRow(m.similarity.toFixed(3), `${m.lat.toFixed(4)}, ${m.lon.toFixed(4)}`));
    }
    root.appendChild(list);
    if (stats) root.appendChild(el("div", "card-note", `${stats.cells ?? "?"} cells · mean ${stats.simMean ?? "?"} · max ${stats.simMax ?? "?"}`));
    const attr = card.payload.attribution;
    if (typeof attr === "string") root.appendChild(el("div", "card-note", attr));
  }

  if (type === "events") {
    const events = (card.payload.events as EventItem[] | undefined) ?? [];
    const list = el("ul", "rows");
    for (const ev of events.slice(0, 10)) list.appendChild(listRow(ev.title, ev.category));
    if (events.length > 10) list.appendChild(moreRow(events.length - 10));
    root.appendChild(list);
  }

  if (type === "fires") {
    const fires = (card.payload.fires as FireItem[] | undefined) ?? [];
    const total = typeof card.payload.total === "number" ? card.payload.total : fires.length;
    const maxFrp = fires.reduce((m, f) => Math.max(m, f.frp ?? 0), 0);
    const row = el("div", "stats");
    row.appendChild(stat(total.toLocaleString("en-US"), `active-fire detection${total === 1 ? "" : "s"}`, total > 0 ? "stat--fire" : ""));
    if (maxFrp > 0) row.appendChild(stat(`${maxFrp.toFixed(0)} MW`, "peak radiative power"));
    root.appendChild(row);
  }

  if (type === "index") {
    const stats = card.payload.stats as
      | { mean: number; min: number; max: number; p50: number | null; validPct?: number }
      | undefined;
    const index = String(card.payload.index ?? "index");
    if (stats && Number.isFinite(stats.mean)) {
      // NDVI/NDWI/NBR are all in [-1, 1]; place the mean on a gradient bar.
      const pos = Math.max(0, Math.min(100, ((stats.mean + 1) / 2) * 100));
      const valid = typeof stats.validPct === "number" ? stats.validPct : null;
      const panel = el("div", "idx");
      const top = el("div", "stats");
      top.appendChild(stat(stats.mean.toFixed(3), `mean ${index}`, "stat--index"));
      if (valid !== null) top.appendChild(stat(`${valid}%`, "clear pixels", valid < 60 ? "stat--warn" : ""));
      const bar = el("div", "idx-bar");
      const marker = el("span", "idx-marker");
      marker.style.left = `${pos.toFixed(1)}%`;
      bar.appendChild(marker);
      const scale = el("div", "idx-scale");
      scale.append(el("span", "", "−1"), el("span", "", "0"), el("span", "", "+1"));
      panel.append(top, bar, scale);
      panel.appendChild(el("div", "card-note", `min ${stats.min.toFixed(2)} · median ${(stats.p50 ?? stats.mean).toFixed(2)} · max ${stats.max.toFixed(2)}`));
      root.appendChild(panel);
    }
  }

  if (type === "compare" && card.imageUrls && card.imageUrls.length >= 2) {
    const delta = card.payload.delta as { meanChange: number } | undefined;
    const index = String(card.payload.index ?? "NDVI");
    const dateA = String(card.payload.dateA ?? "A");
    const dateB = String(card.payload.dateB ?? "B");
    const pair = el("div", "cmp-pair");
    // Build via DOM nodes (img.src assignment), never innerHTML — the URL embeds an id.
    const figure = (url: string, caption: string): HTMLElement => {
      const fig = el("figure");
      const img = el("img", "card-img");
      img.loading = "lazy";
      img.alt = `${index} ${caption}`;
      img.src = url;
      fig.append(img, el("figcaption", "", caption));
      return fig;
    };
    pair.append(figure(card.imageUrls[0] ?? "", dateA), figure(card.imageUrls[1] ?? "", dateB));
    root.appendChild(pair);
    if (delta && Number.isFinite(delta.meanChange)) {
      const dv = delta.meanChange;
      const row = el("div", "stats");
      row.appendChild(stat(`${dv >= 0 ? "+" : "−"}${Math.abs(dv).toFixed(3)}`, `Δ mean ${index}`, dv < 0 ? "stat--down" : "stat--up"));
      root.appendChild(row);
    }
  }

  if (type === "search") {
    const scenes = (card.payload.scenes as Array<{ datetime: string; cloudCover: number | null }> | undefined) ?? [];
    const list = el("ul", "rows");
    for (const s of scenes.slice(0, 10)) {
      const cloud = s.cloudCover == null ? "—" : `${s.cloudCover.toFixed(0)}%`;
      list.appendChild(listRow((s.datetime || "").slice(0, 10), `cloud ${cloud}`));
    }
    // earthdata_search posts dataset collections instead of scenes.
    const collections =
      (card.payload.collections as Array<{ shortName: string; dataCenter: string; timeStart: string | null; timeEnd: string | null }> | undefined) ?? [];
    for (const c of collections.slice(0, 10)) {
      const span = `${(c.timeStart ?? "").slice(0, 4)}–${c.timeEnd ? c.timeEnd.slice(0, 4) : "now"}`;
      list.appendChild(listRow(c.shortName, `${c.dataCenter} · ${span}`));
    }
    root.appendChild(list);
  }

  if (type === "series") {
    const series = (card.payload.series as SeriesData[] | undefined) ?? [];
    const thresholds = Array.isArray(card.payload.thresholds)
      ? (card.payload.thresholds as number[]).filter((n) => typeof n === "number")
      : [];
    root.appendChild(renderChart(series, thresholds));
    if (typeof card.payload.summary === "string" && card.payload.summary) {
      root.appendChild(el("p", "card-text", card.payload.summary));
    }
    if (typeof card.payload.source === "string" && card.payload.source) {
      root.appendChild(el("div", "card-note", card.payload.source));
    }
  }

  if (type === "quakes") {
    const quakes = (card.payload.quakes as QuakeItem[] | undefined) ?? [];
    const list = el("ul", "rows");
    const top = [...quakes].sort((a, b) => (b.mag ?? 0) - (a.mag ?? 0)).slice(0, 8);
    for (const q of top) {
      const li = el("li");
      const big = (q.mag ?? 0) >= 6;
      li.append(el("span", `mag${big ? " mag--big" : ""}`, q.mag == null ? "M?" : `M${q.mag.toFixed(1)}`), el("span", "li-main", q.place), el("span", "li-sub", q.time.slice(0, 10)));
      list.appendChild(li);
    }
    if (quakes.length > top.length) list.appendChild(moreRow(quakes.length - top.length));
    root.appendChild(list);
  }

  if (type === "pulse") {
    const metrics =
      (card.payload.metrics as Array<{ label: string; value: string; sub?: string }> | undefined) ?? [];
    const grid = el("div", "tiles");
    for (const m of metrics.slice(0, 12)) {
      const cell = el("div", "tile");
      cell.append(el("div", "tile-k", String(m.label ?? "")), el("div", "tile-v", String(m.value ?? "")));
      if (m.sub) cell.appendChild(el("div", "tile-sub", String(m.sub)));
      grid.appendChild(cell);
    }
    root.appendChild(grid);
  }

  if (type === "finding") {
    const p = card.payload as { status?: string; tier?: number; rule?: { name: string; version: string }; summary?: string; evidence?: number };
    const row = el("div", "finding-row");
    row.appendChild(statusBadge(String(p.status ?? "candidate")));
    row.appendChild(tierBadge(p.tier));
    row.appendChild(el("span", "finding-meta", `${p.rule ? `${p.rule.name}@${p.rule.version} · ` : ""}${p.evidence ?? 0} evidence`));
    root.appendChild(row);
    if (p.summary) root.appendChild(el("p", "card-text", String(p.summary)));
  }

  if (type === "worldpulse") {
    const rows =
      (card.payload.rows as Array<{ label: string; unit: string; status: string; latest?: { t: string; v: number | null } | null; direction?: string; pace?: string | null; pctPerDecade?: number | null; sparkline?: { t: string; v: number | null }[] }> | undefined) ?? [];
    const grid = el("div", "tiles");
    for (const r of rows.slice(0, 16)) {
      const dir = r.status !== "ok" ? "na" : r.direction ?? "flat";
      const cell = el("div", `tile wp--${/^[a-z]+$/.test(dir) ? dir : "na"}`);
      const v = r.status !== "ok" || !r.latest || r.latest.v === null ? "n/a" : `${fmtNum(r.latest.v)}`;
      const vEl = el("div", "tile-v", v);
      if (v !== "n/a" && r.unit) vEl.appendChild(el("span", "tile-unit", ` ${r.unit}`));
      cell.append(el("div", "tile-k", r.label), vEl);
      if (r.status === "ok" && Array.isArray(r.sparkline) && r.sparkline.length > 2) cell.appendChild(renderSparkline(r.sparkline));
      const trend =
        r.status !== "ok"
          ? "unavailable"
          : `${dir === "improving" ? "▲ improving" : dir === "worsening" ? "▼ worsening" : "— flat"}${r.pctPerDecade != null ? ` · ${r.pctPerDecade > 0 ? "+" : ""}${r.pctPerDecade}%/dec` : ""}`;
      cell.appendChild(el("div", "tile-sub tile-trend", trend));
      cell.appendChild(el("div", "tile-sub", `${r.pace ? `${r.pace} · ` : ""}${r.latest?.t ?? ""}`));
      grid.appendChild(cell);
    }
    root.appendChild(grid);
    if (typeof card.payload.summary === "string") root.appendChild(el("div", "card-note", card.payload.summary));
  }

  // Provenance footer(s): single block for imagery/index, before/after pair for compare.
  const prov = card.payload.provenance as ProvenanceView | undefined;
  if (prov && typeof prov === "object") root.appendChild(renderProvenance(prov));
  const provA = card.payload.provenanceA as ProvenanceView | undefined;
  const provB = card.payload.provenanceB as ProvenanceView | undefined;
  if (provA && typeof provA === "object") root.appendChild(renderProvenance(provA, String(card.payload.dateA ?? "A")));
  if (provB && typeof provB === "object") root.appendChild(renderProvenance(provB, String(card.payload.dateB ?? "B")));

  if (card.bbox) {
    const foot = el("footer", "card-foot");
    const [w, s, e, n] = card.bbox;
    foot.append(el("span", "coords", `${fmtLat(s)} ${fmtLon(w)} → ${fmtLat(n)} ${fmtLon(e)}`), el("span", "card-go", "Show on map"));
    root.appendChild(foot);
    root.classList.add("card--located");
  }

  root.addEventListener("click", () => onFocus(card));
  root.addEventListener("keydown", (e) => {
    if (e.target !== root || (e.key !== "Enter" && e.key !== " ")) return;
    e.preventDefault();
    onFocus(card);
  });
  return root;
}

function fmtLat(v: number): string {
  return `${Math.abs(v).toFixed(2)}°${v < 0 ? "S" : "N"}`;
}
function fmtLon(v: number): string {
  return `${Math.abs(v).toFixed(2)}°${v < 0 ? "W" : "E"}`;
}

function fmtNum(v: number): string {
  const a = Math.abs(v);
  if (a >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
  if (a >= 1e4) return Math.round(v).toLocaleString("en-US");
  if (a >= 100) return v.toFixed(0);
  if (a >= 1) return v.toFixed(2);
  return v.toPrecision(3);
}
