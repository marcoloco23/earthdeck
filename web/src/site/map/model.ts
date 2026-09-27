// The landing's map + panel, pure core — no DOM, no MapLibre, unit-tested in test/site-map.test.ts.
// View state ⇄ URL hash (a link is a handoff: camera, filters, mode, panel, the open case), the
// status/topic/time filter, planet-wide vs. place cases, the clustered marker features, the
// stats for a time window, and the keyless search (bundled places + coordinate parsing).
//
// Data shapes mirror src/watch/map-data.ts (api/map.json) and src/watch/metrics.ts (api/metrics.json).

export type Group = "published" | "checking" | "dropped";
export type Kind = "forest" | "fire" | "flaring" | "flaring-stopped" | "methane" | "other";
export type Topic = "forest" | "fire" | "flaring" | "methane" | "ocean" | "ice" | "air" | "weather" | "trend" | "other";
export type Overlay = "alerts" | "imagery" | "weather";
export type Mode = "cases" | "planet" | "live" | "metrics" | "about";
/** Days back from the window's end; 0 = everything up to the end. */
export type Win = 0 | 30 | 90 | 365;

export interface MapCase {
  id: string;
  title: string;
  status: string;
  statusLabel: string;
  group: Group;
  kind: Kind;
  /** Older map.json files lack these two; see topicOfCase / isGlobal. */
  topic?: Topic;
  global?: boolean;
  place: string | null;
  meta: string;
  lon: number;
  lat: number;
  bbox: [number, number, number, number];
  observedAt: string;
  firstSeen: string;
  geometry: { type: string; coordinates: unknown };
  indicator?: string;
  points?: [number, number][];
}
export interface MapPlace {
  id: string;
  name: string;
  lon: number;
  lat: number;
  bbox: [number, number, number, number];
}
export interface MapData {
  v: 1;
  generatedAt: string;
  cases: MapCase[];
  places: MapPlace[];
}

export interface StakeMetric {
  key: string;
  label: string;
  value: number;
  display: string;
  explain: string;
  caseIds: string[];
}
export interface Metrics {
  v: 1;
  generatedAt: string;
  totals: { all: number; byGroup: Record<Group, number>; byTopic: Partial<Record<Topic, number>> };
  timeline: { bucket: "day" | "week" | "month"; points: { t: string; published: number; checking: number; dropped: number }[] };
  places: { name: string; n: number; caseIds: string[] }[];
  rules: { rule: string; label: string; falsePositives: number; decided: number; rate: number | null }[];
  stake: StakeMetric[];
  nature: { lowUsd: number; highUsd: number; source: string };
}

export interface View {
  center: [number, number];
  zoom: number;
  pitch: number;
  bearing: number;
  groups: Group[];
  topics: Topic[];
  win: Win;
  /** Window end as YYYY-MM-DD; null = the latest data. */
  end: string | null;
  /** The selected case: outlined on the map, highlighted in the list. */
  sel: string | null;
  /** The selected case is open in the panel (the full write-up). */
  open: boolean;
  overlays: Overlay[];
  mode: Mode;
  /** Panel shown (true) or folded away (false). */
  panel: boolean;
  /** A Metrics number the list is narrowed to (its key in api/metrics.json). */
  metric: string | null;
  /** Live layers switched on, by layer id. */
  layers: string[];
}

export const GROUPS: readonly Group[] = ["published", "checking", "dropped"];
export const KINDS: readonly Kind[] = ["forest", "fire", "flaring", "flaring-stopped", "methane", "other"];
export const TOPICS: readonly Topic[] = ["forest", "fire", "flaring", "methane", "ocean", "ice", "air", "weather", "trend", "other"];
export const MODES: readonly Mode[] = ["cases", "planet", "live", "metrics", "about"];
export const OVERLAYS: readonly Overlay[] = ["alerts", "imagery", "weather"];
export const WINDOWS: readonly Win[] = [30, 90, 365, 0];

