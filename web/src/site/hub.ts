// The landing's shared state: one View (model.ts) that the panel (panel.ts, in the page bundle) and
// the map (map/explore.ts, the lazy MapLibre chunk) both read and write, mirrored into the URL hash.
// Plus the few fetches both sides need (memoised) and transient signals that are not state (hover,
// "fit these cases", the before/after blend).
//
// URL rules: nothing is written until the reader does something (or arrived by link). Opening a
// case pushes a history entry — Back closes it — everything else replaces.

import { DEFAULT_VIEW, decodeView, encodeView, type MapData, type Metrics, type View } from "./map/model";

export type Origin = "user" | "url" | "camera" | "init";
export type Listener = (v: View, prev: View, origin: Origin) => void;

export interface HubEvents {
  hot: { id: string | null };
  fit: { bbox: [number, number, number, number]; maxZoom?: number };
  fade: { value: number };
  /** The panel/sheet moved: the map re-pads so the globe stays in the part you can see. */
  inset: Record<string, never>;
}

export interface Hub {
  get(): View;
  set(patch: Partial<View>, opts?: { push?: boolean; origin?: Origin }): void;
  subscribe(fn: Listener): () => void;
  /** The reader did something: from now on the URL follows the view. */
  touch(): void;
  /** True when the current case was opened with a pushed history entry (so Back/Esc can pop it). */
  pushed(): boolean;
  emit<K extends keyof HubEvents>(type: K, detail: HubEvents[K]): void;
  on<K extends keyof HubEvents>(type: K, fn: (d: HubEvents[K]) => void): void;
  data: Promise<MapData | null>;
  metrics(): Promise<Metrics | null>;
  /** Relative prefix from this page to the site root. */
  root: string;
}

const json = <T>(url: string): Promise<T | null> =>
  fetch(url)
    .then((r) => (r.ok ? (r.json() as Promise<T>) : null))
    .catch(() => null);

export function createHub(root: string): Hub {
  const restored = decodeView(location.hash);
  let view: View = { ...DEFAULT_VIEW, ...(restored ?? {}) };
  let touched = restored !== null;
  let pushedCase = false;
  const listeners = new Set<Listener>();
  const bus = new EventTarget();
  let metrics: Promise<Metrics | null> | null = null;
  let timer = 0;

  const url = () => `${location.pathname}${location.search}${encodeView(view)}`;
  const write = (push: boolean) => {
    if (!touched) return;
    clearTimeout(timer);
    if (push) {
      history.pushState({ tk: 1 }, "", url());
      pushedCase = true;
    } else timer = window.setTimeout(() => history.replaceState(history.state, "", url()), 250); // the view as it is then
  };

  const hub: Hub = {
    root,
    get: () => view,
    set(patch, opts = {}) {
      const prev = view;
      view = { ...view, ...patch };
      if (!view.open) pushedCase = false;
      if (opts.origin !== "url") write(opts.push === true);
      for (const fn of listeners) fn(view, prev, opts.origin ?? "user");
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    touch() {
      touched = true;
    },
    pushed: () => pushedCase,
    emit(type, detail) {
      bus.dispatchEvent(new CustomEvent(type, { detail }));
    },
    on(type, fn) {
      bus.addEventListener(type, (e) => fn((e as CustomEvent).detail));
    },
    data: json<MapData>(`${root}api/map.json`).then((d) => (d && Array.isArray(d.cases) ? d : null)),
    metrics: () => (metrics ??= json<Metrics>(`${root}api/metrics.json`)),
  };

  // Back / Forward / a pasted hash: the URL wins. The camera stays unless the link names one.
  const fromUrl = () => {
    clearTimeout(timer); // a pending write belongs to the entry we just left
    const d = decodeView(location.hash) ?? {};
    pushedCase = history.state?.tk === 1 && !!d.open;
    const cam = { center: view.center, zoom: view.zoom, pitch: view.pitch, bearing: view.bearing };
    hub.set({ ...DEFAULT_VIEW, ...cam, ...d }, { origin: "url" });
  };
  addEventListener("popstate", fromUrl);
  addEventListener("hashchange", () => {
    if (location.hash === "#challenge") return; // the About pane's anchor, handled by the panel
    if (encodeView(view) !== location.hash) fromUrl();
  });
  return hub;
}
