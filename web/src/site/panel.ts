// The landing's floating panel: five modes (Cases · Planet · Live · Metrics · About), the case list
// and its filters, a case opened in full without leaving the map, the planet dashboard, and the
// metrics screen. On a phone it is a bottom sheet (peek / half / full). It runs from api/map.json
// alone — the map chunk joins when it arrives and listens to the same hub.
//
// Ledger text is public input: every string from data goes in with textContent. The one exception
// is a case's own server-rendered article (fetched from its static page on this site, already
// escaped at export), which is parsed inert and stripped of anything executable before use.

import { EASE_OUT, el, reducedMotion } from "../ui";
import type { Hub } from "./hub";
import {
  GROUP_LABEL,
  GROUPS,
  MODES,
  TOPIC_LABEL,
  TOPICS,
  defaultOverlays,
  endMsOf,
  isGlobal,
  isVisible,
  nearestSnap,
  topicOfCase,
  boundsOf,
  type Group,
  type MapCase,
  type MapData,
  type Metrics,
  type Mode,
  type Snap,
  type Topic,
  type View,
} from "./map/model";
import { mountReplyForms } from "./reply";
import { verifyCase, wireCopy } from "./verify";

const LIST_STEP = 120;
const fmtDay = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso.slice(0, 10) : d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
};
const safe = (s: string) => s.replace(/[^a-z_]/g, "");
const phone = matchMedia("(max-width: 899px)");

