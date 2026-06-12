import { renderChart, type SeriesData } from "./chart";
import type { Card, EventItem, FireItem, QuakeItem } from "./types";

const TYPE_LABEL: Record<Card["type"], string> = {
  imagery: "IMAGERY",
  index: "INDEX",
  fires: "FIRES",
  events: "EVENTS",
  compare: "COMPARE",
  search: "SEARCH",
  series: "SERIES",
  quakes: "QUAKES",
  pulse: "PULSE",
  note: "NOTE",
  similar: "SIMILAR",
};

const NOTE_KINDS = new Set(["info", "insight", "warning"]);

/** Coerce an untrusted card type to a known one so it can't be injected into class names. */
function safeType(type: string): Card["type"] {
  return (Object.prototype.hasOwnProperty.call(TYPE_LABEL, type) ? type : "search") as Card["type"];
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function timeOf(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleTimeString();
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
  const det = document.createElement("details");
  det.className = "card-prov";
  det.addEventListener("click", (e) => e.stopPropagation()); // expanding shouldn't focus the card
  const sum = document.createElement("summary");
  sum.textContent = label ? `provenance · ${label}` : "provenance";
  det.appendChild(sum);

  const dl = document.createElement("dl");
  dl.className = "prov-dl";
  const row = (k: string, v: string): void => {
    if (!v) return;
    const dt = document.createElement("dt");
    dt.textContent = k;
    const dd = document.createElement("dd");
    dd.textContent = v;
    dl.append(dt, dd);
  };
  row("sensor", prov.sensor ?? "");
  if (prov.composite) {
    row("composite", `${prov.composite.from ?? "?"} … ${prov.composite.to ?? "?"} (${prov.composite.mosaicking ?? "leastCC"})`);
  }
  if (prov.cloudMask) {
    row("cloud mask", prov.cloudMask.method ?? "");
    if (typeof prov.cloudMask.validPct === "number") row("valid pixels", `${prov.cloudMask.validPct}%`);
    if (prov.cloudMask.excludedClasses?.length) row("excluded", prov.cloudMask.excludedClasses.join(", "));
  }
  if (prov.scenes?.length) {
    const ids = prov.scenes.map((s) => (s.datetime || s.id || "").slice(0, 10)).filter(Boolean);
    row("scenes", ids.join(", "));
  }
  det.appendChild(dl);
  if (prov.disclaimer) {
    const note = document.createElement("p");
    note.className = "prov-note";
    note.textContent = prov.disclaimer;
    det.appendChild(note);
  }
  return det;
}

/** Append inline text to a node, turning **bold** spans into <strong> — DOM nodes only. */
function appendInline(parent: HTMLElement, text: string): void {
  const parts = text.split(/\*\*(.+?)\*\*/g); // odd indices were inside **…**
  parts.forEach((part, i) => {
    if (!part) return;
    if (i % 2 === 1) {
      const b = document.createElement("strong");
      b.textContent = part;
      parent.appendChild(b);
    } else {
      parent.appendChild(document.createTextNode(part));
    }
  });
}

/**
 * Render a note body with markdown-lite: `## ` headings, `- ` bullets, `**bold**`, and
 * blank-line paragraphs. Built ENTIRELY from DOM nodes/textContent — the text is
 * model/tool-supplied and must never reach innerHTML.
 */
function renderNoteBody(text: string): HTMLElement {
  const body = document.createElement("div");
  body.className = "note-body";
  let list: HTMLUListElement | null = null;
  const closeList = () => {
    if (list) body.appendChild(list);
    list = null;
  };
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trimEnd();
    if (line.startsWith("- ")) {
      list ??= document.createElement("ul");
      const li = document.createElement("li");
      appendInline(li, line.slice(2));
      list.appendChild(li);
      continue;
    }
    closeList();
    if (line === "") continue;
    if (line.startsWith("## ")) {
      const h = document.createElement("div");
      h.className = "note-h";
      appendInline(h, line.slice(3));
      body.appendChild(h);
    } else {
      const p = document.createElement("p");
      appendInline(p, line);
      body.appendChild(p);
    }
  }
  closeList();
  return body;
}

