// The interactive map on the public site — loaded lazily (a separate chunk with MapLibre) by
// web/src/site/main.ts once the reader touches the static world image or the page goes idle,
// then swapped in over that image without moving the layout.
//
// Keyless only: the shared zoom-dependent basemap (web/src/layers/basemap.ts — NASA GIBS daily
// true colour → EOX Sentinel-2 cloudless mosaic, OpenFreeMap names + roads; OpenFreeMap's own style
// if GIBS is down); per-case evidence overlays from GFW (forest alerts) and GIBS HLS (Sentinel-2/Landsat 30 m
// before/after). Every overlay is decoration: when a source fails, the map just shows less.
// Ledger text is public input — everything below is built with textContent, never innerHTML.

import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import "./explore.css";
import { el, reducedMotion } from "../../ui";
import { BASEMAP_LABELS_BELOW, basemapStyle, mountBasemapCaption } from "../../layers/basemap";
import {
  CASE_ID,
  DEFAULT_VIEW,
  EASE_IN_OUT,
  GROUP_LABEL,
  GROUPS,
  KIND_LABEL,
  KINDS,
  WINDOWS,
  dayOf,
  decodeView,
  encodeView,
  endMsOf,
  firstDay,
  isVisible,
  search,
  windowRange,
  windowStats,
  type Group,
  type Hit,
  type Kind,
  type MapCase,
  type MapData,
  type Overlay,
  type View,
  type Win,
} from "./model";

const GIBS = "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best";
const HLS = (day: string) => `${GIBS}/HLS_S30_Nadir_BRDF_Adjusted_Reflectance/default/${day}/GoogleMapsCompatible_Level12/{z}/{y}/{x}.png`;
const GFW = (from: string, to: string) =>
  `https://tiles.globalforestwatch.org/gfw_integrated_alerts/latest/dynamic/{z}/{x}/{y}.png?render_type=true_color&start_date=${from}&end_date=${to}`;
const FALLBACK_STYLE = "https://tiles.openfreemap.org/styles/dark";

const DAY_MS = 86_400_000;
const WIN_LABEL: Record<Win, string> = { 30: "30 d", 90: "90 d", 365: "1 yr", 0: "All" };
/** How close fly-to gets, per case type: fires stay coarse (the pin is a cluster centroid on purpose). */
const MAX_ZOOM: Record<Kind, number> = { forest: 11.5, fire: 7.5, flaring: 9, "flaring-stopped": 9, methane: 7, other: 9 };
const WORLD: Pick<View, "center" | "zoom" | "pitch" | "bearing"> = { center: [-20, 12], zoom: 1.2, pitch: 0, bearing: 0 };

const fmtDay = (iso: string) => {
  const d = new Date(iso.length === 10 ? `${iso}T00:00:00Z` : iso);
  return Number.isNaN(d.getTime()) ? iso.slice(0, 10) : d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
};
const shift = (iso: string, days: number) => dayOf(Date.parse(iso) + days * DAY_MS);

interface Options {
  figure: HTMLElement;
  data: MapData;
  /** Relative prefix from this page to the site root ("" landing, "../" cases index). */
  root: string;
}

