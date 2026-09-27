// The interactive map's pure core — no DOM, no MapLibre, unit-tested in test/site-map.test.ts.
// View state ⇄ URL hash (a link is a handoff), the layer + time-window filter, the stats the
// strip shows for a window, and the keyless search (bundled places + coordinate parsing).
//
// Data shapes mirror src/watch/map-data.ts, which writes api/map.json at export time.

export type Group = "published" | "checking" | "dropped";
export type Kind = "forest" | "fire" | "flaring" | "flaring-stopped" | "methane" | "other";
export type Overlay = "alerts" | "imagery";
/** Days back from the window's end; 0 = everything up to the end. */
export type Win = 0 | 30 | 90 | 365;

export interface MapCase {
  id: string;
  title: string;
  status: string;
  statusLabel: string;
  group: Group;
  kind: Kind;
  place: string | null;
  meta: string;
  lon: number;
  lat: number;
  bbox: [number, number, number, number];
  observedAt: string;
  firstSeen: string;
  geometry: { type: string; coordinates: unknown };
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

export interface View {
  center: [number, number];
  zoom: number;
  pitch: number;
  bearing: number;
  groups: Group[];
  kinds: Kind[];
  win: Win;
  /** Window end as YYYY-MM-DD; null = the latest data. */
  end: string | null;
  sel: string | null;
  overlays: Overlay[];
}

export const GROUPS: readonly Group[] = ["published", "checking", "dropped"];
export const KINDS: readonly Kind[] = ["forest", "fire", "flaring", "flaring-stopped", "methane", "other"];
export const WINDOWS: readonly Win[] = [30, 90, 365, 0];

export const GROUP_LABEL: Record<Group, string> = { published: "Published", checking: "Being checked", dropped: "Wrong or dropped" };
export const KIND_LABEL: Record<Kind, string> = {
  forest: "Forest loss",
  fire: "Fires",
  flaring: "New flaring",
  "flaring-stopped": "Flaring stopped",
  methane: "Methane",
  other: "Other",
};

export const DEFAULT_VIEW: View = {
  center: [-20, 12],
  zoom: 1.35,
  pitch: 0,
  bearing: 0,
  groups: ["published", "checking"],
  kinds: [...KINDS],
  win: 0,
  end: null,
  sel: null,
  overlays: [],
};

// ---- URL hash ----------------------------------------------------------------------------------
//
// `#map:v=1&c=<lon>,<lat>&z=…&p=…&b=…&g=pc&k=frlsmo&w=90&t=2026-09-01&s=<case id>&o=ai`.
// One-letter tokens from fixed tables; a field with any unknown token is dropped whole (fail
// closed, never half-applied); numbers are clamped on read AND write; the whole hash is length-
// capped. Anything that doesn't start with `#map:` (e.g. `#challenge`) is not ours → null.

const G_TOK: Record<Group, string> = { published: "p", checking: "c", dropped: "d" };
const K_TOK: Record<Kind, string> = { forest: "f", fire: "r", flaring: "l", "flaring-stopped": "s", methane: "m", other: "o" };
const O_TOK: Record<Overlay, string> = { alerts: "a", imagery: "i" };
const PREFIX = "#map:";
const MAX_HASH = 400;
export const CASE_ID = /^[A-Za-z0-9-]{1,64}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

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

export function encodeView(view: View): string {
  const v = clampView(view);
  const q: string[] = ["v=1", `c=${v.center[0]},${v.center[1]}`, `z=${v.zoom}`];
  if (v.pitch) q.push(`p=${v.pitch}`);
  if (v.bearing) q.push(`b=${v.bearing}`);
  const g = tokens(G_TOK, GROUPS, v.groups);
  if (g !== tokens(G_TOK, GROUPS, DEFAULT_VIEW.groups)) q.push(`g=${g}`);
  const k = tokens(K_TOK, KINDS, v.kinds);
  if (k !== tokens(K_TOK, KINDS, DEFAULT_VIEW.kinds)) q.push(`k=${k}`);
  if (v.win) q.push(`w=${v.win}`);
  if (v.end && DAY.test(v.end)) q.push(`t=${v.end}`);
  if (v.sel && CASE_ID.test(v.sel)) q.push(`s=${v.sel}`);
  const o = tokens(O_TOK, ["alerts", "imagery"], v.overlays);
  if (o) q.push(`o=${o}`);
  return `${PREFIX}${q.join("&")}`;
}

/** The fields a hash sets (anything invalid is simply absent), or null when it isn't a map hash. */
export function decodeView(hash: string): Partial<View> | null {
  if (!hash.startsWith(PREFIX) || hash.length > MAX_HASH) return null;
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
    const x = untokens(K_TOK, KINDS, k);
    if (x) out.kinds = x;
  }
  const w = num("w");
  if (w !== null && (WINDOWS as readonly number[]).includes(w)) out.win = w as Win;
  const t = p.get("t");
  if (t && DAY.test(t) && !Number.isNaN(Date.parse(`${t}T00:00:00Z`))) out.end = t;
  const s = p.get("s");
  if (s && CASE_ID.test(s)) out.sel = s;
  const o = p.get("o");
  if (o !== null) {
    const x = untokens(O_TOK, ["alerts", "imagery"], o);
    if (x) out.overlays = x;
  }
  return out;
}

// ---- time window + layer filter ---------------------------------------------------------------------

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

/** Is a case on the map: its status group and case type are switched on, and it falls in the window. */
export function isVisible(c: MapCase, v: Pick<View, "groups" | "kinds" | "win">, endMs: number): boolean {
  return v.groups.includes(c.group) && v.kinds.includes(c.kind) && inWindow(c.observedAt, v.win, endMs);
}

const DECIDED_TRUE = new Set(["confirmed", "published", "notified", "replied", "no_response", "resolved", "ignored", "retracted"]);

/** The stats strip for a window (layer toggles don't change it — it counts the ledger, not the view). */
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
