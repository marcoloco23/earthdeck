import "maplibre-gl/dist/maplibre-gl.css";
import "./styles.css";
import { createMap, mapReady, showImagery, showEvents, showFires, showCompare, showQuakes, showSimilar, showFinding, focusBBox, clearOverlays } from "./map";
import { renderCard, toneOf, typeLabel, TYPE_ORDER } from "./cards";
import { initWatch, type LedgerSummary } from "./watch";
import { EASE_OUT, ago, el, reducedMotion } from "./ui";
import type { Card } from "./types";

const feed = document.getElementById("feed") as HTMLDivElement;
const feedPane = document.getElementById("feed-pane") as HTMLDivElement;
const filtersEl = document.getElementById("filters") as HTMLDivElement;
const empty = document.getElementById("empty") as HTMLDivElement;
const statusEl = document.getElementById("status") as HTMLSpanElement;
const lastCardEl = document.querySelector("#last-card .tele-v") as HTMLSpanElement;
const heartbeatEl = document.getElementById("heartbeat") as HTMLSpanElement;
const clearBtn = document.getElementById("clear") as HTMLButtonElement;
const watchEl = document.getElementById("watch") as HTMLDivElement;
const feedCount = document.getElementById("feed-count") as HTMLSpanElement;
const watchCount = document.getElementById("watch-count") as HTMLSpanElement;

// Connect the live feed FIRST so it works even if the map (WebGL) fails to initialize.
connect();

// Initialize the map; if WebGL is unavailable, show a notice but keep the feed alive.
if (!createMap()) {
  const note = el("div", "map-fallback", "Map unavailable (WebGL not supported here) — the live feed still works.");
  document.getElementById("map")?.appendChild(note);
}

function focusCard(card: Card): void {
  setActive(card.id);
  if (!mapReady()) return;
  if (card.type === "imagery") showImagery(card);
  else if (card.type === "events") showEvents(card);
  else if (card.type === "fires") showFires(card);
  else if (card.type === "compare") showCompare(card);
  else if (card.type === "quakes") showQuakes(card);
  else if (card.type === "similar") showSimilar(card);
  else if (card.type === "finding") showFinding(card.payload.geometry as Parameters<typeof showFinding>[0], card.bbox);
  // Everything else (index, search, series, note, …): any card that knows where it is
  // should navigate there on click — focusBBox is a no-op without a bbox.
  else focusBBox(card);
}

/** The card the map is currently showing gets an accent edge — ties map and feed together. */
function setActive(id: string): void {
  for (const n of feed.querySelectorAll(".card.is-active")) n.classList.remove("is-active");
  seen.get(id)?.el.classList.add("is-active");
}

// id → rendered node + serialized card. Identical re-sends (SSE replays state on
// reconnect) are dropped; CHANGED re-sends are streaming updates (e.g. narrate's growing
// note) and swap the node in place — no jump to the top, no map re-focus.
const seen = new Map<string, { el: HTMLElement; json: string; type: string }>();
let lastCardAt = 0;

// ---- Type filters ----------------------------------------------------------------------
let filter: string | null = null;

function matches(type: string): boolean {
  return filter === null || toneOf(type) === filter;
}

function renderFilters(): void {
  const counts = new Map<string, number>();
  for (const { type } of seen.values()) counts.set(toneOf(type), (counts.get(toneOf(type)) ?? 0) + 1);
  if (filter !== null && !counts.has(filter)) filter = null;
  filtersEl.hidden = seen.size === 0;
  filtersEl.replaceChildren();
  const chip = (key: string | null, label: string, n: number) => {
    const b = el("button", `chip-btn${filter === key ? " is-on" : ""}`);
    b.type = "button";
    b.setAttribute("aria-pressed", String(filter === key));
    if (key) b.dataset.type = key;
    if (key) b.appendChild(el("span", "chip-dot"));
    b.append(document.createTextNode(label), el("span", "chip-n", String(n)));
    b.addEventListener("click", () => {
      filter = filter === key ? null : key;
      applyFilter();
      renderFilters();
    });
    filtersEl.appendChild(b);
  };
  chip(null, "All", seen.size);
  const order = [...TYPE_ORDER, "other"];
  for (const t of order) {
    const n = counts.get(t);
    if (n) chip(t, t === "other" ? "Other" : typeLabel(t), n);
  }
  feedCount.textContent = seen.size ? String(seen.size) : "";
}

