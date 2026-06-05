import type { Card, EventItem } from "./types";

const TYPE_LABEL: Record<Card["type"], string> = {
  imagery: "IMAGERY",
  index: "INDEX",
  fires: "FIRES",
  events: "EVENTS",
  compare: "COMPARE",
  search: "SEARCH",
};

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

  if (card.bbox) {
    const bb = document.createElement("div");
    bb.className = "card-bbox";
    bb.textContent = card.bbox.map((n) => n.toFixed(2)).join(", ");
    el.appendChild(bb);
  }

  el.addEventListener("click", () => onFocus(card));
  return el;
}
