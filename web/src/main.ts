import "maplibre-gl/dist/maplibre-gl.css";
import "./styles.css";
import { createMap, mapReady, showImagery, showEvents, showFires, showCompare, showQuakes, showSimilar, focusBBox, clearOverlays } from "./map";
import { renderCard } from "./cards";
import type { Card } from "./types";

const feed = document.getElementById("feed") as HTMLDivElement;
const empty = document.getElementById("empty") as HTMLDivElement;
const statusEl = document.getElementById("status") as HTMLSpanElement;
const clearBtn = document.getElementById("clear") as HTMLButtonElement;

// Connect the live feed FIRST so it works even if the map (WebGL) fails to initialize.
connect();

// Initialize the map; if WebGL is unavailable, show a notice but keep the feed alive.
if (!createMap()) {
  const note = document.createElement("div");
  note.className = "map-fallback";
  note.textContent = "Map unavailable (WebGL not supported here) — the live feed still works.";
  document.getElementById("map")?.appendChild(note);
}

function focusCard(card: Card): void {
  if (!mapReady()) return;
  if (card.type === "imagery") showImagery(card);
  else if (card.type === "events") showEvents(card);
  else if (card.type === "fires") showFires(card);
  else if (card.type === "compare") showCompare(card);
  else if (card.type === "quakes") showQuakes(card);
  else if (card.type === "similar") showSimilar(card);
  // Everything else (index, search, series, note, …): any card that knows where it is
  // should navigate there on click — focusBBox is a no-op without a bbox.
  else focusBBox(card);
}

// id → rendered node + serialized card. Identical re-sends (SSE replays state on
// reconnect) are dropped; CHANGED re-sends are streaming updates (e.g. narrate's growing
// note) and swap the node in place — no jump to the top, no map re-focus.
const seen = new Map<string, { el: HTMLElement; json: string }>();

function handleCard(card: Card): void {
  const json = JSON.stringify(card);
  const prev = seen.get(card.id);
  if (prev?.json === json) return;

  // A malformed/hostile card must not break the feed — render defensively.
  let node: HTMLElement;
  try {
    node = renderCard(card, focusCard);
  } catch (err) {
    console.error("failed to render card", err);
    return;
  }
  node.dataset.cardId = card.id;

  if (prev) {
    prev.el.replaceWith(node);
    seen.set(card.id, { el: node, json });
    return;
  }
  seen.set(card.id, { el: node, json });
  empty.style.display = "none";
  feed.prepend(node);

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

function connect(): void {
  const es = new EventSource("/events");
  es.onopen = () => {
    statusEl.textContent = "● live";
    statusEl.className = "status status--on";
  };
  es.onerror = () => {
    statusEl.textContent = "● reconnecting…";
    statusEl.className = "status status--off";
  };
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
  empty.style.display = "";
});