function applyFilter(): void {
  for (const { el: node, type } of seen.values()) node.hidden = !matches(type);
}

// ---- Feed insertion + motion -------------------------------------------------------------
// On (re)connect the server replays its whole state in one burst. Those cards are held
// invisible, then revealed together with a short stagger once the burst settles — instead
// of 20 cards each sliding in and shoving the list around.
let booting = true;
let bootTimer = 0;
function scheduleBootEnd(): void {
  clearTimeout(bootTimer);
  bootTimer = window.setTimeout(endBoot, 250);
}
function endBoot(): void {
  if (!booting) return;
  booting = false;
  feed.classList.remove("is-booting");
  if (reducedMotion()) return;
  const visible = [...feed.children].filter((n) => !(n as HTMLElement).hidden).slice(0, 6) as HTMLElement[];
  visible.forEach((n, i) =>
    n.animate([{ opacity: 0, transform: "translateY(6px)" }, { opacity: 1, transform: "none" }], { duration: 260, delay: i * 45, easing: EASE_OUT, fill: "backwards" }),
  );
}

// "New cards above" pill: when the reader has scrolled down, we keep their place and tell
// them what arrived rather than yanking the list.
const newPill = el("button", "new-pill");
newPill.type = "button";
newPill.hidden = true;
let newAbove = 0;
newPill.addEventListener("click", () => feed.scrollTo({ top: 0, behavior: reducedMotion() ? "auto" : "smooth" }));
feedPane.appendChild(newPill);
feed.addEventListener("scroll", () => {
  if (feed.scrollTop < 8 && newAbove) {
    newAbove = 0;
    newPill.hidden = true;
  }
}, { passive: true });

function insertCard(node: HTMLElement, visible: boolean): void {
  const prevTop = feed.scrollTop;
  feed.prepend(node);
  if (booting || !visible) return;
  const gap = parseFloat(getComputedStyle(feed).rowGap) || 0;
  const h = node.offsetHeight + gap;
  if (prevTop > 8) {
    // Reader is mid-list: hold their position; the new card lands above, out of view.
    feed.scrollTop = prevTop + h;
    newAbove += 1;
    newPill.textContent = `${newAbove} new ↑`;
    newPill.hidden = false;
    return;
  }
  if (reducedMotion()) return;
  // FLIP: the cards below start where they were and glide down to make room.
  let moved = 0;
  for (let n = node.nextElementSibling as HTMLElement | null; n && moved < 8; n = n.nextElementSibling as HTMLElement | null) {
    if (n.hidden) continue;
    n.animate([{ transform: `translateY(${-h}px)` }, { transform: "none" }], { duration: 280, easing: EASE_OUT });
    moved += 1;
  }
}

function handleCard(card: Card): void {
  const json = JSON.stringify(card);
  const prev = seen.get(card.id);
  if (prev?.json === json) return;
  if (booting) scheduleBootEnd();

  // A malformed/hostile card must not break the feed — render defensively.
  let node: HTMLElement;
  try {
    node = renderCard(card, focusCard);
  } catch (err) {
    console.error("failed to render card", err);
    return;
  }
  node.dataset.cardId = card.id;
  node.hidden = !matches(card.type);

  if (prev) {
    // Streaming update: swap in place, no entrance, keep the active state.
    node.classList.add("no-enter");
    if (prev.el.classList.contains("is-active")) node.classList.add("is-active");
    prev.el.replaceWith(node);
    seen.set(card.id, { el: node, json, type: card.type });
    return;
  }
  seen.set(card.id, { el: node, json, type: card.type });
  if (booting) node.classList.add("no-enter");
  empty.hidden = true;
  lastCardAt = Math.max(lastCardAt, Date.parse(card.ts) || Date.now());
  tickTelemetry();
  insertCard(node, !node.hidden);
  renderFilters();

  // Auto-focus the newest card on the map.
  try {
    focusCard(card);
  } catch (err) {
    console.error("failed to focus card", err);
  }

  // Keep the feed bounded (and keep the id map in sync with evictions).
  while (feed.children.length > 60) {
    const last = feed.lastChild as HTMLElement;
    if (last.dataset?.cardId) seen.delete(last.dataset.cardId);
    feed.removeChild(last);
  }
}

