// Hand-rolled SVG time-series chart for `series` cards — no charting dependency.
// Built entirely from DOM nodes/textContent (payload values originate from upstream APIs).

export interface SeriesData {
  label: string;
  unit: string;
  points: Array<{ t: string; v: number | null }>;
}

const W = 320;
const H = 150;
const PAD = { top: 10, right: 10, bottom: 20, left: 38 };
const SVG_NS = "http://www.w3.org/2000/svg";
let uid = 0;

function svgEl<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string>): SVGElementTagNameMap[K] {
  const e = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
}

/** Epoch ms for an ISO date / YYYY-MM / YYYY / hourly stamp; NaN-safe enough for plotting. */
function timeOf(t: string): number {
  const full = t.length === 7 ? `${t}-15` : t.length === 4 ? `${t}-07-01` : t;
  const ms = Date.parse(full.includes("T") ? full : `${full}T00:00:00Z`);
  return Number.isFinite(ms) ? ms : 0;
}

function fmtValue(v: number, step = 0): string {
  const a = Math.abs(v);
  if (step >= 1 || a >= 1000) return Math.round(v).toLocaleString("en-US");
  if (step >= 0.1 || a >= 10) return v.toFixed(1);
  return v.toFixed(2);
}

/** 1/2/5 × 10^n tick step for roughly `count` intervals over `span`. */
function niceStep(span: number, count: number): number {
  const raw = span / Math.max(1, count);
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  return (norm >= 5 ? 10 : norm >= 2 ? 5 : norm >= 1 ? 2 : 1) * mag;
}

const DAY = 86_400_000;
function fmtTime(ms: number, spanMs: number): string {
  const iso = new Date(ms).toISOString();
  if (spanMs > 3 * 365 * DAY) return iso.slice(0, 4);
  if (spanMs > 90 * DAY) return iso.slice(0, 7);
  return iso.slice(0, 10);
}

interface Pt {
  t: number;
  v: number;
  raw: string;
}

/**
 * Render up to 3 series as an SVG line chart: nice-tick gridlines + y labels, first/mid/last
 * x labels, dashed threshold lines, an end-point marker, a legend with the latest value, and
 * a crosshair tooltip on hover (pointer only — the chart reads fine without it).
 */