export const GROUP_LABEL: Record<Group, string> = { published: "Published", checking: "Being checked", dropped: "False alarms" };
export const KIND_LABEL: Record<Kind, string> = {
  forest: "Forest loss",
  fire: "Fires",
  flaring: "New flaring",
  "flaring-stopped": "Flaring stopped",
  methane: "Methane",
  other: "Other",
};
export const TOPIC_LABEL: Record<Topic, string> = {
  forest: "Forests",
  fire: "Fire",
  flaring: "Flaring",
  methane: "Methane",
  ocean: "Oceans",
  ice: "Ice",
  air: "Air",
  weather: "Weather",
  trend: "Nature trends",
  other: "Other",
};

export const DEFAULT_VIEW: View = {
  center: [-20, 12],
  zoom: 1.35,
  pitch: 0,
  bearing: 0,
  groups: [...GROUPS],
  topics: [...TOPICS],
  win: 0,
  end: null,
  sel: null,
  open: false,
  overlays: [],
  mode: "cases",
  panel: true,
  metric: null,
  layers: [],
};

// ---- place vs. planet, topic ------------------------------------------------------------------------

/** The topic a case is filed under (older data without `topic`: from its case type). */
export function topicOfCase(c: Pick<MapCase, "topic" | "kind">): Topic {
  if (c.topic && (TOPICS as readonly string[]).includes(c.topic)) return c.topic;
  return c.kind === "flaring-stopped" ? "flaring" : c.kind === "other" ? "other" : c.kind;
}

/** Planet-wide (world trend, sea ice, ENSO): lives in the Planet panel, never a map marker. */
export function isGlobal(c: Pick<MapCase, "global" | "bbox">): boolean {
  if (typeof c.global === "boolean") return c.global;
  return c.bbox[2] - c.bbox[0] >= 180;
}

/** The evidence overlay a case opens with: forest alerts, before/after imagery for flares, rain for weather. */
export function defaultOverlays(c: Pick<MapCase, "kind" | "topic">): Overlay[] {
  const t = topicOfCase(c);
  if (t === "forest") return ["alerts"];
  if (t === "flaring") return ["imagery"];
  if (t === "weather") return ["weather"];
  return [];
}

// ---- URL hash ----------------------------------------------------------------------------------
//
// `#map:v=1&c=<lon>,<lat>&z=…&p=…&b=…&g=pc&k=frl&w=90&t=2026-09-01&s=<id>&o=ai&m=p&pc=1&f=<metric>&l=wx-clouds`,
// or `#case=<id>` for an open case (the camera follows the case). One-letter tokens from fixed
// tables; a field with any unknown token is dropped whole (fail closed, never half-applied);
// numbers are clamped on read AND write; the whole hash is length-capped. Anything else (e.g.
// `#challenge`) is not ours → null.

const G_TOK: Record<Group, string> = { published: "p", checking: "c", dropped: "d" };
const T_TOK: Record<Topic, string> = { forest: "f", fire: "r", flaring: "l", methane: "m", ocean: "o", ice: "i", air: "a", weather: "w", trend: "t", other: "x" };
const O_TOK: Record<Overlay, string> = { alerts: "a", imagery: "i", weather: "w" };
const M_TOK: Record<Mode, string> = { cases: "c", planet: "p", live: "l", metrics: "x", about: "a" };
const PREFIX = "#map:";
const CASE_PREFIX = "#case=";
const MAX_HASH = 400;
export const CASE_ID = /^[A-Za-z0-9-]{1,64}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const METRIC = /^[a-z0-9_]{1,32}$/;
const LAYER = /^[a-z0-9-]{1,32}$/;
const MAX_LAYERS = 8;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const wrapLon = (v: number) => ((((v + 180) % 360) + 360) % 360) - 180;
const fix = (v: number, d: number) => Number(v.toFixed(d));

function clampView(v: View): View {
  return {
    ...v,
    center: [fix(wrapLon(v.center[0]), 4), fix(clamp(v.center[1], -85, 85), 4)],
    zoom: fix(clamp(v.zoom, 0, 18), 2),
    pitch: Math.round(clamp(v.pitch, 0, 60)),
    bearing: Math.round(clamp(wrapLon(v.bearing), -180, 180)),
  };
}