export function mountExplorer({ figure, data, root }: Options): void {
  const cases = data.cases.filter((c) => CASE_ID.test(c.id) && Number.isFinite(c.lon) && Number.isFinite(c.lat));
  const byId = new Map(cases.map((c) => [c.id, c]));
  const restored = decodeView(location.hash);
  const view: View = { ...DEFAULT_VIEW, ...(restored ?? {}) };
  if (view.sel && !byId.has(view.sel)) view.sel = null;
  const latestDay = dayOf(Date.parse(data.generatedAt) || Date.now());
  const startDay = firstDay(cases) ?? latestDay;
  let touched = restored !== null; // no URL writes until the reader does something (or arrived by link)

  // ---- DOM shell ----------------------------------------------------------------------------------
  const xp = el("div", "xp");
  xp.tabIndex = 0;
  xp.setAttribute("role", "region");
  xp.setAttribute("aria-label", "Map of the cases. Arrow keys move between cases, Enter opens one, Escape closes.");
  const mapBox = el("div", "xp-map");
  const top = el("div", "xp-top");
  const card = el("div", "xp-card");
  card.hidden = true;
  const bar = el("div", "xp-time");
  const live = el("p", "sr-only");
  live.setAttribute("aria-live", "polite");
  xp.append(mapBox, top, card, bar, live);
  // In the page before MapLibre measures its container; the static image stays underneath.
  figure.classList.add("is-live");
  figure.appendChild(xp);

  let map: maplibregl.Map;
  try {
    map = new maplibregl.Map({
      container: mapBox,
      style: { ...basemapStyle(), sky: { "atmosphere-blend": ["interpolate", ["linear"], ["zoom"], 0, 0.9, 4, 0.5, 7, 0] } },
      center: view.center,
      zoom: view.zoom,
      pitch: view.pitch,
      bearing: view.bearing,
      maxPitch: 60,
      keyboard: false, // arrows cycle cases instead (see onKey)
      attributionControl: { compact: true },
      fadeDuration: 150,
    });
  } catch {
    xp.remove(); // no WebGL: the static image and its pins stay
    figure.classList.remove("is-live");
    return;
  }
  map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "bottom-right");
  const caption = mountBasemapCaption(map);

  // Basemap fallback: GIBS failing before any tile arrives → OpenFreeMap (keyless vector).
  let baseLoaded = false;
  let baseErrors = 0;
  let fellBack = false;
  map.on("sourcedata", (e) => {
    if (e.sourceId === "bm-gibs" && e.isSourceLoaded) baseLoaded = true;
  });
  map.on("error", (e) => {
    const src = (e as unknown as { sourceId?: string }).sourceId;
    if (src === "bm-gibs" && !baseLoaded && !fellBack && ++baseErrors >= 4) {
      fellBack = true;
      map.removeControl(caption); // the fallback style is a drawn map, not imagery
      map.setStyle(FALLBACK_STYLE);
      map.once("style.load", () => {
        try {
          map.setProjection({ type: "globe" });
        } catch {
          /* mercator is fine */
        }
        drawOverlays();
      });
    }
  });

  // ---- markers --------------------------------------------------------------------------------------
  const markers = new Map<string, { m: maplibregl.Marker; b: HTMLButtonElement }>();
  for (const c of [...cases].reverse()) {
    const wrap = el("div", "mk");
    const b = el("button", `mk-b mk--${c.group} status--${c.status.replace(/[^a-z_]/g, "")}`);
    b.type = "button";
    b.tabIndex = -1;
    b.setAttribute("aria-label", `${c.statusLabel}: ${c.title}`);
    b.dataset.case = c.id;
    b.append(el("span", "mk-dot"), el("span", "mk-tip", c.title.length > 64 ? `${c.title.slice(0, 63)}…` : c.title));
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      touched = true;
      select(c.id, true);
    });
    // Hover is a mouse thing: on touch the tap selects, and nothing sticks "hot".
    b.addEventListener("pointerenter", (e) => e.pointerType === "mouse" && hot(c.id, true));
    b.addEventListener("pointerleave", () => hot(c.id, false));
    wrap.appendChild(b);
    const m = new maplibregl.Marker({ element: wrap, anchor: "center" }).setLngLat([c.lon, c.lat]).addTo(map);
    markers.set(c.id, { m, b });
  }

  // The list on the page and the map light each other up.
  const linked = () => [...document.querySelectorAll<HTMLElement>(".case-row[data-case], .mk-b[data-case]")];
  function hot(id: string, on: boolean): void {
    for (const n of linked()) if (n.dataset.case === id) n.classList.toggle("is-hot", on);
  }
  for (const row of document.querySelectorAll<HTMLElement>(".case-row[data-case]")) {
    const id = row.dataset.case!;
    row.addEventListener("pointerenter", () => hot(id, true));
    row.addEventListener("pointerleave", () => hot(id, false));
  }

  // ---- filter + stats ---------------------------------------------------------------------------------
  const endMs = () => endMsOf(view, data.generatedAt);
  const visibleCases = () => cases.filter((c) => isVisible(c, view, endMs()));

  const statNodes = [...document.querySelectorAll<HTMLElement>("[data-stat]")].map((n) => ({
    n,
    v: n.querySelector<HTMLElement>("dd, b"),
    k: n.querySelector<HTMLElement>("dt, .stat-k"),
    html: n.querySelector<HTMLElement>("dd, b")?.innerHTML ?? "",
    label: n.querySelector<HTMLElement>("dt, .stat-k")?.textContent ?? "",
  }));

  function applyFilter(): void {
    const e = endMs();
    const vis = new Set(visibleCases().map((c) => c.id));
    for (const [id, { b }] of markers) {
      const on = vis.has(id);
      b.classList.toggle("is-out", !on);
      b.setAttribute("aria-hidden", String(!on));
    }
    for (const row of document.querySelectorAll<HTMLElement>(".case-row[data-case]")) row.classList.toggle("is-dim", byId.has(row.dataset.case!) && !vis.has(row.dataset.case!));
    // Stats strip: whole ledger when "All up to latest", else the window.
    const whole = view.win === 0 && view.end === null;
    const st = windowStats(cases, view.win, e);
    const [start] = windowRange(view.win, e);
    const suffix = whole ? "" : view.win ? ` · ${fmtDay(dayOf(start! + 1))} – ${fmtDay(dayOf(e))}` : ` · to ${fmtDay(dayOf(e))}`;
    for (const s of statNodes) {
      if (!s.v) continue;
      if (whole) s.v.innerHTML = s.html; // our own server-rendered markup, restored verbatim
      else if (s.n.dataset.stat === "published") s.v.textContent = String(st.published);
      else if (s.n.dataset.stat === "all") s.v.textContent = String(st.total);
      else if (s.n.dataset.stat === "fp") {
        s.v.textContent = String(st.falsePositives);
        if (st.decided) s.v.append(el("span", "num-of", ` of ${st.decided}`));
      }
      // Tiles (<dt>) name the dates; the compact ledger strip just says "in window" (the map shows the dates).
      if (s.k) s.k.textContent = whole ? s.label : s.k.tagName === "DT" ? `${s.label}${suffix}` : s.n.dataset.stat === "all" ? "in window" : `${s.label} in window`;
    }
    timeLabel.textContent = `${view.win ? `${fmtDay(dayOf(windowRange(view.win, e)[0]! + 1))} – ` : "Up to "}${fmtDay(dayOf(e))} · ${vis.size} case${vis.size === 1 ? "" : "s"}`;
    if (view.sel && !vis.has(view.sel)) closeCard(false);
    syncUrl();
  }

  // ---- URL (a link is a handoff) ---------------------------------------------------------------------
  let urlTimer = 0;
  function syncUrl(): void {
    if (!touched) return;
    clearTimeout(urlTimer);
    urlTimer = window.setTimeout(() => {
      const c = map.getCenter();
      Object.assign(view, { center: [c.lng, c.lat], zoom: map.getZoom(), pitch: map.getPitch(), bearing: map.getBearing() });
      history.replaceState(null, "", `${location.pathname}${location.search}${encodeView(context ? context.saved : view)}`);
    }, 300);
  }
  map.on("moveend", syncUrl);
  for (const ev of ["pointerdown", "wheel", "keydown"] as const) xp.addEventListener(ev, () => (touched = true), { passive: true });

  // ---- toolbar: search · layers · whole Earth · copy link -------------------------------------------------
  const searchBox = el("div", "xp-search");
  const input = el("input", "xp-input");
  input.type = "search";
  input.placeholder = "Search a place or lat, lon";
  if (matchMedia("(max-width: 899px)").matches) input.placeholder = "Search places";
  input.setAttribute("aria-label", "Search watched places, cases or coordinates");
  input.setAttribute("role", "combobox");
  input.setAttribute("aria-expanded", "false");
  input.setAttribute("aria-autocomplete", "list");
  input.autocomplete = "off";
  input.spellcheck = false;
  const results = el("ul", "xp-results");
  results.id = `xp-results-${Math.random().toString(36).slice(2, 8)}`;
  results.setAttribute("role", "listbox");
  results.hidden = true;
  input.setAttribute("aria-controls", results.id);
  searchBox.append(input, results);

  let hits: Hit[] = [];
  let active = -1;
  function renderHits(): void {
    results.replaceChildren();
    hits.forEach((h, i) => {
      const li = el("li", `xp-hit${i === active ? " is-active" : ""}`);
      li.setAttribute("role", "option");
      li.id = `${results.id}-${i}`;
      li.setAttribute("aria-selected", String(i === active));
      li.append(el("span", "xp-hit-l", h.label), el("span", "xp-hit-s", h.sub));
      li.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        go(h);
      });
      results.appendChild(li);
    });
    if (input.value.trim().length >= 2 && !hits.length) results.appendChild(el("li", "xp-hit xp-hit--none", "No watched place or case by that name"));
    results.hidden = input.value.trim().length < 2;
    input.setAttribute("aria-expanded", String(!results.hidden));
    if (active >= 0) input.setAttribute("aria-activedescendant", `${results.id}-${active}`);
    else input.removeAttribute("aria-activedescendant");
  }
  function go(h: Hit): void {
    touched = true;
    input.value = h.label;
    results.hidden = true;
    input.setAttribute("aria-expanded", "false");
    if (h.kind === "case" && h.id) return select(h.id, true);
    if (h.bbox) fly({ bbox: h.bbox, maxZoom: 9 });
    else fly({ center: [h.lon, h.lat], zoom: 8 });
    announce(`Moved to ${h.label}`);
  }
  input.addEventListener("input", () => {
    hits = search(input.value, data.places, cases);
    active = hits.length ? 0 : -1;
    renderHits();
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!hits.length) return;
      active = (active + (e.key === "ArrowDown" ? 1 : hits.length - 1)) % hits.length;
      renderHits();
    } else if (e.key === "Enter") {
      e.preventDefault();
      const h = hits[active] ?? hits[0];
      if (h) go(h);
    } else if (e.key === "Escape") {
      e.stopPropagation();
      if (!results.hidden) {
        results.hidden = true;
        input.setAttribute("aria-expanded", "false");
      } else xp.focus();
    }
  });
  input.addEventListener("blur", () => {
    results.hidden = true;
    input.setAttribute("aria-expanded", "false");
  });

  const btn = (cls: string, label: string, title: string) => {
    const b = el("button", `xp-btn ${cls}`, label);
    b.type = "button";
    b.title = title;
    return b;
  };
  const layersBtn = btn("xp-btn--layers", "Layers", "Which cases the map shows");
  layersBtn.setAttribute("aria-expanded", "false");
  const panel = el("div", "xp-panel");
  panel.id = `${results.id}-layers`;
  panel.hidden = true;
  layersBtn.setAttribute("aria-controls", panel.id);
  const worldBtn = btn("xp-btn--world", "Whole Earth", "All cases, whole planet — press again to go back");
  worldBtn.setAttribute("aria-pressed", "false");
  const shareBtn = btn("xp-btn--share", "Copy link", "Copy a link to exactly this view");
  const tools = el("div", "xp-tools");
  tools.append(layersBtn, worldBtn, shareBtn);
  top.append(searchBox, tools, panel);

  // Layer toggles: status groups, then case types. Counts are per whole ledger, not the window.
  const toggles = new Map<string, HTMLInputElement>();
  const fieldset = (legend: string, items: [string, string, number][], on: (k: string) => boolean, set: (k: string, v: boolean) => void) => {
    const fs = el("fieldset", "xp-fs");
    fs.appendChild(el("legend", "xp-legend", legend));
    for (const [key, label, n] of items) {
      const lab = el("label", `xp-check xp-check--${key}`);
      const cb = el("input");
      cb.type = "checkbox";
      cb.checked = on(key);
      cb.addEventListener("change", () => {
        touched = true;
        set(key, cb.checked);
        applyFilter();
      });
      toggles.set(key, cb);
      lab.append(cb, el("span", "xp-swatch"), el("span", "xp-check-l", label), el("span", "xp-check-n", String(n)));
      fs.appendChild(lab);
    }
    return fs;
  };
  const count = (f: (c: MapCase) => boolean) => cases.filter(f).length;
  const toggleIn = <T extends string>(list: T[], k: T, v: boolean, order: readonly T[]) => order.filter((x) => (x === k ? v : list.includes(x)));
  panel.append(
    fieldset(
      "Status",
      GROUPS.map((g) => [g, GROUP_LABEL[g], count((c) => c.group === g)]),
      (k) => view.groups.includes(k as Group),
      (k, v) => (view.groups = toggleIn(view.groups, k as Group, v, GROUPS)),
    ),
    fieldset(
      "Case type",
      KINDS.filter((k) => k !== "other" || cases.some((c) => c.kind === "other")).map((k) => [k, KIND_LABEL[k], count((c) => c.kind === k)]),
      (k) => view.kinds.includes(k as Kind),
      (k, v) => (view.kinds = toggleIn(view.kinds, k as Kind, v, KINDS)),
    ),
  );
  const syncToggles = () => {
    for (const [k, cb] of toggles) cb.checked = (GROUPS as readonly string[]).includes(k) ? view.groups.includes(k as Group) : view.kinds.includes(k as Kind);
  };
  const setPanel = (open: boolean) => {
    panel.hidden = !open;
    layersBtn.setAttribute("aria-expanded", String(open));
  };
  layersBtn.addEventListener("click", () => setPanel(panel.hidden !== false));

  let copyTimer = 0;
  shareBtn.addEventListener("click", () => {
    touched = true;
    const c = map.getCenter();
    Object.assign(view, { center: [c.lng, c.lat], zoom: map.getZoom(), pitch: map.getPitch(), bearing: map.getBearing() });
    const url = `${location.origin}${location.pathname}${location.search}${encodeView(context ? context.saved : view)}`;
    history.replaceState(null, "", url);
    void navigator.clipboard?.writeText(url).then(
      () => {
        shareBtn.textContent = "Copied";
        clearTimeout(copyTimer);
        copyTimer = window.setTimeout(() => (shareBtn.textContent = "Copy link"), 1400);
      },
      () => (shareBtn.textContent = "Copy failed"),
    );
  });

  // Global context: whole planet, every layer, all time — then back to exactly where you were.
  let context: { saved: View } | null = null;
  function enterContext(): void {
    const c = map.getCenter();
    const saved: View = { ...view, center: [c.lng, c.lat], zoom: map.getZoom(), pitch: map.getPitch(), bearing: map.getBearing(), groups: [...view.groups], kinds: [...view.kinds], overlays: [...view.overlays] };
    context = { saved };
    closeCard(false);
    Object.assign(view, { groups: [...GROUPS], kinds: [...KINDS], win: 0 as Win, end: null });
    worldBtn.setAttribute("aria-pressed", "true");
    worldBtn.textContent = "Back";
    syncToggles();
    syncTime();
    applyFilter();
    fly({ ...WORLD });
    announce(`Whole Earth: all ${cases.length} cases`);
  }
  function exitContext(): void {
    if (!context) return;
    const s = context.saved;
    context = null;
    Object.assign(view, { groups: s.groups, kinds: s.kinds, win: s.win, end: s.end, overlays: s.overlays });
    worldBtn.setAttribute("aria-pressed", "false");
    worldBtn.textContent = "Whole Earth";
    syncToggles();
    syncTime();
    applyFilter();
    fly({ center: s.center, zoom: s.zoom, pitch: s.pitch, bearing: s.bearing });
    if (s.sel) select(s.sel, false);
  }
  worldBtn.addEventListener("click", () => {
    touched = true;
    if (context) exitContext();
    else enterContext();
  });

  // ---- time: window · scrubber · replay ----------------------------------------------------------------
  const seg = el("div", "xp-seg");
  seg.setAttribute("role", "radiogroup");
  seg.setAttribute("aria-label", "Time window");
  const segBtns = WINDOWS.map((w) => {
    const b = el("button", "xp-seg-b", WIN_LABEL[w]);
    b.type = "button";
    b.setAttribute("role", "radio");
    b.addEventListener("click", () => {
      touched = true;
      stopReplay();
      view.win = w;
      syncTime();
      applyFilter();
    });
    seg.appendChild(b);
    return [w, b] as const;
  });
  const span = Math.max(1, Math.round((Date.parse(latestDay) - Date.parse(startDay)) / DAY_MS));
  const range = el("input", "xp-range");
  range.type = "range";
  range.min = "0";
  range.max = String(span);
  range.step = "1";
  range.setAttribute("aria-label", "Show cases seen up to this day");
  const dayAt = (i: number) => shift(startDay, i);
  range.addEventListener("input", () => {
    touched = true;
    stopReplay();
    const i = Number(range.value);
    view.end = i >= span ? null : dayAt(i);
    range.setAttribute("aria-valuetext", fmtDay(view.end ?? latestDay));
    applyFilter();
  });
  const replayBtn = btn("xp-btn--replay", "Replay", "Play the cases in the order they were seen");
  const timeLabel = el("span", "xp-time-l");
  bar.append(seg, range, replayBtn, timeLabel);
  function syncTime(): void {
    for (const [w, b] of segBtns) b.setAttribute("aria-checked", String(view.win === w));
    const i = view.end ? Math.round((Date.parse(view.end) - Date.parse(startDay)) / DAY_MS) : span;
    range.value = String(Math.max(0, Math.min(span, i)));
    range.setAttribute("aria-valuetext", fmtDay(view.end ?? latestDay));
  }

  let replay = 0;
  function stopReplay(): void {
    if (!replay) return;
    cancelAnimationFrame(replay);
    replay = 0;
    replayBtn.textContent = "Replay";
  }
  replayBtn.addEventListener("click", () => {
    touched = true;
    if (replay) return stopReplay();
    // Linear on purpose: it is time passing, not an object moving. ~6 s whatever the span.
    const from = view.win ? Math.min(span, Math.round(view.win / 2)) : 0;
    const t0 = performance.now();
    const dur = 6000;
    replayBtn.textContent = "Pause";
    const step = (now: number) => {
      const k = Math.min(1, (now - t0) / dur);
      const i = Math.round(from + (span - from) * k);
      view.end = i >= span ? null : dayAt(i);
      syncTime();
      applyFilter();
      if (k < 1) replay = requestAnimationFrame(step);
      else stopReplay();
    };
    replay = requestAnimationFrame(step);
  });

  // ---- selection card + evidence overlays -------------------------------------------------------------------
  function announce(t: string): void {
    live.textContent = t;
  }

  function fly(t: { bbox?: [number, number, number, number]; maxZoom?: number; center?: [number, number]; zoom?: number; pitch?: number; bearing?: number }): void {
    const duration = reducedMotion() ? 0 : 1400; // camera travel, not UI: long enough to keep your bearings
    const narrow = xp.clientWidth < 640;
    const padding = narrow ? { top: 64, bottom: card.hidden ? 72 : 200, left: 24, right: 24 } : { top: 64, bottom: 72, left: card.hidden ? 48 : 340, right: 56 };
    if (t.bbox) {
      const [w, s, e, n] = t.bbox;
      map.fitBounds(
        [
          [w, s],
          [e, n],
        ],
        { padding, maxZoom: t.maxZoom ?? 9, duration, easing: EASE_IN_OUT, pitch: map.getPitch(), bearing: map.getBearing() },
      );
    } else {
      // Only the fields we mean to change: an explicit `undefined` pitch breaks the globe transform.
      const o: maplibregl.FlyToOptions = { center: t.center ?? map.getCenter(), duration, easing: EASE_IN_OUT };
      if (t.zoom !== undefined) o.zoom = t.zoom;
      if (t.pitch !== undefined) o.pitch = t.pitch;
      if (t.bearing !== undefined) o.bearing = t.bearing;
      map.flyTo(o);
    }
  }

  function select(id: string, move: boolean): void {
    const c = byId.get(id);
    if (!c) return;
    if (view.sel && view.sel !== id) markers.get(view.sel)?.b.classList.remove("is-sel");
    view.sel = id;
    markers.get(id)?.b.classList.add("is-sel");
    for (const row of document.querySelectorAll<HTMLElement>(".case-row[data-case]")) row.classList.toggle("is-sel", row.dataset.case === id);
    renderCard(c);
    drawOverlays();
    if (move) fly({ bbox: c.bbox, maxZoom: MAX_ZOOM[c.kind] });
    announce(`${c.statusLabel}: ${c.title}. Press Enter to open the case.`);
    syncUrl();
  }

  function closeCard(refocus: boolean): void {
    if (view.sel) markers.get(view.sel)?.b.classList.remove("is-sel");
    for (const row of document.querySelectorAll<HTMLElement>(".case-row.is-sel")) row.classList.remove("is-sel");
    view.sel = null;
    card.hidden = true;
    drawOverlays();
    if (refocus) xp.focus();
    syncUrl();
  }

  const caseHref = (c: MapCase) => `${root}watch/case/${encodeURIComponent(c.id)}/`;

  function renderCard(c: MapCase): void {
    card.replaceChildren();
    const x = el("button", "xp-close", "×");
    x.type = "button";
    x.setAttribute("aria-label", "Close");
    x.addEventListener("click", () => closeCard(true));
    const badge = el("span", `status-badge status--${c.status.replace(/[^a-z_]/g, "")}`);
    badge.append(el("span", "status-dot"), document.createTextNode(c.statusLabel));
    const head = el("div", "xp-card-top");
    head.append(badge, el("span", "xp-card-when", `seen ${fmtDay(c.observedAt)}`), x);
    const h = el("h3", "xp-card-h", c.title);
    card.append(head, h);
    if (c.meta) card.appendChild(el("p", "xp-card-meta", c.meta));
    if (c.kind === "fire") card.appendChild(el("p", "xp-card-note", "Shown as the middle of the fire cluster, on purpose: exact detections in Indigenous land are not pinned."));

    // Evidence overlays for this case — each one may simply come up empty.
    const opts: [Overlay, string, string][] = [];
    if (c.kind === "forest") opts.push(["alerts", "Forest alerts", "Global Forest Watch integrated alerts around the case dates"]);
    if (c.kind !== "fire" && c.kind !== "methane") opts.push(["imagery", "Satellite before / after", "Sentinel-2 / Landsat 30 m images (NASA HLS) from before and after — clouds happen"]);
    if (opts.length) {
      const ov = el("div", "xp-ov");
      for (const [k, label, title] of opts) {
        const b = el("button", "xp-chip", label);
        b.type = "button";
        b.title = title;
        b.setAttribute("aria-pressed", String(view.overlays.includes(k)));
        b.addEventListener("click", () => {
          touched = true;
          const on = !view.overlays.includes(k);
          view.overlays = (["alerts", "imagery"] as Overlay[]).filter((o) => (o === k ? on : view.overlays.includes(o)));
          b.setAttribute("aria-pressed", String(on));
          fade.hidden = !(view.overlays.includes("imagery") && opts.some(([o]) => o === "imagery"));
          drawOverlays();
          syncUrl();
        });
        ov.appendChild(b);
      }
      card.appendChild(ov);
    }
    const [before, after] = imageryDays(c);
    const fade = el("label", "xp-fade");
    fade.hidden = !(view.overlays.includes("imagery") && opts.some(([o]) => o === "imagery"));
    const fr = el("input", "xp-range xp-range--fade");
    fr.type = "range";
    fr.min = "0";
    fr.max = "100";
    fr.value = String(Math.round(afterOpacity * 100));
    fr.setAttribute("aria-label", "Blend from the before image to the after image");
    fr.addEventListener("input", () => {
      afterOpacity = Number(fr.value) / 100;
      for (const id of hlsAfterIds) if (map.getLayer(id)) map.setPaintProperty(id, "raster-opacity", afterOpacity);
    });
    fade.append(el("span", "xp-fade-l", `Before · ${fmtDay(before[0]!)}`), fr, el("span", "xp-fade-l", `After · ${fmtDay(after[0]!)}`));
    card.appendChild(fade);

    const open = el("a", "xp-open", "Open case →");
    open.href = caseHref(c);
    card.appendChild(open);
    card.hidden = false;
  }

  /** HLS days: the "after" stack ends on the observation day, the "before" stack a month before first evidence. */
  function imageryDays(c: MapCase): [string[], string[]] {
    const obs = c.observedAt.slice(0, 10);
    const first = c.firstSeen.slice(0, 10);
    const stack = (end: string) => [0, 2, 4, 6, 8, 10].map((d) => shift(end, -d));
    return [stack(shift(first < obs ? first : obs, -30)), stack(obs)];
  }

  let afterOpacity = 1;
  let hlsAfterIds: string[] = [];
  const ovLayers: string[] = [];
  function clearOverlays(): void {
    for (const id of ovLayers.splice(0)) {
      if (map.getLayer(id)) map.removeLayer(id);
      if (map.getSource(id)) map.removeSource(id);
    }
    hlsAfterIds = [];
  }
  function addRaster(id: string, tiles: string, bounds: [number, number, number, number], maxzoom: number, opacity: number, attribution: string): void {
    if (!map.getStyle()) return;
    map.addSource(id, { type: "raster", tiles: [tiles], tileSize: 256, minzoom: 5, maxzoom, bounds, attribution });
    map.addLayer({ id, type: "raster", source: id, minzoom: 5, paint: { "raster-opacity": opacity, "raster-fade-duration": 200 } }, map.getLayer(BASEMAP_LABELS_BELOW) ? BASEMAP_LABELS_BELOW : undefined);
    ovLayers.push(id);
  }
  function drawOverlays(): void {
    if (!map.isStyleLoaded()) {
      map.once("idle", drawOverlays);
      return;
    }
    clearOverlays();
    const c = view.sel ? byId.get(view.sel) : undefined;
    if (!c) return;
    const [w, s, e, n] = c.bbox;
    const pad = Math.max(0.05, (e - w) * 1.5, (n - s) * 1.5);
    const bounds: [number, number, number, number] = [Math.max(-180, w - pad), Math.max(-85, s - pad), Math.min(180, e + pad), Math.min(85, n + pad)];
    try {
      if (view.overlays.includes("imagery") && c.kind !== "fire" && c.kind !== "methane") {
        const [before, after] = imageryDays(c);
        // Oldest first so the newest day paints on top; empty days are transparent.
        [...before].reverse().forEach((d, i) => addRaster(`hls-b-${i}`, HLS(d), bounds, 12, 1, "NASA HLS (Sentinel-2 / Landsat) via GIBS"));
        [...after].reverse().forEach((d, i) => {
          addRaster(`hls-a-${i}`, HLS(d), bounds, 12, afterOpacity, "NASA HLS (Sentinel-2 / Landsat) via GIBS");
          hlsAfterIds.push(`hls-a-${i}`);
        });
      }
      if (view.overlays.includes("alerts") && c.kind === "forest") {
        const from = shift(c.firstSeen.slice(0, 10), -90);
        const to = dayOf(Date.parse(data.generatedAt) || Date.now());
        addRaster("gfw", GFW(from, to), bounds, 12, 0.9, "Global Forest Watch integrated alerts (CC BY 4.0)");
      }
      // The case's own outline (and public registry points), always on for the selection.
      const feats: GeoJSON.Feature[] = [{ type: "Feature", geometry: c.geometry as GeoJSON.Geometry, properties: {} }];
      for (const p of c.points ?? []) feats.push({ type: "Feature", geometry: { type: "Point", coordinates: p }, properties: { site: 1 } });
      map.addSource("sel", { type: "geojson", data: { type: "FeatureCollection", features: feats } });
      map.addLayer({ id: "sel-fill", type: "fill", source: "sel", filter: ["==", ["geometry-type"], "Polygon"], paint: { "fill-color": "#ff9f5a", "fill-opacity": 0.12 } });
      map.addLayer({ id: "sel-line", type: "line", source: "sel", filter: ["==", ["geometry-type"], "Polygon"], paint: { "line-color": "#ff9f5a", "line-width": 1.5 } });
      map.addLayer({ id: "sel-pts", type: "circle", source: "sel", filter: ["==", ["get", "site"], 1], paint: { "circle-radius": 4, "circle-color": "#4ade9b", "circle-stroke-color": "#07090d", "circle-stroke-width": 1 } });
      ovLayers.push("sel-fill", "sel-line", "sel-pts", "sel");
    } catch {
      /* an overlay that can't be added is an overlay not shown */
    }
  }

  // ---- keyboard -------------------------------------------------------------------------------------------
  xp.addEventListener("keydown", (e) => {
    const t = e.target as HTMLElement;
    if (e.key === "Escape") {
      if (!panel.hidden) {
        setPanel(false);
        layersBtn.focus();
      } else if (!card.hidden) closeCard(true);
      else if (context) exitContext();
      else return;
      e.preventDefault();
      return;
    }
    if (t !== xp && !t.classList.contains("maplibregl-canvas")) return; // inputs, sliders and buttons keep their keys
    if (["ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp"].includes(e.key)) {
      e.preventDefault();
      const vis = visibleCases();
      if (!vis.length) return announce("No cases in this view — widen the time window or switch layers on.");
      const i = vis.findIndex((c) => c.id === view.sel);
      const fwd = e.key === "ArrowRight" || e.key === "ArrowDown";
      const next = vis[i < 0 ? (fwd ? 0 : vis.length - 1) : (i + (fwd ? 1 : vis.length - 1)) % vis.length]!;
      select(next.id, true);
    } else if (e.key === "Enter" && view.sel) {
      const c = byId.get(view.sel);
      if (c) location.href = caseHref(c);
    }
  });
  document.addEventListener("pointerdown", (e) => {
    if (!panel.hidden && !panel.contains(e.target as Node) && e.target !== layersBtn) setPanel(false);
  });
  map.on("click", () => {
    if (!card.hidden) closeCard(false);
  });

  // ---- go --------------------------------------------------------------------------------------------------
  syncTime();
  applyFilter();
  if (view.sel) select(view.sel, !restored?.center);
}