export function renderChart(seriesArr: SeriesData[], thresholds: number[] = []): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "chart";
  const lines = seriesArr.slice(0, 3).filter((s) => Array.isArray(s.points) && s.points.length > 0);
  if (lines.length === 0) return wrap;

  const pts: Pt[][] = lines.map((s) =>
    s.points
      .filter((p) => p.v !== null && Number.isFinite(p.v))
      .map((p) => ({ t: timeOf(p.t), v: p.v as number, raw: p.t }))
      .sort((a, b) => a.t - b.t),
  );

  let tMin = Infinity;
  let tMax = -Infinity;
  let vMin = Infinity;
  let vMax = -Infinity;
  for (const s of pts)
    for (const p of s) {
      tMin = Math.min(tMin, p.t);
      tMax = Math.max(tMax, p.t);
      vMin = Math.min(vMin, p.v);
      vMax = Math.max(vMax, p.v);
    }
  for (const th of thresholds) {
    vMin = Math.min(vMin, th);
    vMax = Math.max(vMax, th);
  }
  if (!Number.isFinite(vMin) || !Number.isFinite(vMax) || !Number.isFinite(tMin)) return wrap;
  if (vMax === vMin) {
    vMax += 1;
    vMin -= 1;
  }
  // Snap the y-domain to nice ticks so gridlines land on round numbers.
  const step = niceStep(vMax - vMin, 4);
  vMin = Math.floor(vMin / step) * step;
  vMax = Math.ceil(vMax / step) * step;
  const spanT = Math.max(1, tMax - tMin);
  const spanV = vMax - vMin;
  const x = (t: number) => PAD.left + ((t - tMin) / spanT) * (W - PAD.left - PAD.right);
  const y = (v: number) => H - PAD.bottom - ((v - vMin) / spanV) * (H - PAD.top - PAD.bottom);

  // Legend first (reads as the chart's header): series label, latest value + unit.
  const legend = document.createElement("div");
  legend.className = "chart-legend";
  lines.forEach((s, i) => {
    const last = pts[i]![pts[i]!.length - 1];
    const item = document.createElement("span");
    item.className = "chart-key";
    const sw = document.createElement("span");
    sw.className = `chart-swatch chart-c${i + 1}`;
    const name = document.createElement("span");
    name.textContent = s.label;
    item.append(sw, name);
    if (last) {
      const val = document.createElement("span");
      val.className = "chart-key-v";
      val.textContent = `${fmtValue(last.v)}${s.unit ? ` ${s.unit}` : ""}`;
      item.appendChild(val);
    }
    legend.appendChild(item);
  });
  wrap.appendChild(legend);

  const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, class: "chart-svg", role: "img" });
  const title = svgEl("title", {});
  title.textContent = lines.map((s) => `${s.label} (${s.unit})`).join(", ");
  svg.appendChild(title);

  // Gridlines + y tick labels.
  for (let v = vMin; v <= vMax + step / 2; v += step) {
    const yy = y(v).toFixed(1);
    svg.appendChild(svgEl("line", { x1: String(PAD.left), x2: String(W - PAD.right), y1: yy, y2: yy, class: Math.abs(v) < step / 1e3 ? "chart-grid chart-grid--zero" : "chart-grid" }));
    const t = svgEl("text", { x: String(PAD.left - 6), y: String(y(v) + 3), class: "chart-label", "text-anchor": "end" });
    t.textContent = fmtValue(Math.abs(v) < step / 1e3 ? 0 : v, step);
    svg.appendChild(t);
  }

  // X labels: first / middle / last.
  const xl = (t: number, anchor: string) => {
    const e = svgEl("text", { x: String(x(t)), y: String(H - 5), class: "chart-label", "text-anchor": anchor });
    e.textContent = fmtTime(t, spanT);
    svg.appendChild(e);
  };
  xl(tMin, "start");
  if (spanT > 60 * DAY) xl(tMin + spanT / 2, "middle");
  xl(tMax, "end");

  // Threshold lines (e.g. ±0.5 ONI, 1.5 °C) — dashed, behind the data, labelled at the right.
  for (const th of thresholds) {
    const yy = y(th).toFixed(1);
    svg.appendChild(svgEl("line", { x1: String(PAD.left), x2: String(W - PAD.right), y1: yy, y2: yy, class: "chart-threshold" }));
  }

  // Area wash under the primary series (subtle; helps the eye read level, not decoration).
  const gid = `cg${++uid}`;
  const defs = svgEl("defs", {});
  const grad = svgEl("linearGradient", { id: gid, x1: "0", x2: "0", y1: "0", y2: "1" });
  grad.append(svgEl("stop", { offset: "0", class: "chart-wash-top" }), svgEl("stop", { offset: "1", class: "chart-wash-bottom" }));
  defs.appendChild(grad);
  svg.appendChild(defs);

  pts.forEach((s, i) => {
    // Break the path at null gaps in the ORIGINAL series (filtered points lose the gaps).
    let d = "";
    let pen = false;
    for (const p of lines[i]!.points) {
      if (p.v === null || !Number.isFinite(p.v)) {
        pen = false;
        continue;
      }
      d += `${pen ? "L" : "M"}${x(timeOf(p.t)).toFixed(1)},${y(p.v).toFixed(1)}`;
      pen = true;
    }
    // Wash only one-signed, gap-free series: under an anomaly that crosses zero it would lie.
    const signed = s.every((p) => p.v >= 0) || s.every((p) => p.v <= 0);
    if (i === 0 && signed && s.length > 1 && !d.slice(1).includes("M")) {
      const base = (H - PAD.bottom).toFixed(1);
      const area = `${d}L${x(s[s.length - 1]!.t).toFixed(1)},${base}L${x(s[0]!.t).toFixed(1)},${base}Z`;
      svg.appendChild(svgEl("path", { d: area, class: "chart-area", fill: `url(#${gid})` }));
    }
    svg.appendChild(svgEl("path", { d, class: `chart-line chart-c${i + 1}` }));
    const last = s[s.length - 1];
    if (last) svg.appendChild(svgEl("circle", { cx: x(last.t).toFixed(1), cy: y(last.v).toFixed(1), r: "2.5", class: `chart-end chart-c${i + 1}` }));
  });

  // Hover crosshair + tooltip.
  const cross = svgEl("line", { y1: String(PAD.top), y2: String(H - PAD.bottom), class: "chart-cross" });
  const dots = pts.map((_, i) => svgEl("circle", { r: "3", class: `chart-hover-dot chart-c${i + 1}` }));
  const hover = svgEl("g", { class: "chart-hover" });
  hover.append(cross, ...dots);
  svg.appendChild(hover);
  const hit = svgEl("rect", { x: String(PAD.left), y: String(PAD.top), width: String(W - PAD.left - PAD.right), height: String(H - PAD.top - PAD.bottom), class: "chart-hit" });
  svg.appendChild(hit);

  const plot = document.createElement("div");
  plot.className = "chart-plot";
  const tip = document.createElement("div");
  tip.className = "chart-tip";
  tip.setAttribute("aria-hidden", "true");
  plot.append(svg, tip);
  wrap.appendChild(plot);

  const nearest = (s: Pt[], t: number): Pt | undefined => {
    let lo = 0;
    let hi = s.length - 1;
    if (hi < 0) return undefined;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (s[mid]!.t < t) lo = mid;
      else hi = mid;
    }
    return Math.abs(s[lo]!.t - t) <= Math.abs(s[hi]!.t - t) ? s[lo] : s[hi];
  };

  hit.addEventListener("pointermove", (e) => {
    if (e.pointerType === "touch") return; // taps on a card mean "fly there", not "scrub"
    const r = svg.getBoundingClientRect();
    const vx = ((e.clientX - r.left) / r.width) * W;
    const t = tMin + ((vx - PAD.left) / (W - PAD.left - PAD.right)) * spanT;
    const p0 = nearest(pts[0]!, t);
    if (!p0) return;
    const cx = x(p0.t);
    cross.setAttribute("x1", cx.toFixed(1));
    cross.setAttribute("x2", cx.toFixed(1));
    tip.replaceChildren();
    const when = document.createElement("div");
    when.className = "chart-tip-t";
    when.textContent = p0.raw.slice(0, 10);
    tip.appendChild(when);
    pts.forEach((s, i) => {
      const p = nearest(s, p0.t);
      const dot = dots[i]!;
      if (!p) return;
      dot.setAttribute("cx", x(p.t).toFixed(1));
      dot.setAttribute("cy", y(p.v).toFixed(1));
      const row = document.createElement("div");
      const sw = document.createElement("span");
      sw.className = `chart-swatch chart-c${i + 1}`;
      row.append(sw, document.createTextNode(`${fmtValue(p.v)} ${lines[i]!.unit}`));
      tip.appendChild(row);
    });
    const frac = cx / W;
    tip.style.left = `${(frac * 100).toFixed(2)}%`;
    tip.classList.toggle("chart-tip--left", frac > 0.6);
    wrap.classList.add("is-hover");
  });
  hit.addEventListener("pointerleave", () => wrap.classList.remove("is-hover"));

  return wrap;
}

/** A 100×22 sparkline (no axes) — for dense tiles where the shape is the message. */
export function renderSparkline(points: Array<{ t: string; v: number | null }>): SVGSVGElement {
  const w = 100;
  const h = 22;
  const vals = points.filter((p) => p.v !== null && Number.isFinite(p.v)) as Array<{ t: string; v: number }>;
  const svg = svgEl("svg", { viewBox: `0 0 ${w} ${h}`, class: "spark", preserveAspectRatio: "none", "aria-hidden": "true" });
  if (vals.length < 2) return svg;
  let lo = Infinity;
  let hi = -Infinity;
  for (const p of vals) {
    lo = Math.min(lo, p.v);
    hi = Math.max(hi, p.v);
  }
  const span = hi - lo || 1;
  const d = vals.map((p, i) => `${i ? "L" : "M"}${((i / (vals.length - 1)) * w).toFixed(1)},${(h - 2 - ((p.v - lo) / span) * (h - 4)).toFixed(1)}`).join("");
  svg.appendChild(svgEl("path", { d, class: "spark-line" }));
  return svg;
}