function tokens<T extends string>(table: Record<T, string>, all: readonly T[], picked: readonly T[]): string {
  return all.filter((x) => picked.includes(x)).map((x) => table[x]).join("");
}
function untokens<T extends string>(table: Record<T, string>, all: readonly T[], raw: string): T[] | null {
  if (raw.length > all.length) return null;
  const out: T[] = [];
  for (const ch of raw) {
    const hit = all.find((x) => table[x] === ch);
    if (!hit || out.includes(hit)) return null;
    out.push(hit);
  }
  return all.filter((x) => out.includes(x));
}
const cleanLayers = (l: readonly string[]) => [...new Set(l.filter((x) => LAYER.test(x)))].slice(0, MAX_LAYERS);

export function encodeView(view: View): string {
  if (view.open && view.sel && CASE_ID.test(view.sel)) return `${CASE_PREFIX}${view.sel}`;
  const v = clampView(view);
  const q: string[] = ["v=1", `c=${v.center[0]},${v.center[1]}`, `z=${v.zoom}`];
  if (v.pitch) q.push(`p=${v.pitch}`);
  if (v.bearing) q.push(`b=${v.bearing}`);
  const g = tokens(G_TOK, GROUPS, v.groups);
  if (g !== tokens(G_TOK, GROUPS, DEFAULT_VIEW.groups)) q.push(`g=${g}`);
  const k = tokens(T_TOK, TOPICS, v.topics);
  if (k !== tokens(T_TOK, TOPICS, DEFAULT_VIEW.topics)) q.push(`k=${k}`);
  if (v.win) q.push(`w=${v.win}`);
  if (v.end && DAY.test(v.end)) q.push(`t=${v.end}`);
  if (v.sel && CASE_ID.test(v.sel)) q.push(`s=${v.sel}`);
  const o = tokens(O_TOK, OVERLAYS, v.overlays);
  if (o) q.push(`o=${o}`);
  if (v.mode !== DEFAULT_VIEW.mode && MODES.includes(v.mode)) q.push(`m=${M_TOK[v.mode]}`);
  if (!v.panel) q.push("pc=1");
  if (v.metric && METRIC.test(v.metric)) q.push(`f=${v.metric}`);
  const l = cleanLayers(v.layers);
  if (l.length) q.push(`l=${l.join(",")}`);
  return `${PREFIX}${q.join("&")}`;
}

/** The fields a hash sets (anything invalid is simply absent), or null when it isn't ours. */
export function decodeView(hash: string): Partial<View> | null {
  if (hash.length > MAX_HASH) return null;
  if (hash.startsWith(CASE_PREFIX)) {
    const id = hash.slice(CASE_PREFIX.length);
    return CASE_ID.test(id) ? { sel: id, open: true, mode: "cases", panel: true } : null;
  }
  if (!hash.startsWith(PREFIX)) return null;
  const p = new URLSearchParams(hash.slice(PREFIX.length));
  if (p.get("v") !== "1") return null;
  const out: Partial<View> = {};
  const num = (k: string) => {
    const raw = p.get(k);
    if (raw === null || !/^-?\d+(\.\d+)?$/.test(raw)) return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  };
  const c = (p.get("c") ?? "").split(",");
  if (c.length === 2 && c.every((x) => /^-?\d+(\.\d+)?$/.test(x))) {
    const [lon, lat] = c.map(Number) as [number, number];
    if (Number.isFinite(lon) && Number.isFinite(lat)) out.center = [fix(wrapLon(lon), 4), fix(clamp(lat, -85, 85), 4)];
  }
  const z = num("z");
  if (z !== null) out.zoom = fix(clamp(z, 0, 18), 2);
  const pi = num("p");
  if (pi !== null) out.pitch = Math.round(clamp(pi, 0, 60));
  const b = num("b");
  if (b !== null) out.bearing = Math.round(clamp(wrapLon(b), -180, 180));
  const g = p.get("g");
  if (g !== null) {
    const x = untokens(G_TOK, GROUPS, g);
    if (x) out.groups = x;
  }
  const k = p.get("k");
  if (k !== null) {
    const x = untokens(T_TOK, TOPICS, k);
    if (x) out.topics = x;
  }
  const w = num("w");
  if (w !== null && (WINDOWS as readonly number[]).includes(w)) out.win = w as Win;
  const t = p.get("t");
  if (t && DAY.test(t) && !Number.isNaN(Date.parse(`${t}T00:00:00Z`))) out.end = t;
  const s = p.get("s");
  if (s && CASE_ID.test(s)) out.sel = s;
  const o = p.get("o");
  if (o !== null) {
    const x = untokens(O_TOK, OVERLAYS, o);
    if (x) out.overlays = x;
  }
  const m = p.get("m");
  if (m !== null) {
    const x = MODES.find((mode) => M_TOK[mode] === m);
    if (x) out.mode = x;
  }
  if (p.get("pc") === "1") out.panel = false;
  const f = p.get("f");
  if (f && METRIC.test(f)) out.metric = f;
  const l = p.get("l");
  if (l !== null) {
    const parts = l.split(",");
    if (parts.length <= MAX_LAYERS && parts.every((x) => LAYER.test(x))) out.layers = cleanLayers(parts);
  }
  return out;
}

