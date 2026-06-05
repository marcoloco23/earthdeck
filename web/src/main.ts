import "maplibre-gl/dist/maplibre-gl.css";
import "./styles.css";
import { createMap, mapReady, showImagery, showEvents, clearOverlays } from "./map";
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
}

const seen = new Set<string>();

function handleCard(card: Card): void {
  if (seen.has(card.id)) return; // SSE replays state on connect; de-dupe
  seen.add(card.id);

  empty.style.display = "none";
  feed.prepend(renderCard(card, focusCard));

  // Auto-focus the newest card on the map.
  focusCard(card);

  // Keep the feed bounded.
  while (feed.children.length > 60) feed.removeChild(feed.lastChild as Node);
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