function setStatus(state: "on" | "off" | "wait", text: string): void {
  statusEl.className = `pill pill--${state}`;
  (statusEl.querySelector(".pill-text") as HTMLElement).textContent = text;
}

function connect(): void {
  feed.classList.add("is-booting");
  const es = new EventSource("/events");
  es.onopen = () => {
    setStatus("on", "Live");
    scheduleBootEnd();
  };
  es.onerror = () => setStatus(es.readyState === EventSource.CLOSED ? "off" : "wait", "Reconnecting");
  es.onmessage = (e: MessageEvent<string>) => {
    try {
      handleCard(JSON.parse(e.data) as Card);
    } catch {
      /* ignore malformed frames */
    }
  };
}

clearBtn.addEventListener("click", () => {
  feed.replaceChildren();
  seen.clear();
  clearOverlays();
  filter = null;
  newAbove = 0;
  newPill.hidden = true;
  renderFilters();
  empty.hidden = false;
});

// ---- Header telemetry ----------------------------------------------------------------------
let ledger: LedgerSummary | null = null;
function tickTelemetry(): void {
  lastCardEl.textContent = lastCardAt ? ago(lastCardAt) : "none yet";
  const v = heartbeatEl.querySelector(".tele-v") as HTMLElement;
  if (!ledger) return;
  if (!ledger.ok) {
    v.textContent = "unavailable";
    heartbeatEl.classList.add("tele--warn");
    return;
  }
  heartbeatEl.classList.remove("tele--warn");
  v.textContent = ledger.size ? `${ledger.size} entries · ${ledger.lastActivity ? ago(ledger.lastActivity) : "idle"}` : "empty";
  heartbeatEl.title = ledger.root ? `Findings ledger · ${ledger.size} entries\nMerkle root ${ledger.root}` : "Findings ledger is empty";
}
setInterval(tickTelemetry, 1000);
tickTelemetry();

// ---- Tabs: the live feed vs the findings ledger (Watch) --------------------------------------
const watch = initWatch(
  watchEl,
  (f) => {
    if (mapReady()) showFinding(f.geometry as Parameters<typeof showFinding>[0], f.bbox);
  },
  (s) => {
    ledger = s;
    watchCount.textContent = s.ok && s.open ? String(s.open) : "";
    watchCount.title = s.ok ? `${s.open} open case${s.open === 1 ? "" : "s"}` : "";
    tickTelemetry();
  },
);
function showTab(name: string): void {
  const isWatch = name === "watch";
  feedPane.hidden = isWatch;
  watchEl.hidden = !isWatch;
  clearBtn.hidden = isWatch;
  for (const b of document.querySelectorAll<HTMLButtonElement>("#tabs .tab")) {
    const on = b.dataset.tab === name;
    b.classList.toggle("tab--on", on);
    b.setAttribute("aria-selected", String(on));
  }
  if (isWatch) void watch.refresh();
}
for (const b of document.querySelectorAll<HTMLButtonElement>("#tabs .tab")) b.addEventListener("click", () => showTab(b.dataset.tab ?? "feed"));
// The ledger is local and cheap to read: poll it always so the header heartbeat stays honest.
setInterval(() => void watch.refresh(), 30_000);