export function mountPanel(hub: Hub): void {
  const panel = document.getElementById("panel");
  const body = document.getElementById("panel-body");
  if (!panel || !body) return;
  document.documentElement.classList.add("has-panel");
  // The hero fills what the header leaves (the header wraps to two rows on a phone).
  const header = document.querySelector<HTMLElement>(".site-top");
  const syncTop = () => header && document.documentElement.style.setProperty("--top-h", `${header.offsetHeight}px`);
  syncTop();
  addEventListener("resize", syncTop);
  const tabs = [...panel.querySelectorAll<HTMLAnchorElement>(".mode[data-mode]")];
  const panes = new Map(MODES.map((m) => [m, document.getElementById(`pane-${m}`)]));
  const toggle = panel.querySelector<HTMLButtonElement>(".panel-toggle");
  const caseView = body.querySelector<HTMLElement>(".case-view") ?? body.appendChild(el("div", "case-view"));
  caseView.hidden = true;
  const root = hub.root;
  let data: MapData | null = null;
  let byId = new Map<string, MapCase>();
  let only: Set<string> | null = null;

  // ---- modes ------------------------------------------------------------------------------------
  const tablist = panel.querySelector<HTMLElement>(".modes");
  for (const t of tabs) {
    t.addEventListener("click", (e) => {
      e.preventDefault();
      hub.touch();
      const m = t.dataset.mode as Mode;
      hub.set({ mode: m, open: false, panel: true });
      if (phone.matches && snap === "peek") setSnap("half");
    });
  }
  tablist?.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    e.preventDefault();
    e.stopPropagation();
    const i = tabs.findIndex((t) => t.dataset.mode === hub.get().mode);
    const next = tabs[(i + (e.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length]!;
    hub.touch();
    hub.set({ mode: next.dataset.mode as Mode, open: false });
    next.focus();
  });
  function renderMode(v: View): void {
    for (const t of tabs) {
      const on = t.dataset.mode === v.mode;
      t.setAttribute("aria-selected", String(on));
      t.tabIndex = on ? 0 : -1;
    }
    for (const [m, p] of panes) p?.classList.toggle("is-on", m === v.mode && !v.open);
    caseView.hidden = !v.open;
    panel!.dataset.mode = v.mode;
    if (v.mode === "planet") void loadPulse();
    if (v.mode === "metrics") void loadMetrics();
  }

  // ---- fold (desktop) / sheet (phone) ------------------------------------------------------------
  if (toggle) {
    toggle.hidden = false;
    toggle.addEventListener("click", () => {
      hub.touch();
      hub.set({ panel: !hub.get().panel });
    });
  }
  function renderFold(v: View): void {
    panel!.classList.toggle("is-folded", !v.panel && !phone.matches);
    toggle?.setAttribute("aria-expanded", String(v.panel));
    toggle?.setAttribute("aria-label", v.panel ? "Hide the panel" : "Show the panel");
    hub.emit("inset", {});
  }

  // Bottom sheet: 1:1 drag on the grip + tabs, momentum-projected snap, drawer curve to settle.
  let snap: Snap = "half";
  const offsets = (): Record<Snap, number> => {
    const h = panel!.offsetHeight;
    return { full: 0, half: Math.round(h * 0.52), peek: Math.max(0, h - 104) };
  };
  function setSnap(s: Snap, velocity = 0): void {
    snap = s;
    panel!.dataset.snap = s;
    const y = offsets()[s];
    panel!.style.transition = reducedMotion() ? "none" : `transform ${velocity > 1500 ? 280 : 380}ms cubic-bezier(0.32, 0.72, 0, 1)`;
    panel!.style.transform = phone.matches ? `translateY(${y}px)` : "";
    document.documentElement.style.setProperty("--sheet-y", `${phone.matches ? y : 0}px`);
    window.setTimeout(() => hub.emit("inset", {}), reducedMotion() ? 0 : 400); // once the sheet has settled
  }
  const grip = panel.querySelector<HTMLElement>(".panel-grip");
  const dragZone = [grip, panel.querySelector<HTMLElement>(".panel-head")].filter((x): x is HTMLElement => !!x);
  let drag: { start: number; base: number; id: number; hist: [number, number][]; moved: boolean } | null = null;
  for (const z of dragZone) {
    z.addEventListener("pointerdown", (e) => {
      if (!phone.matches || e.button !== 0) return;
      drag = { start: e.clientY, base: offsets()[snap], id: e.pointerId, hist: [[e.clientY, e.timeStamp]], moved: false };
    });
  }
  addEventListener("pointermove", (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const dy = e.clientY - drag.start;
    if (!drag.moved && Math.abs(dy) < 8) return; // hysteresis: a tap on a tab stays a tap
    if (!drag.moved) {
      drag.moved = true;
      (e.target as Element).setPointerCapture?.(e.pointerId);
      panel.style.transition = "none";
    }
    const o = offsets();
    let y = drag.base + dy;
    if (y < 0) y = -((-y * 0.55 * 60) / (60 + 0.55 * -y)); // rubber-band past the top
    y = Math.min(o.peek + 40, y);
    panel.style.transform = `translateY(${y}px)`;
    drag.hist.push([e.clientY, e.timeStamp]);
    if (drag.hist.length > 6) drag.hist.shift();
  });
  const endDrag = (e: PointerEvent) => {
    if (!drag || e.pointerId !== drag.id) return;
    const d = drag;
    drag = null;
    if (!d.moved) return;
    const [y0, t0] = d.hist[0]!;
    const [y1, t1] = d.hist[d.hist.length - 1]!;
    const v = t1 > t0 ? ((y1 - y0) / (t1 - t0)) * 1000 : 0;
    const now = d.base + (e.clientY - d.start);
    setSnap(nearestSnap(now, v, offsets()), Math.abs(v));
    // A drag that ends on a tab must not also switch it.
    addEventListener("click", (c) => c.stopPropagation(), { capture: true, once: true });
  };
  addEventListener("pointerup", endDrag);
  addEventListener("pointercancel", endDrag);
  const onPhone = () => setSnap(phone.matches ? snap : "half");
  phone.addEventListener("change", onPhone);
  addEventListener("resize", () => phone.matches && setSnap(snap));

  // ---- Cases: filters + list ---------------------------------------------------------------------
  const pane = panes.get("cases")!;
  const filters = pane?.querySelector<HTMLElement>(".filters");
  const rowsBox = document.getElementById("case-rows");
  const head = pane?.querySelector<HTMLElement>(".pane-h");
  let limit = LIST_STEP;
  const statusSeg = el("div", "seg seg--status");
  statusSeg.setAttribute("role", "radiogroup");
  statusSeg.setAttribute("aria-label", "Status");
  const statusBtns: [string, HTMLButtonElement][] = [];
  const topicBox = el("div", "chips");
  topicBox.setAttribute("role", "group");
  topicBox.setAttribute("aria-label", "Topics");
  const topicBtns = new Map<Topic, HTMLButtonElement>();
  const metricChip = el("div", "metric-chip");
  metricChip.hidden = true;
  if (filters) {
    filters.append(statusSeg, topicBox, metricChip);
    filters.hidden = false;
  }

  const statusOf = (v: View): string => (v.groups.length === 1 ? v.groups[0]! : "all");
  function buildFilters(cases: MapCase[]): void {
    const local = cases.filter((c) => !isGlobal(c));
    const SHORT: Record<Group, string> = { published: "Published", checking: "Checking", dropped: "False alarms" };
    const opts: [string, string, number][] = [["all", "All", local.length], ...GROUPS.map((g): [string, string, number] => [g, SHORT[g], local.filter((c) => c.group === g).length])];
    for (const [k, label, n] of opts) {
      const b = el("button", `seg-b seg-b--${k}`);
      b.type = "button";
      b.setAttribute("role", "radio");
      if (k !== "all") b.append(el("span", `dot dot--${k}`));
      b.append(document.createTextNode(label), el("span", "seg-n", String(n)));
      b.addEventListener("click", () => {
        hub.touch();
        hub.set({ groups: k === "all" ? [...GROUPS] : [k as Group] });
      });
      statusSeg.appendChild(b);
      statusBtns.push([k, b]);
    }
    for (const t of TOPICS) {
      const n = local.filter((c) => topicOfCase(c) === t).length;
      if (!n) continue;
      const b = el("button", `chip-t chip-t--${t}`);
      b.type = "button";
      b.append(el("span", `ring ring--${t}`), document.createTextNode(TOPIC_LABEL[t]), el("span", "seg-n", String(n)));
      b.addEventListener("click", () => {
        hub.touch();
        const on = hub.get().topics;
        const all = TOPICS.every((x) => on.includes(x));
        let next: Topic[] = all ? [t] : on.includes(t) ? on.filter((x) => x !== t) : [...on, t];
        if (!next.length) next = [...TOPICS];
        hub.set({ topics: TOPICS.filter((x) => next.includes(x)) });
      });
      topicBox.appendChild(b);
      topicBtns.set(t, b);
    }
  }
  function renderFilters(v: View): void {
    const s = statusOf(v);
    for (const [k, b] of statusBtns) b.setAttribute("aria-checked", String(k === s));
    const all = TOPICS.every((x) => v.topics.includes(x));
    for (const [t, b] of topicBtns) b.setAttribute("aria-pressed", String(!all && v.topics.includes(t)));
  }

  const caseHref = (id: string) => `${root}watch/case/${encodeURIComponent(id)}/`;
  function openCase(id: string): void {
    hub.touch();
    const v = hub.get();
    const c = byId.get(id);
    hub.set({ sel: id, open: true, overlays: c ? defaultOverlays(c) : [] }, { push: !v.open });
  }
  // Server-rendered rows (no-JS, and first paint) and the planet rows open in place too.
  body.addEventListener("click", (e) => {
    const a = (e.target as Element).closest<HTMLAnchorElement>("a.case-row[data-case]");
    if (!a || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
    e.preventDefault();
    openCase(a.dataset.case!);
  });
  body.addEventListener("pointerover", (e) => {
    const a = (e.target as Element).closest<HTMLElement>("[data-case]");
    if (a && (e as PointerEvent).pointerType === "mouse") hub.emit("hot", { id: a.dataset.case! });
  });
  body.addEventListener("pointerout", (e) => {
    if ((e.target as Element).closest("[data-case]")) hub.emit("hot", { id: null });
  });

  function row(c: MapCase): HTMLLIElement {
    const li = el("li");
    const a = el("a", `case-row live-row${c.group === "published" ? "" : " is-unpublished"}`);
    a.href = caseHref(c.id);
    a.dataset.case = c.id;
    const top = el("span", "case-top");
    const badge = el("span", `status-badge status--${safe(c.status)}`);
    badge.append(el("span", "status-dot"), document.createTextNode(c.statusLabel));
    const when = el("time", "case-when", fmtDay(c.observedAt));
    when.dateTime = c.observedAt;
    top.append(badge, el("span", `ring ring--${topicOfCase(c)}`), when);
    a.append(top, el("span", "case-title", c.title));
    if (c.meta) a.append(el("span", "case-meta", c.meta));
    li.appendChild(a);
    return li;
  }
  function renderList(v: View): void {
    if (!data || !rowsBox) return;
    const end = endMsOf(v, data.generatedAt);
    const vis = data.cases.filter((c) => isVisible(c, v, end, only));
    rowsBox.replaceChildren(...vis.slice(0, limit).map(row));
    if (!vis.length) rowsBox.appendChild(el("li", "live-empty", "No cases match these filters — widen the time window or switch a filter off."));
    if (vis.length > limit) {
      const li = el("li", "more");
      const b = el("button", "btn btn--ghost btn--xs", `Show ${Math.min(LIST_STEP, vis.length - limit)} more of ${vis.length - limit}`);
      b.type = "button";
      b.addEventListener("click", () => {
        limit += LIST_STEP;
        renderList(hub.get());
      });
      li.appendChild(b);
      rowsBox.appendChild(li);
    }
    if (head) head.textContent = `${vis.length} case${vis.length === 1 ? "" : "s"}${only ? "" : " on the map"}`;
    markSel(v.sel);
  }
  function markSel(id: string | null): void {
    for (const a of body!.querySelectorAll<HTMLElement>("a.case-row[data-case]")) {
      const on = a.dataset.case === id;
      a.classList.toggle("is-sel", on);
      if (on && !hub.get().open) a.scrollIntoView({ block: "nearest", behavior: reducedMotion() ? "auto" : "smooth" });
    }
  }

  // Metrics narrowing ("the 12 cases behind this number").
  async function renderMetricChip(v: View): Promise<void> {
    if (!v.metric) {
      only = null;
      metricChip.hidden = true;
      return;
    }
    const m = await hub.metrics();
    const hit = m?.stake.find((s) => s.key === v.metric);
    only = hit ? new Set(hit.caseIds) : null;
    metricChip.replaceChildren();
    if (!hit) {
      metricChip.hidden = true;
      return;
    }
    const x = el("button", "metric-x", "×");
    x.type = "button";
    x.setAttribute("aria-label", "Show all cases again");
    x.addEventListener("click", () => {
      hub.touch();
      hub.set({ metric: null });
    });
    metricChip.append(el("span", "", `Only the cases behind “${hit.label}” (${hit.caseIds.length})`), x);
    metricChip.hidden = false;
  }

  // ---- a case, in full, in the panel -------------------------------------------------------------
  const articles = new Map<string, Promise<HTMLElement | null>>();
  function fetchArticle(id: string): Promise<HTMLElement | null> {
    const hit = articles.get(id);
    if (hit) return hit;
    const url = new URL(caseHref(id), location.href);
    const p = fetch(url)
      .then((r) => (r.ok ? r.text() : null))
      .then((html) => {
        if (!html) return null;
        const doc = new DOMParser().parseFromString(html, "text/html");
        const art = doc.querySelector<HTMLElement>("article.case");
        if (!art) return null;
        for (const x of art.querySelectorAll("script, style, iframe, object, embed, form")) x.remove();
        for (const n of art.querySelectorAll<HTMLElement>("*")) {
          for (const at of [...n.attributes]) if (/^on/i.test(at.name)) n.removeAttribute(at.name);
          for (const k of ["href", "src"]) {
            const v = n.getAttribute(k);
            if (v === null) continue;
            const abs = new URL(v, url);
            if (!/^https?:$/.test(abs.protocol)) n.removeAttribute(k);
            else n.setAttribute(k, abs.origin === location.origin ? abs.pathname + abs.search + abs.hash : abs.href);
          }
        }
        return document.importNode(art, true) as HTMLElement;
      })
      .catch(() => null);
    articles.set(id, p);
    return p;
  }
  let shown: string | null = null;
  async function renderCase(v: View): Promise<void> {
    if (!v.open || !v.sel) {
      shown = null;
      return;
    }
    if (shown === v.sel) return;
    const id = v.sel;
    shown = id;
    const c = byId.get(id);
    caseView.replaceChildren();
    const bar = el("div", "cv-bar");
    const back = el("button", "cv-back");
    back.type = "button";
    back.setAttribute("aria-label", "Back to the list");
    back.append(el("span", "cv-arrow", "←"), document.createTextNode(`Back to ${hub.get().mode === "cases" ? "the list" : hub.get().mode}`));
    back.addEventListener("click", closeCase);
    const full = el("a", "cv-full", "Case page ↗");
    full.href = caseHref(id);
    full.title = "The same case as its own page, for sharing or printing";
    bar.append(back, full);
    caseView.appendChild(bar);
    if (c) caseView.appendChild(overlayChips(c));
    const box = el("div", "cv-body");
    box.appendChild(el("p", "cv-loading", c ? c.title : "Loading the case…"));
    caseView.appendChild(box);
    caseView.scrollTop = 0;
    body!.scrollTop = 0;
    const art = await fetchArticle(id);
    if (shown !== id) return;
    box.replaceChildren();
    if (!art) {
      box.appendChild(el("p", "cv-loading", "This case couldn’t be loaded here."));
      const a = el("a", "link", "Open its page →");
      a.href = caseHref(id);
      box.appendChild(a);
      return;
    }
    box.appendChild(art);
    wireCopy(art);
    mountReplyForms(art);
    const vb = art.querySelector<HTMLElement>(".verify");
    const tech = art.querySelector<HTMLDetailsElement>("details.tech");
    if (vb && tech) tech.addEventListener("toggle", () => tech.open && void verifyCase(vb, root), { once: true });
    if (!reducedMotion()) box.animate([{ opacity: 0, transform: "translateY(6px)" }, { opacity: 1, transform: "none" }], { duration: 220, easing: EASE_OUT });
    back.focus({ preventScroll: true });
  }
  function closeCase(): void {
    if (hub.pushed()) history.back();
    else hub.set({ open: false });
  }

  function overlayChips(c: MapCase): HTMLElement {
    const box = el("div", "cv-ov");
    const t = topicOfCase(c);
    const opts: ["alerts" | "imagery" | "weather", string, string][] = [];
    if (t === "forest") opts.push(["alerts", "Forest alerts", "Global Forest Watch integrated alerts around the case dates"]);
    if (t !== "fire" && t !== "methane" && !isGlobal(c)) opts.push(["imagery", "Before / after", "Sentinel-2 / Landsat 30 m images (NASA HLS) from before and after — clouds happen"]);
    if (t === "weather") opts.push(["weather", "Rain now", "Satellite rain rate (NASA GPM IMERG), latest half hour"]);
    if (c.kind === "fire") box.appendChild(el("p", "cv-note", "Shown as the middle of the fire cluster, on purpose: exact detections in Indigenous land are not pinned."));
    if (!opts.length) return box;
    const chips = el("div", "cv-chips");
    chips.setAttribute("role", "group");
    chips.setAttribute("aria-label", "Evidence on the map");
    const fade = el("label", "cv-fade");
    const fr = el("input", "cv-range");
    fr.type = "range";
    fr.min = "0";
    fr.max = "100";
    fr.value = "100";
    fr.setAttribute("aria-label", "Blend from the before image to the after image");
    fr.addEventListener("input", () => hub.emit("fade", { value: Number(fr.value) / 100 }));
    fade.append(el("span", "", "Before"), fr, el("span", "", "After"));
    const sync = () => {
      const on = hub.get().overlays;
      for (const b of chips.querySelectorAll<HTMLButtonElement>("button")) b.setAttribute("aria-pressed", String(on.includes(b.dataset.ov as never)));
      fade.hidden = !on.includes("imagery");
    };
    for (const [k, label, title] of opts) {
      const b = el("button", "xp-chip", label);
      b.type = "button";
      b.title = title;
      b.dataset.ov = k;
      b.addEventListener("click", () => {
        hub.touch();
        const on = hub.get().overlays;
        hub.set({ overlays: on.includes(k) ? on.filter((x) => x !== k) : [...on, k] });
        sync();
      });
      chips.appendChild(b);
    }
    box.append(chips, fade);
    sync();
    return box;
  }

  // ---- Planet: world pulse with sparklines ----------------------------------------------------------
  let pulseLoaded = false;
  async function loadPulse(): Promise<void> {
    if (pulseLoaded) return;
    pulseLoaded = true;
    const box = document.getElementById("pulse");
    if (!box) return;
    type Row = { slug: string; label: string; unit?: string; group?: string; status?: string; latest?: { t: string; v: number }; direction?: string; pctPerDecade?: number; sparkline?: { t: string; v: number }[] };
    const p = await fetch(`${root}api/pulse.json`)
      .then((r) => (r.ok ? (r.json() as Promise<{ rows?: Row[] }>) : null))
      .catch(() => null);
    if (!p || !Array.isArray(p.rows)) return;
    const globalBySlug = new Map<string, MapCase>();
    for (const c of data?.cases ?? []) if (isGlobal(c) && c.indicator) globalBySlug.set(c.indicator, c);
    const GROUP_NAME: Record<string, string> = { planet: "Planet", life: "Life", civilization: "People" };
    const groups = new Map<string, Row[]>();
    for (const r of p.rows) if (r.status === "ok" && r.latest) groups.set(r.group ?? "other", [...(groups.get(r.group ?? "other") ?? []), r]);
    for (const [g, rows] of groups) {
      const sec = el("section", "pulse-g");
      const up = rows.filter((r) => r.direction === "improving").length;
      const down = rows.filter((r) => r.direction === "worsening").length;
      const h = el("h3", "pane-sub");
      h.append(document.createTextNode(GROUP_NAME[g] ?? g), el("span", "wp--improving pulse-tally", `▲ ${up}`), el("span", "wp--worsening pulse-tally", `▼ ${down}`));
      sec.appendChild(h);
      const ul = el("ul", "pulse-rows");
      for (const r of rows) {
        const li = el("li", `pulse-row wp--${safe(r.direction ?? "flat")}`);
        const txt = el("div", "pulse-txt");
        txt.append(el("span", "pulse-l", r.label));
        const val = `${Number(r.latest!.v.toPrecision(3)).toLocaleString("en-US")}${r.unit ? ` ${r.unit}` : ""} · ${r.latest!.t}`;
        txt.append(el("span", "pulse-v", val));
        li.append(txt, sparkline(r.sparkline ?? []));
        const pace = typeof r.pctPerDecade === "number" ? `${r.pctPerDecade > 0 ? "+" : ""}${r.pctPerDecade}%/10y` : "";
        li.append(el("span", "pulse-d", `${r.direction === "improving" ? "▲" : r.direction === "worsening" ? "▼" : "—"} ${pace}`));
        const gc = globalBySlug.get(r.slug);
        if (gc) {
          const a = el("a", "case-row pulse-case", "Case →");
          a.href = caseHref(gc.id);
          a.dataset.case = gc.id;
          a.title = gc.title;
          li.appendChild(a);
        }
        ul.appendChild(li);
      }
      sec.appendChild(ul);
      box.appendChild(sec);
    }
  }
  function sparkline(pts: { t: string; v: number }[]): SVGSVGElement {
    const NS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", "0 0 100 28");
    svg.setAttribute("preserveAspectRatio", "none");
    svg.setAttribute("class", "spark");
    svg.setAttribute("aria-hidden", "true");
    const vs = pts.map((p) => p.v).filter(Number.isFinite);
    if (vs.length < 2) return svg;
    const lo = Math.min(...vs);
    const hi = Math.max(...vs);
    const d = vs.map((v, i) => `${i ? "L" : "M"}${((i / (vs.length - 1)) * 100).toFixed(2)},${(26 - ((v - lo) / (hi - lo || 1)) * 24).toFixed(2)}`).join("");
    const path = document.createElementNS(NS, "path");
    path.setAttribute("d", d);
    path.setAttribute("vector-effect", "non-scaling-stroke");
    svg.appendChild(path);
    return svg;
  }

  // ---- Metrics ------------------------------------------------------------------------------------------
  let metricsLoaded = false;
  async function loadMetrics(): Promise<void> {
    if (metricsLoaded) return;
    metricsLoaded = true;
    const box = document.getElementById("metrics");
    const m = await hub.metrics();
    if (!box || !m) return;
    box.replaceChildren(...metricsView(m));
  }
  const goCases = (patch: Partial<View>, bbox?: [number, number, number, number] | null) => {
    hub.touch();
    hub.set({ mode: "cases", open: false, metric: null, groups: [...GROUPS], topics: [...TOPICS], ...patch });
    if (bbox) hub.emit("fit", { bbox, maxZoom: 7 });
  };
  function metricsView(m: Metrics): Element[] {
    const out: Element[] = [];
    // Totals by status.
    const tot = el("div", "mx-totals");
    for (const g of GROUPS) {
      const b = el("button", `mx-tot mx-tot--${g}`);
      b.type = "button";
      b.append(el("b", "", String(m.totals.byGroup[g] ?? 0)), el("span", "", GROUP_LABEL[g]));
      b.addEventListener("click", () => goCases({ groups: [g] }));
      tot.appendChild(b);
    }
    out.push(tot);

    // What's at stake.
    if (m.stake.length) {
      out.push(el("h3", "pane-sub", "What’s at stake"));
      const ul = el("ul", "mx-stake");
      for (const s of m.stake) {
        const li = el("li");
        const b = el("button", "mx-metric");
        b.type = "button";
        b.append(el("span", "mx-k", s.label), el("b", "mx-v", s.display), el("span", "mx-x", s.explain), el("span", "mx-go", `${s.caseIds.length} case${s.caseIds.length === 1 ? "" : "s"} →`));
        b.addEventListener("click", () => {
          const ids = new Set(s.caseIds);
          goCases({ metric: s.key }, boundsOf((data?.cases ?? []).filter((c) => ids.has(c.id) && !isGlobal(c))));
        });
        li.appendChild(b);
        ul.appendChild(li);
      }
      out.push(ul);
    }
    out.push(el("p", "global-value", `For scale: nature does about $${m.nature.lowUsd / 1e12}–${m.nature.highUsd / 1e12} trillion worth of work for us every year (${m.nature.source}).`));

    // Cases over time (stacked bars).
    if (m.timeline.points.length) {
      out.push(el("h3", "pane-sub", `Cases opened · by ${m.timeline.bucket}`));
      out.push(timeline(m));
    }

    // By topic.
    const topics = TOPICS.filter((t) => (m.totals.byTopic[t] ?? 0) > 0);
    if (topics.length) {
      out.push(el("h3", "pane-sub", "By topic"));
      const max = Math.max(...topics.map((t) => m.totals.byTopic[t] ?? 0));
      const ul = el("ul", "mx-bars");
      for (const t of topics) {
        const n = m.totals.byTopic[t] ?? 0;
        const b = el("button", "mx-bar");
        b.type = "button";
        const fill = el("span", `mx-fill tp--${t}`);
        fill.style.width = `${Math.max(2, (n / max) * 100)}%`;
        b.append(el("span", `ring ring--${t}`), el("span", "mx-bl", TOPIC_LABEL[t]), el("span", "mx-track"), el("span", "mx-bn", String(n)));
        b.querySelector(".mx-track")!.appendChild(fill);
        b.addEventListener("click", () => (t === "trend" || t === "ice" ? (hub.touch(), hub.set({ mode: "planet" })) : goCases({ topics: [t] })));
        const li = el("li");
        li.appendChild(b);
        ul.appendChild(li);
      }
      out.push(ul);
    }

    // Top places.
    if (m.places.length) {
      out.push(el("h3", "pane-sub", "Places with the most cases"));
      const ul = el("ul", "mx-places");
      for (const p of m.places) {
        const b = el("button", "mx-place");
        b.type = "button";
        b.append(el("span", "", p.name), el("b", "", String(p.n)));
        b.addEventListener("click", () => {
          const ids = new Set(p.caseIds);
          goCases({}, boundsOf((data?.cases ?? []).filter((c) => ids.has(c.id))));
        });
        const li = el("li");
        li.appendChild(b);
        ul.appendChild(li);
      }
      out.push(ul);
    }

    // How often we were wrong.
    if (m.rules.length) {
      out.push(el("h3", "pane-sub", "How often we were wrong"));
      out.push(el("p", "pane-note", "False alarms among the cases we could settle, per kind of check. Open cases aren’t counted until they are settled."));
      const ul = el("ul", "mx-rules");
      for (const r of m.rules) {
        const li = el("li");
        li.append(el("span", "", r.label), el("b", "", r.rate === null ? "not settled yet" : `${Math.round(r.rate * 100)} % · ${r.falsePositives} of ${r.decided}`));
        ul.appendChild(li);
      }
      out.push(ul);
    }
    return out;
  }
  function timeline(m: Metrics): SVGSVGElement {
    const NS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(NS, "svg");
    const pts = m.timeline.points;
    const W = 320;
    const H = 72;
    const max = Math.max(1, ...pts.map((p) => p.published + p.checking + p.dropped));
    const bw = W / pts.length;
    svg.setAttribute("viewBox", `0 0 ${W} ${H + 14}`);
    svg.setAttribute("class", "mx-time");
    svg.setAttribute("role", "img");
    const total = pts.reduce((a, p) => a + p.published + p.checking + p.dropped, 0);
    svg.setAttribute("aria-label", `${total} cases between ${pts[0]!.t} and ${pts[pts.length - 1]!.t}, by ${m.timeline.bucket}`);
    pts.forEach((p, i) => {
      let y = H;
      for (const g of ["published", "checking", "dropped"] as const) {
        const h = (p[g] / max) * H;
        if (!h) continue;
        y -= h;
        const r = document.createElementNS(NS, "rect");
        r.setAttribute("x", (i * bw + bw * 0.12).toFixed(2));
        r.setAttribute("width", Math.max(1, bw * 0.76).toFixed(2));
        r.setAttribute("y", y.toFixed(2));
        r.setAttribute("height", h.toFixed(2));
        r.setAttribute("class", `bar bar--${g}`);
        const tt = document.createElementNS(NS, "title");
        tt.textContent = `${p.t}: ${p[g]} ${GROUP_LABEL[g].toLowerCase()}`;
        r.appendChild(tt);
        svg.appendChild(r);
      }
    });
    for (const [x, t, anchor] of [[0, pts[0]!.t, "start"], [W, pts[pts.length - 1]!.t, "end"]] as const) {
      const tx = document.createElementNS(NS, "text");
      tx.setAttribute("x", String(x));
      tx.setAttribute("y", String(H + 12));
      tx.setAttribute("text-anchor", anchor);
      tx.textContent = fmtDay(t);
      svg.appendChild(tx);
    }
    return svg;
  }

  // ---- About: the reply anchor --------------------------------------------------------------------
  const toChallenge = () => {
    hub.set({ mode: "about", open: false, panel: true });
    document.getElementById("challenge")?.scrollIntoView({ block: "start" });
  };
  if (location.hash === "#challenge") toChallenge();
  addEventListener("hashchange", () => location.hash === "#challenge" && toChallenge());

  // ---- Esc: innermost first ------------------------------------------------------------------------
  addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || e.defaultPrevented) return;
    const t = e.target as HTMLElement;
    if (t.closest?.(".xp-search")) return; // the search box closes its own list
    if (hub.get().open) {
      e.preventDefault();
      closeCase();
    }
  });

  // ---- wire up --------------------------------------------------------------------------------------
  let lastSel: string | null = null;
  hub.subscribe((v, prev, origin) => {
    if (origin === "camera") return;
    if (v.mode !== prev.mode || v.open !== prev.open) renderMode(v);
    if (v.panel !== prev.panel) renderFold(v);
    if (v.metric !== prev.metric) void renderMetricChip(v).then(() => renderList(hub.get()));
    else if (v.groups !== prev.groups || v.topics !== prev.topics || v.win !== prev.win || v.end !== prev.end) {
      limit = LIST_STEP;
      renderList(v);
    }
    renderFilters(v);
    if (v.sel !== lastSel) {
      lastSel = v.sel;
      markSel(v.sel);
    }
    void renderCase(v);
  });
  const v0 = hub.get();
  renderMode(v0);
  renderFold(v0);
  setSnap(phone.matches ? "half" : "half");
  void hub.data.then(async (d) => {
    if (!d) return;
    data = d;
    byId = new Map(d.cases.map((c) => [c.id, c]));
    buildFilters(d.cases);
    renderFilters(hub.get());
    await renderMetricChip(hub.get());
    renderList(hub.get());
    void renderCase(hub.get());
  });
  void renderCase(v0);
}