// ---- time window + filter ---------------------------------------------------------------------

const DAY_MS = 86_400_000;

/** The window's end in ms: the chosen day's last millisecond, else the data's generation time. */
export function endMsOf(view: Pick<View, "end">, generatedAt: string): number {
  if (view.end) return Date.parse(`${view.end}T00:00:00Z`) + DAY_MS - 1;
  const g = Date.parse(generatedAt);
  return Number.isNaN(g) ? Date.now() : g;
}

/** [start, end] in ms; start is null for "everything up to end". */
export function windowRange(win: Win, endMs: number): [number | null, number] {
  return [win ? endMs - win * DAY_MS : null, endMs];
}

export function inWindow(iso: string, win: Win, endMs: number): boolean {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return false;
  const [start, end] = windowRange(win, endMs);
  return t <= end && (start === null || t > start);
}

/**
 * Is a place case on the map and in the list: its status and topic are switched on, it falls in
 * the window, and (when a Metrics number narrowed the view) it is one of that number's cases.
 * Planet-wide cases never are — they live in the Planet panel.
 */
export function isVisible(c: MapCase, v: Pick<View, "groups" | "topics" | "win">, endMs: number, only: ReadonlySet<string> | null = null): boolean {
  if (isGlobal(c)) return false;
  if (only && !only.has(c.id)) return false;
  return v.groups.includes(c.group) && v.topics.includes(topicOfCase(c)) && inWindow(c.observedAt, v.win, endMs);
}

const DECIDED_TRUE = new Set(["confirmed", "published", "notified", "replied", "no_response", "resolved", "ignored", "retracted"]);

/** The stats chips for a window (filters don't change it — it counts the ledger, not the view). */
export function windowStats(cases: readonly MapCase[], win: Win, endMs: number): { published: number; falsePositives: number; decided: number; total: number } {
  let published = 0;
  let falsePositives = 0;
  let decided = 0;
  let total = 0;
  for (const c of cases) {
    if (!inWindow(c.observedAt, win, endMs)) continue;
    total += 1;
    if (c.group === "published") published += 1;
    if (c.status === "false_positive") {
      falsePositives += 1;
      decided += 1;
    } else if (DECIDED_TRUE.has(c.status)) decided += 1;
  }
  return { published, falsePositives, decided, total };
}

/** Earliest observation day (YYYY-MM-DD) — where the scrubber and the replay start. */
export function firstDay(cases: readonly MapCase[]): string | null {
  let min: string | null = null;
  for (const c of cases) if (!Number.isNaN(Date.parse(c.observedAt)) && (min === null || c.observedAt < min)) min = c.observedAt;
  return min ? min.slice(0, 10) : null;
}