/** Build the DOM node for a card in the feed. Newest cards are prepended by the caller. */
export function renderCard(card: Card, onFocus: (card: Card) => void): HTMLElement {
  const t = safeType(card.type);
  const el = document.createElement("article");
  el.className = `card card--${t}`;

  const head = document.createElement("div");
  head.className = "card-head";
  head.innerHTML = `<span class="badge badge--${t}">${TYPE_LABEL[t]}</span>
    <span class="card-title">${escapeHtml(card.title)}</span>
    <span class="card-time">${timeOf(card.ts)}</span>`;
  el.appendChild(head);

  if (card.type === "imagery" && card.imageUrl) {
    const img = document.createElement("img");
    img.className = "card-img";
    img.loading = "lazy";
    img.src = card.imageUrl;
    el.appendChild(img);
  }

  if (card.type === "note") {
    const text = typeof card.payload.text === "string" ? card.payload.text : "";
    const kind = typeof card.payload.kind === "string" && NOTE_KINDS.has(card.payload.kind) ? card.payload.kind : "info";
    el.classList.add(`note--${kind}`);
    el.appendChild(renderNoteBody(text));
  }

  if (card.type === "similar") {
    const matches = (card.payload.matches as Array<{ lon: number; lat: number; similarity: number }> | undefined) ?? [];
    const stats = card.payload.stats as { cells?: number; simMean?: number; simMax?: number } | undefined;
    const list = document.createElement("ul");
    list.className = "evt-list";
    for (const [i, m] of matches.slice(0, 8).entries()) {
      const li = document.createElement("li");
      const dot = document.createElement("span");
      dot.className = "evt-dot sim-dot";
      li.appendChild(dot);
      li.appendChild(document.createTextNode(`#${i + 1}  ${m.similarity.toFixed(3)}  `));
      const em = document.createElement("em");
      em.textContent = `${m.lat.toFixed(4)}, ${m.lon.toFixed(4)}`;
      li.appendChild(em);
      list.appendChild(li);
    }
    el.appendChild(list);
    if (stats) {
      const s = document.createElement("div");
      s.className = "series-source";
      s.textContent = `${stats.cells ?? "?"} cells · mean sim ${stats.simMean ?? "?"} · max ${stats.simMax ?? "?"}`;
      el.appendChild(s);
    }
    const attr = card.payload.attribution;
    if (typeof attr === "string") {
      const a = document.createElement("div");
      a.className = "series-source";
      a.textContent = attr;
      el.appendChild(a);
    }
  }

  if (card.type === "events") {
    const events = (card.payload.events as EventItem[] | undefined) ?? [];
    const list = document.createElement("ul");
    list.className = "evt-list";
    for (const ev of events.slice(0, 12)) {
      const li = document.createElement("li");
      li.innerHTML = `<span class="evt-dot"></span>${escapeHtml(ev.title)} <em>${escapeHtml(ev.category)}</em>`;
      list.appendChild(li);
    }
    if (events.length > 12) {
      const more = document.createElement("li");
      more.className = "evt-more";
      more.textContent = `+${events.length - 12} more`;
      list.appendChild(more);
    }
    el.appendChild(list);
  }

  if (card.type === "fires") {
    const fires = (card.payload.fires as FireItem[] | undefined) ?? [];
    const total = typeof card.payload.total === "number" ? card.payload.total : fires.length;
    const maxFrp = fires.reduce((m, f) => Math.max(m, f.frp ?? 0), 0);
    const summary = document.createElement("div");
    summary.className = "fire-summary";
    summary.innerHTML =
      `<span class="fire-count">${total}</span> active-fire detection${total === 1 ? "" : "s"}` +
      (maxFrp > 0 ? ` · peak FRP ${maxFrp.toFixed(0)} MW` : "");
    el.appendChild(summary);
  }

  if (card.type === "index") {
    const stats = card.payload.stats as
      | { mean: number; min: number; max: number; p50: number | null; validPct?: number }
      | undefined;
    const index = String(card.payload.index ?? "index");
    if (stats) {
      // NDVI/NDWI/NBR are all in [-1, 1]; place the mean on a gradient bar.
      const pos = Math.max(0, Math.min(100, ((stats.mean + 1) / 2) * 100));
      const valid = typeof stats.validPct === "number" ? stats.validPct : null;
      const panel = document.createElement("div");
      panel.className = "idx-panel";
      panel.innerHTML =
        `<div class="idx-top"><span class="idx-name">${escapeHtml(index)}</span>` +
        `<span class="idx-mean">${stats.mean.toFixed(3)}</span></div>` +
        `<div class="idx-bar"><span class="idx-marker" style="left:${pos.toFixed(1)}%"></span></div>` +
        `<div class="idx-row">min ${stats.min.toFixed(2)} · median ${(stats.p50 ?? stats.mean).toFixed(2)} · max ${stats.max.toFixed(2)}` +
        (valid !== null ? ` · <span class="${valid < 60 ? "idx-warn" : ""}">${valid}% clear</span>` : ``) +
        `</div>`;
      el.appendChild(panel);
    }
  }

  if (card.type === "compare" && card.imageUrls && card.imageUrls.length >= 2) {
    const delta = card.payload.delta as { meanChange: number } | undefined;
    const index = String(card.payload.index ?? "NDVI");
    const dateA = String(card.payload.dateA ?? "A");
    const dateB = String(card.payload.dateB ?? "B");
    const pair = document.createElement("div");
    pair.className = "cmp-pair";
    // Build via DOM nodes (img.src assignment), never innerHTML — the URL embeds an id.
    const figure = (url: string, caption: string): HTMLElement => {
      const fig = document.createElement("figure");
      const img = document.createElement("img");
      img.className = "card-img";
      img.loading = "lazy";
      img.src = url;
      const cap = document.createElement("figcaption");
      cap.textContent = caption;
      fig.append(img, cap);
      return fig;
    };
    pair.append(figure(card.imageUrls[0] ?? "", dateA), figure(card.imageUrls[1] ?? "", dateB));
    el.appendChild(pair);
    if (delta) {
      const dv = delta.meanChange;
      const d = document.createElement("div");
      d.className = `cmp-delta ${dv < 0 ? "down" : "up"}`;
      d.textContent = `Δ ${escapeHtml(index)} mean ${dv >= 0 ? "+" : ""}${dv.toFixed(3)}`;
      el.appendChild(d);
    }
  }

  if (card.type === "search") {
    const scenes = (card.payload.scenes as Array<{ datetime: string; cloudCover: number | null }> | undefined) ?? [];
    const list = document.createElement("ul");
    list.className = "evt-list";
    for (const s of scenes.slice(0, 10)) {
      const li = document.createElement("li");
      const cloud = s.cloudCover == null ? "—" : `${s.cloudCover.toFixed(0)}%`;
      li.innerHTML = `<span class="evt-dot"></span>${escapeHtml((s.datetime || "").slice(0, 10))} <em>cloud ${cloud}</em>`;
      list.appendChild(li);
    }
    // earthdata_search posts dataset collections instead of scenes.
    const collections =
      (card.payload.collections as Array<{ shortName: string; dataCenter: string; timeStart: string | null; timeEnd: string | null }> | undefined) ?? [];
    for (const c of collections.slice(0, 10)) {
      const li = document.createElement("li");
      const dot = document.createElement("span");
      dot.className = "evt-dot";
      const em = document.createElement("em");
      const span = `${(c.timeStart ?? "").slice(0, 4)}–${c.timeEnd ? c.timeEnd.slice(0, 4) : "now"}`;
      em.textContent = `${c.dataCenter} · ${span}`;
      li.append(dot, document.createTextNode(`${c.shortName} `), em);
      list.appendChild(li);
    }
    el.appendChild(list);
  }

  if (card.type === "series") {
    const series = (card.payload.series as SeriesData[] | undefined) ?? [];
    const thresholds = Array.isArray(card.payload.thresholds)
      ? (card.payload.thresholds as number[]).filter((n) => typeof n === "number")
      : [];
    el.appendChild(renderChart(series, thresholds));
    if (typeof card.payload.summary === "string" && card.payload.summary) {
      const p = document.createElement("p");
      p.className = "series-summary";
      p.textContent = card.payload.summary;
      el.appendChild(p);
    }
    if (typeof card.payload.source === "string" && card.payload.source) {
      const src = document.createElement("div");
      src.className = "series-source";
      src.textContent = card.payload.source;
      el.appendChild(src);
    }
  }

  if (card.type === "quakes") {
    const quakes = (card.payload.quakes as QuakeItem[] | undefined) ?? [];
    const list = document.createElement("ul");
    list.className = "evt-list";
    const top = [...quakes].sort((a, b) => (b.mag ?? 0) - (a.mag ?? 0)).slice(0, 8);
    for (const q of top) {
      const li = document.createElement("li");
      const dot = document.createElement("span");
      dot.className = "evt-dot quake-dot";
      const em = document.createElement("em");
      em.textContent = q.time.slice(0, 10);
      li.append(dot, document.createTextNode(`M${q.mag ?? "?"} ${q.place} `), em);
      list.appendChild(li);
    }
    if (quakes.length > top.length) {
      const more = document.createElement("li");
      more.className = "evt-more";
      more.textContent = `+${quakes.length - top.length} more`;
      list.appendChild(more);
    }
    el.appendChild(list);
  }

  if (card.type === "pulse") {
    const metrics =
      (card.payload.metrics as Array<{ label: string; value: string; sub?: string }> | undefined) ?? [];
    const grid = document.createElement("div");
    grid.className = "pulse-grid";
    for (const m of metrics.slice(0, 12)) {
      const cell = document.createElement("div");
      cell.className = "pulse-cell";
      const v = document.createElement("div");
      v.className = "pulse-value";
      v.textContent = String(m.value ?? "");
      const l = document.createElement("div");
      l.className = "pulse-label";
      l.textContent = String(m.label ?? "");
      cell.append(l, v);
      if (m.sub) {
        const s = document.createElement("div");
        s.className = "pulse-sub";
        s.textContent = String(m.sub);
        cell.appendChild(s);
      }
      grid.appendChild(cell);
    }
    el.appendChild(grid);
  }

  // Provenance footer(s): single block for imagery/index, before/after pair for compare.
  const prov = card.payload.provenance as ProvenanceView | undefined;
  if (prov) el.appendChild(renderProvenance(prov));
  const provA = card.payload.provenanceA as ProvenanceView | undefined;
  const provB = card.payload.provenanceB as ProvenanceView | undefined;
  if (provA) el.appendChild(renderProvenance(provA, String(card.payload.dateA ?? "A")));
  if (provB) el.appendChild(renderProvenance(provB, String(card.payload.dateB ?? "B")));

  if (card.bbox) {
    const bb = document.createElement("div");
    bb.className = "card-bbox";
    bb.textContent = card.bbox.map((n) => n.toFixed(2)).join(", ");
    el.appendChild(bb);
  }

  el.addEventListener("click", () => onFocus(card));
  return el;
}
