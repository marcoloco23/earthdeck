// The public site's page script. Pages arrive fully server-rendered by `earthdeck watch export`;
// this adds what needs a browser: copy buttons, relative times, the "include unpublished" switch,
// and — on the landing — the map + panel (panel.ts now, MapLibre in a lazy chunk). Case pages send
// readers with JavaScript into the same case on the landing's map (one experience); crawlers and
// no-JS readers keep the full server-rendered page.

import "../styles.css";
import "./site.css";
import "./landing.css";
import { ago } from "../ui";
import { createHub } from "./hub";
import { mountPanel } from "./panel";
import { mountReplyForms } from "./reply";
import { verifyCase, wireCopy } from "./verify";

const page = document.body.dataset.page ?? "";
const DEPTH: Record<string, number> = { landing: 0, trust: 0, watch: 1, developers: 1, case: 3 };
const prefix = "../".repeat(DEPTH[page] ?? 0);
const siteRoot = new URL(prefix || ".", location.href).href.replace(/\/+$/, "");

// ---- everywhere -------------------------------------------------------------------------------

wireCopy(document);

for (const t of document.querySelectorAll<HTMLTimeElement>("time.ago")) {
  t.title = t.dateTime;
  t.textContent = ago(t.dateTime);
}

// Exported without --base-url: point the commands at wherever this copy is served from.
for (const code of document.querySelectorAll<HTMLElement>("[data-base-cmd]")) {
  const text = (code.textContent ?? "").split("https://<this-site>").join(siteRoot);
  code.textContent = text;
  const btn = code.parentElement?.querySelector<HTMLButtonElement>("button[data-copy]");
  if (btn) btn.dataset.copy = text;
}

// ---- case page: into the map, or check the proof here -------------------------------------------

if (page === "case") {
  const id = document.querySelector<HTMLElement>("article.case[data-case]")?.dataset.case;
  const bot = /bot|crawl|spider|slurp|preview|lighthouse|headless/i.test(navigator.userAgent);
  if (id && /^[A-Za-z0-9-]{1,64}$/.test(id) && !bot) location.replace(`${prefix}#case=${id}`);
  else {
    const box = document.querySelector<HTMLElement>(".verify");
    if (box) void verifyCase(box, prefix);
    mountReplyForms(document);
  }
}

// ---- landing: the map is the product -------------------------------------------------------------
//
// The panel works at once (list, filters, modes, planet, metrics) from api/map.json. MapLibre (a
// separate chunk) starts loading right away too — unless the connection asks to save data, in which
// case it waits for the reader to reach for the map. If it fails, the static night image stays.

if (page === "landing") {
  const hub = createHub(prefix);
  mountPanel(hub);
  const figure = document.querySelector<HTMLElement>("figure.world[data-map]");
  if (figure) {
    let started = false;
    const start = () => {
      if (started) return;
      started = true;
      void Promise.all([import("./map/explore"), hub.data])
        .then(([mod, data]) => {
          if (data) mod.mountExplorer({ figure, data, hub });
        })
        .catch((e: unknown) => console.warn("map unavailable — the static map stays:", e));
    };
    const conn = (navigator as Navigator & { connection?: { saveData?: boolean; effectiveType?: string } }).connection;
    if (!conn?.saveData && !/(^|-)2g$/.test(conn?.effectiveType ?? "")) start();
    else {
      const hero = document.getElementById("hero") ?? figure;
      for (const ev of ["pointerdown", "touchstart", "focusin"] as const) hero.addEventListener(ev, start, { once: true, passive: true });
      if (location.hash) start();
    }
  }
}

// ---- cases index: the transparency switch ----------------------------------------------------------

if (page === "watch") {
  const toggle = document.querySelector<HTMLButtonElement>(".vis-toggle");
  const list = document.getElementById("case-list");
  const empty = document.querySelector<HTMLElement>(".only-public");
  if (toggle && list) {
    const set = (all: boolean) => {
      list.classList.toggle("list--public", !all);
      toggle.classList.toggle("is-on", all);
      toggle.setAttribute("aria-checked", String(all));
      if (empty) empty.hidden = all;
      const url = new URL(location.href);
      if (all) url.searchParams.set("all", "1");
      else url.searchParams.delete("all");
      history.replaceState(null, "", url);
    };
    toggle.hidden = false;
    toggle.addEventListener("click", () => set(toggle.getAttribute("aria-checked") !== "true"));
    if (new URLSearchParams(location.search).get("all") === "1") set(true);
  }
}