export const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** One bbox around many cases (for "fit the map to these"), or null for none. */
export function boundsOf(cases: readonly Pick<MapCase, "bbox">[]): [number, number, number, number] | null {
  if (!cases.length) return null;
  const b: [number, number, number, number] = [180, 90, -180, -90];
  for (const c of cases) {
    b[0] = Math.min(b[0], c.bbox[0]);
    b[1] = Math.min(b[1], c.bbox[1]);
    b[2] = Math.max(b[2], c.bbox[2]);
    b[3] = Math.max(b[3], c.bbox[3]);
  }
  return b;
}

// ---- clustered markers --------------------------------------------------------------------------
//
// One GeoJSON point per place case; MapLibre clusters them at low zoom and sums per-status counts
// into each cluster (CLUSTER_PROPERTIES), which colour the cluster the way clusterGroup() says.

export interface CaseProps {
  id: string;
  g: Group;
  t: Topic;
  /** 1 for public cases — drawn a little larger. */
  pub: 0 | 1;
  title: string;
}

export function caseFeatures(cases: readonly MapCase[]): { type: "FeatureCollection"; features: { type: "Feature"; id: number; geometry: { type: "Point"; coordinates: [number, number] }; properties: CaseProps }[] } {
  return {
    type: "FeatureCollection",
    features: cases
      .filter((c) => !isGlobal(c) && Number.isFinite(c.lon) && Number.isFinite(c.lat))
      .map((c, i) => ({
        type: "Feature" as const,
        id: i + 1, // numeric ids so hover/selection can use feature-state
        geometry: { type: "Point" as const, coordinates: [c.lon, c.lat] as [number, number] },
        properties: { id: c.id, g: c.group, t: topicOfCase(c), pub: c.group === "published" ? 1 : 0, title: c.title.length > 80 ? `${c.title.slice(0, 79)}…` : c.title },
      })),
  };
}

/** Per-status counts MapLibre adds up inside each cluster. */
export const CLUSTER_PROPERTIES = {
  pub: ["+", ["case", ["==", ["get", "g"], "published"], 1, 0]],
  chk: ["+", ["case", ["==", ["get", "g"], "checking"], 1, 0]],
  drop: ["+", ["case", ["==", ["get", "g"], "dropped"], 1, 0]],
} as const;

/** A cluster takes the colour of the most important status inside it: published, then checking. */
export function clusterGroup(p: { pub?: number; chk?: number; drop?: number }): Group {
  if ((p.pub ?? 0) > 0) return "published";
  if ((p.chk ?? 0) > 0) return "checking";
  return "dropped";
}

// ---- keyless search ------------------------------------------------------------------------------------

/**
 * Decimal degrees only: `-6.6, -51.9`, `-6.6 -51.9`, `6.6S 51.9W`, `6.6°S, 51.9°W`, `S6.6 W51.9`.
 * Unlettered pairs are lat, lon; hemisphere letters make any order unambiguous. A sign and a
 * letter together, two letters on one axis, trailing text or out-of-range values → null.
 */
export function parseCoords(q: string): { lat: number; lon: number } | null {
  const s = q.trim().replace(/[−–]/g, "-");
  const parts = s.split(/\s*[,;]\s*|\s+/).filter(Boolean);
  if (parts.length !== 2) return null;
  const parsed = parts.map((raw) => {
    const m = /^([NSEW])?\s*(-?\d{1,3}(?:\.\d+)?)\s*°?\s*([NSEW])?$/i.exec(raw);
    if (!m || (m[1] && m[3])) return null;
    const letter = (m[1] ?? m[3] ?? "").toUpperCase();
    const n = Number(m[2]);
    if (letter && n < 0) return null;
    return { n: letter === "S" || letter === "W" ? -n : n, axis: letter === "N" || letter === "S" ? "lat" : letter ? "lon" : null };
  });
  if (parsed.some((x) => x === null)) return null;
  const [a, b] = parsed as { n: number; axis: "lat" | "lon" | null }[];
  let lat: number;
  let lon: number;
  if (a!.axis && b!.axis) {
    if (a!.axis === b!.axis) return null;
    [lat, lon] = a!.axis === "lat" ? [a!.n, b!.n] : [b!.n, a!.n];
  } else if (a!.axis === "lon" || b!.axis === "lat") [lon, lat] = [a!.n, b!.n];
  else [lat, lon] = [a!.n, b!.n];
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { lat, lon };
}

export interface Hit {
  kind: "coord" | "place" | "case";
  label: string;
  sub: string;
  lon: number;
  lat: number;
  bbox?: [number, number, number, number];
  id?: string;
}

const norm = (s: string) =>
  s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

function score(name: string, q: string): number {
  const n = norm(name);
  const words = q.split(" ");
  if (!words.every((w) => n.includes(w))) return 0;
  if (n.startsWith(q)) return 3;
  return words.every((w) => n.split(" ").some((x) => x.startsWith(w))) ? 2 : 1;
}

export const fmtCoord = (lat: number, lon: number) => `${Math.abs(lat).toFixed(4)}° ${lat < 0 ? "S" : "N"}, ${Math.abs(lon).toFixed(4)}° ${lon < 0 ? "W" : "E"}`;

/** Coordinates first, then watched places, then cases — all from the bundled data, no network. */
export function search(q: string, places: readonly MapPlace[], cases: readonly MapCase[], limit = 6): Hit[] {
  const c = parseCoords(q);
  if (c) return [{ kind: "coord", label: fmtCoord(c.lat, c.lon), sub: "Coordinates", lon: c.lon, lat: c.lat }];
  const nq = norm(q);
  if (nq.length < 2) return [];
  const hits: (Hit & { s: number })[] = [];
  for (const p of places) {
    const s = score(p.name, nq);
    if (s) hits.push({ kind: "place", label: p.name, sub: "Watched place", lon: p.lon, lat: p.lat, bbox: p.bbox, s: s + 0.5 });
  }
  for (const k of cases) {
    const s = Math.max(score(k.title, nq), k.place ? score(k.place, nq) : 0);
    if (s) hits.push({ kind: "case", label: k.title, sub: [k.statusLabel, k.place].filter(Boolean).join(" · "), lon: k.lon, lat: k.lat, bbox: k.bbox, id: k.id, s });
  }
  return hits
    .sort((a, b) => b.s - a.s || a.label.localeCompare(b.label))
    .slice(0, limit)
    .map(({ s: _s, ...h }) => h);
}

// ---- motion ------------------------------------------------------------------------------------------------

/** CSS cubic-bezier as a function of t (for MapLibre's `easing`), so fly-to matches the site's curves. */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number): (t: number) => number {
  const bx = (t: number) => 3 * x1 * t * (1 - t) ** 2 + 3 * x2 * t * t * (1 - t) + t ** 3;
  const by = (t: number) => 3 * y1 * t * (1 - t) ** 2 + 3 * y2 * t * t * (1 - t) + t ** 3;
  return (x: number) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let lo = 0;
    let hi = 1;
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) / 2;
      if (bx(mid) < x) lo = mid;
      else hi = mid;
    }
    return by((lo + hi) / 2);
  };
}
/** --ease-in-out from styles.css: on-screen movement. */
export const EASE_IN_OUT = cubicBezier(0.77, 0, 0.175, 1);

// ---- bottom sheet (phone) ----------------------------------------------------------------------------------

export type Snap = "peek" | "half" | "full";
export const SNAPS: readonly Snap[] = ["peek", "half", "full"];

/** Apple's momentum projection: where a flick would come to rest (px), d ≈ 0.998 like scrolling. */
export const project = (velocityPxPerS: number, d = 0.998) => ((velocityPxPerS / 1000) * d) / (1 - d);

/** The snap whose offset is nearest to where the drag is heading (offsets: px from the top, per snap). */
export function nearestSnap(offset: number, velocityPxPerS: number, offsets: Record<Snap, number>): Snap {
  const target = offset + project(velocityPxPerS);
  let best: Snap = "half";
  let dist = Infinity;
  for (const s of SNAPS) {
    const d = Math.abs(offsets[s] - target);
    if (d < dist) {
      dist = d;
      best = s;
    }
  }
  return best;
}
